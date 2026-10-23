import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { one, all, run, insert, update, uuid, json, now } from './db.js';
import { HttpError } from './auth.js';
import { POST_TYPES, FORMATS, TEMPLATES, CREDIT_COSTS, LANGUAGES } from './catalog.js';
import { charge, refund, payerFor, planStatus } from './credits.js';
import { writePost, boostPrompt } from './engines/content.js';
import { renderSlide, watermarkPng, paletteFor } from './engines/render.js';
import { toDataUri, searchStock, stockAvailable, aiImagesAvailable, generateAiImage, orientationOf } from './engines/images.js';
import { extractArticle } from './engines/scraper.js';
import { composeVideo, fitVideo, probeDuration, extractFrame, sceneStarts, XFADE } from './engines/video.js';
import { avatarAvailable, renderAvatarVideo } from './engines/avatar.js';
import { synthesize, writeWav, SAMPLE_RATE } from './engines/tts.js';
import { notify } from './notify.js';

// ---------------------------------------------------------------- job queue
const MAX_CONCURRENT = Number(process.env.GENERATION_CONCURRENCY || 2);
let active = 0;
const waiting = [];
let detached = 0;
const listeners = new Set();
export const onPostUpdate = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (post) => listeners.forEach((fn) => { try { fn(post); } catch { /* listener errors are not ours */ } });

