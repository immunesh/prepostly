import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { localFile } from '../engines/images.js';
import { runFfmpeg } from '../engines/video.js';

/** A publishing failure. `retryable` failures are retried with backoff; `relink` ones need the user to reconnect. */
export class PublishError extends Error {
  constructor(message, { retryable = false, relink = false, status } = {}) {
    super(message);
    this.retryable = retryable;
    this.relink = relink;
    this.status = status;
  }
}

/** Pull a human message out of the many platform error shapes. */
function platformMessage(body) {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 300) : '';
  return body.error?.message || body.error?.error_user_msg || body.error_description || body.message || body.detail || body.title
    || body.errors?.[0]?.message || body.errors?.[0]?.detail || (typeof body.error === 'string' ? body.error : '') || body.description || '';
}

/**
 * fetch wrapper for platform APIs. Returns { status, headers, body } and throws PublishError
 * on non-2xx with the platform's own message.
 */
export async function api(platform, url, { method = 'GET', headers = {}, json, form, body, timeoutMs = 60000, raw = false } = {}) {
  const h = { ...headers };
  let payload = body;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (form !== undefined) {
    if (form instanceof FormData) payload = form;
    else {
      h['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    }
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new PublishError(`${platform}: network error (${e.cause?.code || e.message})`, { retryable: true });
  }
  const text = raw ? '' : await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = platformMessage(parsed) || `HTTP ${res.status}`;
    throw new PublishError(`${platform}: ${msg}`, { retryable: res.status === 429 || res.status >= 500, relink: res.status === 401, status: res.status });
  }
  return { status: res.status, headers: res.headers, body: parsed, res };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Absolute public URL for an app path. Platforms that pull media (Instagram, Threads…) need this. */
export function publicUrl(appPath) {
  if (!appPath) return null;
  if (/^https?:\/\//.test(appPath)) return appPath;
  if (!config.publicUrl) return null;
  return `${config.publicUrl}${appPath}`;
}

export function requirePublicUrl(platform) {
  if (!config.publicUrl || /localhost|127\.0\.0\.1/.test(config.publicUrl)) {
    // A server setup problem: say so in the log, and tell the user the channel isn't offered yet.
    console.warn(`[publish] ${platform} downloads media by URL, so PUBLIC_URL must be set to an internet-reachable https address.`);
    throw new PublishError(`Publishing to ${platform} isn't available yet. Choose another channel for now.`);
  }
}

/**
 * Media to publish for a post: [{ kind: 'image'|'video', path: appPath, file: absPath, mime, size }].
 * Video posts publish the MP4 (plus its cover frame); image posts publish every slide.
 */
export function postMedia(post) {
  const media = post.media || [];
  const video = media.find((m) => m.kind === 'video');
  const list = video ? [video] : media.filter((m) => m.kind === 'image');
  return list.map((m) => {
    const file = localFile(m.url);
    const size = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
    return { kind: m.kind, path: m.url, file, size, mime: m.kind === 'video' ? 'video/mp4' : 'image/png', w: m.w, h: m.h, duration: m.duration };
  });
}

/** JPEG copy of an image (smaller uploads; some APIs cap image size). */
export async function asJpeg(file, quality = 3) {
  const out = path.join(config.dataDir, 'tmp', `${crypto.createHash('sha1').update(file + quality).digest('hex')}.jpg`);
  if (!fs.existsSync(out)) await runFfmpeg(['-i', file, '-q:v', String(quality), out]);
  return out;
}

/** Public URL of a JPEG copy saved next to the image, for platforms that only fetch JPEGs (Instagram). */
export async function publicJpeg(m) {
  if (/\.jpe?g$/i.test(m.path)) return publicUrl(m.path);
  const out = m.file.replace(/\.[^./]+$/, '.jpg');
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(m.file).mtimeMs) await runFfmpeg(['-i', m.file, '-q:v', '2', out]);
  return publicUrl(m.path.replace(/\.[^./]+$/, '.jpg'));
}

export function fileBlob(file, mime) {
  return new Blob([fs.readFileSync(file)], { type: mime });
}

/** Caption + hashtags, trimmed to a platform's limit without cutting words. */
export function composeText(caption, hashtags, limit) {
  const tags = String(hashtags || '').trim();
  let text = [String(caption || '').trim(), tags].filter(Boolean).join('\n\n');
  if (!limit || [...text].length <= limit) return text;
  // Drop hashtags one by one, then truncate the caption.
  const tagList = tags.split(/\s+/).filter(Boolean);
  while (tagList.length) {
    tagList.pop();
    text = [String(caption || '').trim(), tagList.join(' ')].filter(Boolean).join('\n\n');
    if ([...text].length <= limit) return text;
  }
  const chars = [...String(caption || '').trim()];
  return chars.slice(0, limit - 1).join('').replace(/\s+\S*$/, '') + '…';
}
