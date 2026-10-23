import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { config } from '../config.js';
import { safeFetch } from '../net.js';

const exec = promisify(execFile);
const CACHE = path.join(config.dataDir, 'tmp', 'imgcache');
fs.mkdirSync(CACHE, { recursive: true });

/** Map an app URL (/media/…, /uploads/…) to its file on disk, or null. */
export function localFile(ref) {
  const m = String(ref || '').match(/^\/(media|uploads|outbox)\/([A-Za-z0-9._/-]+)$/);
  if (!m || m[2].includes('..')) return null;
  return path.join(config.dataDir, m[1], m[2]);
}

export function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 12).startsWith('ftyp')) return /avif|avis/.test(buf.toString('latin1', 8, 12)) ? 'image/avif' : 'video/mp4';
  const head = buf.toString('utf8', 0, 300).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Re-encode formats resvg can't decode (WebP, AVIF) to PNG with ffmpeg. */
async function toPng(buf) {
  const key = crypto.createHash('sha1').update(buf).digest('hex');
  const out = path.join(CACHE, `${key}.png`);
  if (fs.existsSync(out)) return fs.readFileSync(out);
  const src = path.join(CACHE, `${key}.src`);
  fs.writeFileSync(src, buf);
  try {
    await exec(ffmpegPath, ['-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', out]);
  } finally {
    fs.rmSync(src, { force: true });
  }
  return fs.readFileSync(out);
}

/** Load an image (app path, http(s) URL or data URI) as a data URI resvg can render. */
export async function toDataUri(ref) {
  if (!ref) return null;
  if (String(ref).startsWith('data:')) return ref;
  let buf;
  const file = localFile(ref);
  if (file) {
    if (!fs.existsSync(file)) return null;
    buf = fs.readFileSync(file);
  } else if (/^https?:\/\//.test(ref)) {
    const key = crypto.createHash('sha1').update(ref).digest('hex');
    const cached = path.join(CACHE, `${key}.bin`);
    if (fs.existsSync(cached)) buf = fs.readFileSync(cached);
    else {
      // Flickr (most Openverse photos) answers 403 to the scraper's "compatible; …Bot" user agent.
      const r = await safeFetch(ref, { accept: 'image/*', maxBytes: 15 * 1024 * 1024, headers: { 'user-agent': 'Prepostly/1.0' } });
      if (r.status >= 400) return null;
      buf = r.buffer;
      fs.writeFileSync(cached, buf);
    }
  } else return null;
  let mime = sniffMime(buf);
  if (mime === 'image/webp' || mime === 'image/avif') {
    buf = await toPng(buf);
    mime = 'image/png';
  }
  if (!mime.startsWith('image/')) return null;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Search results are cached for an hour: Openverse can take half a minute per query,
// and Pixabay asks API users to cache requests.
const stockCache = new Map();
const STOCK_TTL = 60 * 60 * 1000;

/** Search a stock photo provider. Returns [{ url, credit, link }]. */
export async function searchStock(query, { orientation = 'portrait', count = 6 } = {}) {
  if (!query) return [];
  const key = JSON.stringify([query, orientation, count]);
  const hit = stockCache.get(key);
  if (hit && Date.now() - hit.at < STOCK_TTL) return hit.results;
  // The pending search is cached too, so slides searching for the same thing share one request.
  const pending = searchProviders(query, { orientation, count });
  stockCache.set(key, { at: Date.now(), results: pending });
  if (stockCache.size > 500) stockCache.delete(stockCache.keys().next().value);
  const results = await pending.catch((e) => {
    stockCache.delete(key);
    throw e;
  });
  if (!results.length) stockCache.delete(key);
  return results;
}

const FILLER = new Set('a an and are as at be by for from how in into is it its my of on or our so the their this that these those to was what when which who why with you your tips ways ideas reasons things guide best top post carousel video create make one two three four five six seven eight nine ten'.split(' '));
/** Up to four meaningful words of a query, for search engines that need every word to match. */
export const searchKeywords = (q) => [...new Set(String(q).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/))].filter((w) => w.length > 1 && !FILLER.has(w) && !/^\d+$/.test(w)).slice(0, 4);

const CC_NAMES = { cc0: 'CC0', pdm: 'Public Domain' };
const ccLabel = (license, version) => CC_NAMES[license] || `CC ${String(license).toUpperCase()}${version ? ` ${version}` : ''}`;