function enqueue(task) {
  return new Promise((resolve) => {
    waiting.push(async () => {
      try { resolve(await task()); } finally {
        active--;
        pump();
      }
    });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && waiting.length) {
    active++;
    waiting.shift()();
  }
}
/** Resolves when no generation is running or waiting (tests, shutdown). */
export async function idle() {
  while (active || waiting.length || detached) await new Promise((r) => setTimeout(r, 50));
}

// ---------------------------------------------------------------- costs
export function costFor(input) {
  const meta = POST_TYPES[input.type];
  let cost;
  if (input.type === 'avatar_video') cost = CREDIT_COSTS.avatar_video;
  else if (input.type === 'voiceover_video') cost = CREDIT_COSTS.voiceover_video;
  else if (meta.media === 'video') cost = CREDIT_COSTS.video;
  else if (meta.media === 'carousel') cost = CREDIT_COSTS.image + CREDIT_COSTS.carousel_slide * Math.max(0, (input.slides || meta.slides) - 1);
  else cost = CREDIT_COSTS.image;
  if (input.media_source === 'ai' && input.type !== 'avatar_video') cost += CREDIT_COSTS.ai_image;
  return cost;
}

// ---------------------------------------------------------------- create
/** Validate a generation request, charge credits, insert the post and queue it. */
export function createPost({ brand, user, input }) {
  const type = input.type || 'single_image';
  const meta = POST_TYPES[type];
  if (!meta) throw new HttpError(400, `Unknown post type "${type}".`);
  if (meta.requires === 'heygen' && !avatarAvailable()) throw new HttpError(400, "UGC avatar videos aren't available yet.");
  const format = input.format || (meta.media === 'video' ? 'story' : 'ig_portrait');
  if (!FORMATS[format]) throw new HttpError(400, `Unknown format "${format}".`);
  const template = input.template && input.template !== 'auto' ? input.template : 'auto';
  if (template !== 'auto' && !TEMPLATES[template]) throw new HttpError(400, `Unknown template "${template}".`);
  const language = input.language || brand.language || 'English';
  if (!LANGUAGES.includes(language)) throw new HttpError(400, `Unsupported language "${language}".`);
  const prompt = String(input.prompt || '').trim().slice(0, 4000);
  const needsPrompt = !['ecom_product', 'ecom_carousel', 'ecom_video', 'ad_creative', 'special_day', 'blog_to_carousel'].includes(type);
  if (needsPrompt && prompt.length < 3) throw new HttpError(400, 'Describe what the post should be about.');
  if (['ecom_product', 'ecom_carousel', 'ecom_video', 'ad_creative'].includes(type) && !input.product_id && !input.product && prompt.length < 3) throw new HttpError(400, 'Pick a product or describe what to promote.');
  if (type === 'blog_to_carousel' && !input.article_url && prompt.length < 200) throw new HttpError(400, 'Paste an article URL or at least a few paragraphs of text.');
  if (input.media_source === 'ai' && type !== 'avatar_video' && !aiImagesAvailable()) throw new HttpError(400, "AI images aren't available yet. Choose another image source.");
  if (input.product_id && !one('SELECT id FROM products WHERE id = ? AND brand_id = ?', input.product_id, brand.id)) throw new HttpError(404, 'Product not found.');
  const slides = Math.max(1, Math.min(10, Number(input.slides) || meta.slides));
  const clean = { ...input, type, format, language, slides, prompt, template };
  const cost = costFor(clean);
  const id = uuid();
  charge(brand, cost, `generate:${type}`, id);
  insert('posts', {
    id, brand_id: brand.id, created_by: user?.id || null, type, media_type: meta.media, format, status: 'generating',
    title: prompt.slice(0, 80) || meta.label, prompt, input: clean, template: template === 'auto' ? 'bold' : template, language,
    credits_used: cost, autopilot_id: input.autopilot_id || null,
  });
  queueGeneration(id);
  return getPost(id);
}

export function queueGeneration(id) {
  // Avatar videos spend minutes waiting on HeyGen, so they don't hold one of the render slots.
  if (one('SELECT type FROM posts WHERE id = ?', id)?.type === 'avatar_video') {
    detached++;
    return generate(id).finally(() => { detached--; });
  }
  return enqueue(() => generate(id));
}

/** Re-queue posts left mid-generation by a restart. */
export function resumePending() {
  for (const p of all("SELECT id FROM posts WHERE status = 'generating'")) queueGeneration(p.id);
}

export function getPost(id) {
  const p = one('SELECT * FROM posts WHERE id = ?', id);
  return p ? hydrate(p) : null;
}
export function hydrate(p) {
  return { ...p, input: json(p.input, {}), content: json(p.content, {}), media: json(p.media, []), archived: Boolean(p.archived) };
}

// ---------------------------------------------------------------- pipeline
async function generate(id) {
  const post = getPost(id);
  if (!post || post.status !== 'generating') return;
  const brand = one('SELECT * FROM brands WHERE id = ?', post.brand_id);
  const input = post.input;
  try {
    let prompt = input.prompt;
    if (input.boost && prompt) prompt = await boostPrompt(brand, prompt, post.type);
    const product = input.product_id ? productRow(input.product_id) : input.product || null;
    const article = input.article_url ? await extractArticle(input.article_url) : post.type === 'blog_to_carousel' ? { title: '', text: prompt, sections: [] } : null;
    const tpl = input.template_id ? one('SELECT * FROM templates WHERE id = ? AND brand_id = ?', input.template_id, brand.id) : null;

    const content = await writePost({ brand, type: post.type, prompt, language: post.language, tone: input.tone, slides: input.slides, product, article, specialDay: input.special_day, concept: input.concept });
    if (tpl) mergeTemplate(content, json(tpl.content, {}));
    if (post.type !== 'avatar_video') await attachImages({ brand, post, input, content, product });

    let template = post.template;
    if ((input.template || 'auto') === 'auto') template = tpl?.template || (content.slides.some((s) => s.image) && !['product', 'ad', 'meme', 'quote'].includes(content.slides[0]?.kind) ? 'photo' : 'bold');
    const rendered = await renderPost({ brand, post: { ...post, template }, content, version: 1 });
    update('posts', id, {
      status: 'ready', title: (content.title || post.title).slice(0, 120), content, caption: content.caption || '', hashtags: (content.hashtags || []).join(' '),
      media: rendered.media, cover: rendered.cover, template, writer: content.writer || '', error: null, updated_at: now(),
    });
    if (post.created_by) notify(post.created_by, brand.id, 'post_ready', 'Your post is ready', content.title || post.title, `/app/posts/${id}`);
  } catch (e) {
    console.error(`[generate] ${id} failed:`, e.message);
    update('posts', id, { status: 'failed', error: e.message.slice(0, 500), updated_at: now() });
    refund(brand, post.credits_used, 'generation_failed', id);
    run('UPDATE posts SET credits_used = 0 WHERE id = ?', id);
  }
  emit(getPost(id));
}

function productRow(pid) {
  const p = one('SELECT * FROM products WHERE id = ?', pid);
  return p ? { ...p, images: json(p.images, []) } : null;
}

function mergeTemplate(content, tplContent) {
  // A saved template carries slide structure (kinds, kickers, CTAs); keep new copy, reuse its frame.
  (tplContent.slides || []).forEach((s, i) => {
    if (!content.slides[i]) return;
    if (s.kind) content.slides[i].kind = s.kind;
    if (s.kicker && !content.slides[i].kicker) content.slides[i].kicker = s.kicker;
    if (s.cta && !content.slides[i].cta) content.slides[i].cta = s.cta;
  });
}

/** Pick an image for each slide: uploads, product photos, AI, or stock search. */
async function attachImages({ brand, post, input, content, product }) {
  const uploaded = (input.image_urls || []).filter(Boolean);
  const productImages = product?.images || [];
  const source = input.media_source || 'auto';
  const slides = content.slides;
  if (source === 'none') return;
  const pool = uploaded.length ? uploaded : productImages;
  if (pool.length) {
    slides.forEach((s, i) => {
      if (!s.image && (uploaded.length || ['product', 'ad'].includes(s.kind) || post.media_type === 'video')) s.image = pool[i % pool.length];
    });
    if (uploaded.length || post.type.startsWith('ecom')) return;
  }
  if (source === 'ai') {
    const f = FORMATS[post.format];
    const size = f.h > f.w ? '1024x1536' : f.w > f.h ? '1536x1024' : '1024x1024';
    const q = slides[0]?.image_query || post.prompt;
    slides[0].image = await generateAiImage(`${q}. High-quality social media photo for ${brand.name}${brand.industry ? `, a ${brand.industry} brand` : ''}. No text in the image.`, { size, dir: post.id });
    return;
  }
  if ((source === 'stock' || source === 'auto') && stockAvailable()) {
    const wants = source === 'stock' || post.media_type === 'video' || ['meme', 'quote'].includes(post.type) || ['photo', 'split'].includes(post.template);
    if (!wants) return;
    // Search for every slide at once (Openverse can be slow), then pick in order so images don't repeat.
    const searches = slides.map((s) => (s.image ? [] : searchStock(s.image_query || post.prompt, { orientation: orientationOf(post.format) }).catch(() => [])));
    const found = await Promise.all(searches);
    const used = new Set();
    for (const [i, s] of slides.entries()) {
      if (s.image) continue;
      const results = found[i];
      const r = results.find((x) => !used.has(x.url)) || results[0];
      if (r) {
        s.image = r.url;
        s.image_credit = r.credit;
        used.add(r.url);
      }
    }
  }
}

/** Render slides (and the video, for video posts). Returns { media, cover }. */
export async function renderPost({ brand, post, content, version }) {
  const dir = path.join(config.dataDir, 'media', post.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^v\d+-/.test(f) && !f.startsWith(`v${version}-`)) fs.rmSync(path.join(dir, f), { force: true });
  const payer = payerFor(brand);
  const watermark = Boolean(planStatus(payer).watermark);
  const logoRef = brand.logo_light || brand.logo_dark;
  const logo = logoRef ? await toDataUri(logoRef).catch(() => null) : null;
  const fmt = FORMATS[post.format];
  const isVideo = post.media_type === 'video';
  const slides = content.slides || [];
  if (post.type === 'avatar_video') return renderAvatarPost({ brand, post, content, dir, fmt, watermark, version });
  const narrate = isVideo && (post.type === 'voiceover_video' || post.type === 'text_to_video' || content.voiceover === true);

  const media = [];
  const frames = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const image = slide.image ? await toDataUri(slide.image).catch(() => null) : null;
    const withCaption = isVideo && slide.narration && narrate ? { ...slide, caption: slide.narration } : slide;
    const { png } = await renderSlide({ brand, slide: withCaption, index: i, total: isVideo ? 1 : slides.length, format: post.format, template: post.template, assets: { image, logo }, watermark, seed: post.id });
    const file = `v${version}-${i + 1}.png`;
    fs.writeFileSync(path.join(dir, file), png);
    const url = `/media/${post.id}/${file}`;
    if (isVideo) frames.push({ image: path.join(dir, file), url });
    else media.push({ kind: 'image', url, w: fmt.w, h: fmt.h });
  }
  if (!isVideo) return { media, cover: media[0]?.url || null };

  // Narration: one clip per scene; scenes last as long as their line (min 2.5s).
  const clips = [];
  if (narrate) {
    for (const s of slides) {
      try {
        clips.push(s.narration ? await synthesize(s.narration, brand.voice) : null);
      } catch (e) {
        console.warn('[voiceover] unavailable:', e.message);
        clips.length = 0;
        break;
      }
    }
  }
  const durations = slides.map((s, i) => {
    const spoken = clips[i] ? clips[i].length / SAMPLE_RATE + 0.5 : 0;
    const reading = Math.min(4.5, 1.8 + (String(s.headline).length + String(s.body || '').length) / 40);
    return Math.max(2.5, spoken, clips.length ? 0 : reading) + XFADE;
  });
  let audio = null;
  if (clips.length) {
    const { starts, total } = sceneStarts(durations);
    const track = new Float32Array(Math.ceil(total * SAMPLE_RATE));
    clips.forEach((c, i) => c && track.set(c.subarray(0, Math.max(0, track.length - Math.round((starts[i] + 0.15) * SAMPLE_RATE))), Math.round((starts[i] + 0.15) * SAMPLE_RATE)));
    audio = path.join(dir, `v${version}-voice.wav`);
    writeWav(audio, track);
  }
  const outFile = `v${version}-video.mp4`;
  const { duration } = await composeVideo({ scenes: frames.map((f, i) => ({ image: f.image, duration: durations[i] })), w: fmt.w, h: fmt.h, out: path.join(dir, outFile), audio });
  if (audio) fs.rmSync(audio, { force: true });
  return {
    media: [{ kind: 'video', url: `/media/${post.id}/${outFile}`, w: fmt.w, h: fmt.h, duration: Number(duration.toFixed(2)), narrated: Boolean(clips.length) }, ...frames.map((f) => ({ kind: 'frame', url: f.url, w: fmt.w, h: fmt.h }))],
    cover: frames[0]?.url || null,
  };
}

/**
 * HeyGen renders the presenter once (kept as avatar-src.mp4); every version then fits that
 * clip to the post's size and adds the trial watermark, so edits never pay HeyGen again.
 */
async function renderAvatarPost({ brand, post, content, dir, fmt, watermark, version }) {
  const src = path.join(dir, 'avatar-src.mp4');
  const thumb = path.join(dir, 'avatar-thumb.jpg');
  if (!fs.existsSync(src)) {
    const script = (content.slides || []).map((s) => s.narration || [s.headline, s.body].filter(Boolean).join('. ')).join(' ');
    await renderAvatarVideo({ dir, script, w: fmt.w, h: fmt.h, background: paletteFor(brand).primary, language: post.language || 'English' });
  }
  const overlay = watermark ? path.join(dir, `v${version}-watermark.png`) : null;
  if (overlay) fs.writeFileSync(overlay, await watermarkPng(fmt.w, fmt.h));
  const outFile = `v${version}-video.mp4`;
  await fitVideo({ src, out: path.join(dir, outFile), w: fmt.w, h: fmt.h, overlay });
  if (overlay) fs.rmSync(overlay, { force: true });
  if (!fs.existsSync(thumb)) await extractFrame(path.join(dir, outFile), thumb, 1).catch(() => {});
  const duration = (await probeDuration(path.join(dir, outFile))) || 0;
  const cover = fs.existsSync(thumb) ? `/media/${post.id}/avatar-thumb.jpg` : null;
  return {
    media: [{ kind: 'video', url: `/media/${post.id}/${outFile}`, w: fmt.w, h: fmt.h, duration: Number(duration.toFixed(2)), narrated: true }, ...(cover ? [{ kind: 'frame', url: cover, w: fmt.w, h: fmt.h }] : [])],
    cover,
  };
}