async function searchProviders(query, { orientation, count }) {
  if (config.pexelsKey) {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=${orientation}`, { headers: { authorization: config.pexelsKey }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json();
      return (j.photos || []).map((p) => ({ url: p.src.large2x || p.src.large, thumb: p.src.medium, credit: `Photo by ${p.photographer} on Pexels`, link: p.url }));
    }
  }
  if (config.unsplashKey) {
    const o = orientation === 'square' ? 'squarish' : orientation;
    const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=${o}`, { headers: { authorization: `Client-ID ${config.unsplashKey}` }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json();
      return (j.results || []).map((p) => ({ url: `${p.urls.raw}&w=1600&q=80&fm=jpg`, thumb: p.urls.small, credit: `Photo by ${p.user.name} on Unsplash`, link: p.links.html }));
    }
  }
  if (config.pixabayKey) {
    // Pixabay doesn't allow hotlinking; toDataUri downloads every image before it's used.
    const o = { portrait: 'vertical', landscape: 'horizontal' }[orientation] || 'all';
    const r = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(config.pixabayKey)}&q=${encodeURIComponent(query.slice(0, 100))}&image_type=photo&orientation=${o}&safesearch=true&per_page=${Math.max(3, count)}`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json();
      return (j.hits || []).slice(0, count).map((p) => ({ url: p.largeImageURL || p.webformatURL, thumb: p.webformatURL || p.previewURL, credit: `Image by ${p.user} from Pixabay`, link: p.pageURL }));
    }
  }
  if (config.openverse) {
    // Openverse (no key): only photos licensed for commercial use and modification.
    // Every word has to match, so search the keywords, then without the first word (often an
    // adjective like "cozy"), then without the last. One word alone ("art") is too broad to try.
    const words = searchKeywords(query);
    const tries = !words.length ? [query.slice(0, 200)] : words.length < 3 ? [words.join(' ')] : [words, words.slice(1), words.slice(0, -1)].map((w) => w.join(' '));
    for (const q of tries) {
      const results = await searchOpenverse(q, { orientation, count });
      if (results.length) return results;
    }
  }
  return [];
}

async function searchOpenverse(query, { orientation, count }) {
  // It's slow and sometimes answers 500 or times out, so a failed search is tried once more.
  const ratio = { portrait: 'tall', landscape: 'wide' }[orientation] || 'square';
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${count}&license_type=commercial,modification&category=photograph&aspect_ratio=${ratio}&mature=false`;
  let r = null;
  for (let attempt = 0; attempt < 2 && !r?.ok; attempt++) {
    r = await fetch(url, { headers: { 'user-agent': 'Prepostly/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(45000) }).catch(() => null);
  }
  if (!r?.ok) return [];
  const j = await r.json();
  return (j.results || []).filter((p) => p.url).map((p) => ({
    url: p.url,
    thumb: p.thumbnail || p.url,
    credit: `${p.title ? `"${p.title}" by` : 'Photo by'} ${p.creator || 'unknown'} (${ccLabel(p.license, p.license_version)}) via Openverse`,
    link: p.foreign_landing_url || p.url,
  }));
}

export const stockAvailable = () => Boolean(config.pexelsKey || config.unsplashKey || config.pixabayKey || config.openverse);
export const aiImagesAvailable = () => Boolean(config.openaiKey);

/** Generate an image with OpenAI Images. Returns an app path under /media. */
export async function generateAiImage(prompt, { size = '1024x1536', dir = 'ai' } = {}) {
  if (!config.openaiKey) throw new Error('AI image generation needs OPENAI_API_KEY.');
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.openaiImageModel, prompt, size, n: 1 }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Image generation failed (${r.status}).`);
  const b64 = j.data?.[0]?.b64_json;
  let buf;
  if (b64) buf = Buffer.from(b64, 'base64');
  else if (j.data?.[0]?.url) buf = (await safeFetch(j.data[0].url, { accept: 'image/*', maxBytes: 20 * 1024 * 1024 })).buffer;
  else throw new Error('Image generation returned no image.');
  const name = `${crypto.randomUUID()}.png`;
  fs.mkdirSync(path.join(config.dataDir, 'media', dir), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'media', dir, name), buf);
  return `/media/${dir}/${name}`;
}

export const orientationOf = (format) => (['story', 'pin', 'ig_portrait'].includes(format) ? 'portrait' : format === 'square' ? 'square' : 'landscape');