/** Re-render a post after edits (content, template or brand changes). */
export async function rerender(postId, patch = {}) {
  const post = getPost(postId);
  if (!post) throw new HttpError(404, 'Post not found.');
  if (post.status === 'generating') throw new HttpError(409, 'This post is still generating.');
  const brand = one('SELECT * FROM brands WHERE id = ?', post.brand_id);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged = { ...post, ...defined, content: defined.content || post.content };
  if (merged.template && !TEMPLATES[merged.template]) throw new HttpError(400, `Unknown template "${merged.template}".`);
  const version = post.version + 1;
  const rendered = await enqueue(() => renderPost({ brand, post: merged, content: merged.content, version }));
  update('posts', postId, { content: merged.content, template: merged.template, media: rendered.media, cover: rendered.cover, version, status: 'ready', updated_at: now() });
  return getPost(postId);
}

/** Resize a post into another format as a linked variant ("Resize with AI"). */
export function resizePost({ brand, user, post, format }) {
  if (!FORMATS[format]) throw new HttpError(400, `Unknown format "${format}".`);
  if (post.format === format) throw new HttpError(400, 'The post is already in that size.');
  if (post.type === 'avatar_video') throw new HttpError(400, 'Avatar videos can’t be resized. Create a new avatar video in the size you need.');
  if (post.status !== 'ready') throw new HttpError(409, 'Only finished posts can be resized.');
  const id = uuid();
  charge(brand, CREDIT_COSTS.resize, 'resize', id);
  insert('posts', {
    id, brand_id: brand.id, created_by: user?.id || null, type: post.type, media_type: post.media_type, format, status: 'ready',
    title: post.title, prompt: post.prompt, input: { ...post.input, format }, content: post.content, caption: post.caption, hashtags: post.hashtags,
    template: post.template, language: post.language, parent_id: post.parent_id || post.id, credits_used: CREDIT_COSTS.resize, writer: post.writer,
  });
  return enqueue(async () => {
    try {
      const rendered = await renderPost({ brand, post: { ...post, id, format }, content: post.content, version: 1 });
      update('posts', id, { media: rendered.media, cover: rendered.cover, updated_at: now() });
    } catch (e) {
      update('posts', id, { status: 'failed', error: e.message });
      refund(brand, CREDIT_COSTS.resize, 'resize_failed', id);
    }
    return getPost(id);
  });
}

/** Retry a failed generation (credits are charged again, as they were refunded). */
export function retryPost({ brand, post }) {
  if (post.status !== 'failed') throw new HttpError(409, 'Only failed posts can be retried.');
  const cost = costFor(post.input);
  charge(brand, cost, `generate:${post.type}`, post.id);
  update('posts', post.id, { status: 'generating', error: null, credits_used: cost, updated_at: now() });
  queueGeneration(post.id);
  return getPost(post.id);
}
