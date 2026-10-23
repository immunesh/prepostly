import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { one, all, run, uuid, now, insert, update, shortId, json } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { POST_TYPES } from '../catalog.js';
import { createPost, getPost, hydrate, rerender, resizePost, retryPost, costFor, idle } from '../generate.js';
import { boostPrompt, rewriteCaption, makeHashtags } from '../engines/content.js';
import { searchStock, stockAvailable, sniffMime } from '../engines/images.js';

export const router = Router();

router.use(requireUser);

// ---------------------------------------------------------------- uploads
const KINDS = { 'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image', 'image/svg+xml': 'image', 'video/mp4': 'video', 'audio/mpeg': 'audio', 'audio/wav': 'audio' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

router.post('/uploads', express.raw({ type: () => true, limit: config.maxUploadBytes }), (req, res) => {
  const brand = brandFor(req, 'editor');
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'Send the file as the request body.');
  let mime = sniffMime(buf);
  if (mime === 'application/octet-stream') {
    const declared = String(req.get('content-type') || '').split(';')[0];
    if (declared === 'audio/mpeg' && (buf[0] === 0xff || buf.toString('latin1', 0, 3) === 'ID3')) mime = 'audio/mpeg';
    if (declared === 'audio/wav' && buf.toString('latin1', 0, 4) === 'RIFF') mime = 'audio/wav';
  }
  if (!KINDS[mime]) throw new HttpError(400, 'Unsupported file type. Upload PNG, JPG, GIF, WebP, SVG, MP4, MP3 or WAV.');
  const name = String(req.get('x-filename') || `upload.${EXT[mime]}`).replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'upload';
  const file = `${brand.id}/${crypto.randomUUID()}.${EXT[mime]}`;
  fs.mkdirSync(path.join(config.dataDir, 'uploads', brand.id), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'uploads', file), buf);
  const row = insert('uploads', { id: uuid(), brand_id: brand.id, user_id: req.user.id, kind: KINDS[mime], name, file: `/uploads/${file}`, mime, size: buf.length });
  res.status(201).json(row);
});

router.get('/uploads', (req, res) => {
  const brand = brandFor(req);
  const kind = req.query.kind;
  const q = req.query.q ? `%${req.query.q}%` : null;
  res.json(all(`SELECT * FROM uploads WHERE brand_id = ? ${kind ? 'AND kind = ?' : ''} ${q ? 'AND name LIKE ?' : ''} ORDER BY created_at DESC LIMIT 200`, brand.id, ...(kind ? [kind] : []), ...(q ? [q] : [])));
});

router.delete('/uploads/:id', (req, res) => {
  const brand = brandFor(req, 'editor');
  const u = one('SELECT * FROM uploads WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!u) throw new HttpError(404, 'Upload not found.');
  fs.rmSync(path.join(config.dataDir, u.file.replace(/^\//, '')), { force: true });
  run('DELETE FROM uploads WHERE id = ?', u.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- stock & helpers
router.get('/stock', async (req, res) => {
  brandFor(req);
  if (!stockAvailable()) return res.json({ available: false, results: [] });
  res.json({ available: true, results: await searchStock(String(req.query.q || ''), { orientation: req.query.orientation || 'portrait', count: 12 }) });
});

router.post('/posts/boost-prompt', async (req, res) => {
  const brand = brandFor(req, 'editor');
  if (!String(req.body.prompt || '').trim()) throw new HttpError(400, 'Write a prompt to boost.');
  res.json({ prompt: await boostPrompt(brand, String(req.body.prompt), req.body.type || 'single_image') });
});

router.post('/posts/estimate', (req, res) => {
  brandFor(req);
  const type = req.body.type || 'single_image';
  if (!POST_TYPES[type]) throw new HttpError(400, `Unknown post type "${type}".`);
  res.json({ credits: costFor({ ...req.body, type }) });
});

// ---------------------------------------------------------------- posts
const owned = (req, min = 'reviewer') => {
  const brand = brandFor(req, min);
  const p = one('SELECT * FROM posts WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!p) throw new HttpError(404, 'Post not found.');
  return { brand, post: hydrate(p) };
};

router.post('/posts', (req, res) => {
  const brand = brandFor(req, 'editor');
  if (!brand.active) throw new HttpError(403, 'This brand is inactive. Activate it to create content.');
  res.status(201).json(createPost({ brand, user: req.user, input: req.body }));
});

router.get('/posts', (req, res) => {
  const brand = brandFor(req);
  const where = ['brand_id = ?'];
  const args = [brand.id];
  where.push(req.query.archived === '1' ? 'archived = 1' : 'archived = 0');
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.media) { where.push('media_type = ?'); args.push(req.query.media); }
  if (req.query.type) { where.push('type = ?'); args.push(req.query.type); }
  if (req.query.q) { where.push('(title LIKE ? OR caption LIKE ? OR prompt LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
  if (req.query.ids) { const ids = String(req.query.ids).split(',').slice(0, 100); where.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  const limit = Math.min(100, Number(req.query.limit) || 40);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const total = one(`SELECT COUNT(*) AS n FROM posts WHERE ${where.join(' AND ')}`, ...args).n;
  const rows = all(`SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset).map(hydrate);
  const scheduled = new Map(all(`SELECT post_id, status, scheduled_at FROM publish_jobs WHERE brand_id = ? AND status NOT IN ('discarded') ORDER BY scheduled_at DESC`, brand.id).map((j) => [j.post_id, j]));
  res.json({ total, posts: rows.map((p) => ({ ...p, job: scheduled.get(p.id) || null })) });
});

router.get('/posts/:id', (req, res) => {
  const { post } = owned(req);
  const root = post.parent_id || post.id;
  const variants = all('SELECT id, format, status, cover, parent_id FROM posts WHERE (id = ? OR parent_id = ?) AND id != ? ORDER BY created_at', root, root, post.id);
  const jobs = all('SELECT * FROM publish_jobs WHERE post_id = ? ORDER BY scheduled_at DESC', post.id).map((j) => ({ ...j, targets: all('SELECT t.*, a.platform, a.name AS account_name FROM publish_targets t JOIN social_accounts a ON a.id = t.account_id WHERE t.job_id = ?', j.id) }));
  res.json({ ...post, variants, jobs });
});

router.patch('/posts/:id', async (req, res) => {
  const { post } = owned(req, 'editor');
  const meta = {};
  if (req.body.title !== undefined) meta.title = String(req.body.title).slice(0, 120);
  if (req.body.caption !== undefined) meta.caption = String(req.body.caption).slice(0, 5000);
  if (req.body.hashtags !== undefined) meta.hashtags = (Array.isArray(req.body.hashtags) ? req.body.hashtags.join(' ') : String(req.body.hashtags)).slice(0, 1000);
  if (Object.keys(meta).length) update('posts', post.id, { ...meta, updated_at: now() });
  if (req.body.content !== undefined || req.body.template !== undefined) {
    const content = req.body.content ? { ...post.content, slides: sanitizeSlides(req.body.content.slides || post.content.slides) } : undefined;
    return res.json(await rerender(post.id, { content, template: req.body.template }));
  }
  res.json(getPost(post.id));
});

function sanitizeSlides(slides) {
  if (!Array.isArray(slides) || !slides.length || slides.length > 10) throw new HttpError(400, 'A post has 1 to 10 slides.');
  const KINDS = ['cover', 'point', 'cta', 'quote', 'meme', 'product', 'ad', 'stat'];
  const str = (v, n) => (v == null ? '' : String(v).slice(0, n));
  return slides.map((s) => ({
    kind: KINDS.includes(s.kind) ? s.kind : 'cover',
    headline: str(s.headline, 200), body: str(s.body, 600), kicker: str(s.kicker, 40), cta: str(s.cta, 40), stat: str(s.stat, 12),
    author: str(s.author, 80), top: str(s.top, 120), bottom: str(s.bottom, 120), price: str(s.price, 20), compareAt: str(s.compareAt, 20),
    badge: str(s.badge, 20), disclaimer: str(s.disclaimer, 160), narration: str(s.narration, 600), image_query: str(s.image_query, 120),
    image: s.image && (/^\/(uploads|media)\//.test(s.image) || /^https:\/\//.test(s.image)) ? String(s.image) : null,
  }));
}

router.delete('/posts/:id', (req, res) => {
  const { post } = owned(req, 'editor');
  if (one("SELECT 1 FROM publish_jobs WHERE post_id = ? AND status IN ('scheduled','publishing')", post.id)) throw new HttpError(409, 'This post is scheduled. Discard the schedule first.');
  fs.rmSync(path.join(config.dataDir, 'media', post.id), { recursive: true, force: true });
  run('DELETE FROM posts WHERE id = ?', post.id);
  res.json({ ok: true });
});

router.post('/posts/:id/archive', (req, res) => {
  const { post } = owned(req, 'editor');
  update('posts', post.id, { archived: req.body?.archived === false ? 0 : 1 });
  res.json({ ok: true });
});

router.post('/posts/bulk-archive', (req, res) => {
  const brand = brandFor(req, 'editor');
  const ids = (req.body.ids || []).slice(0, 200);
  for (const id of ids) run('UPDATE posts SET archived = ? WHERE id = ? AND brand_id = ?', req.body.archived === false ? 0 : 1, id, brand.id);
  res.json({ ok: true, count: ids.length });
});

router.post('/posts/:id/duplicate', (req, res) => {
  const { brand, post } = owned(req, 'editor');
  if (post.status !== 'ready') throw new HttpError(409, 'Only finished posts can be duplicated.');
  const id = uuid();
  const dir = path.join(config.dataDir, 'media', id);
  fs.cpSync(path.join(config.dataDir, 'media', post.id), dir, { recursive: true });
  const swap = (u) => (u ? u.replace(`/media/${post.id}/`, `/media/${id}/`) : u);
  insert('posts', {
    id, brand_id: brand.id, created_by: req.user.id, type: post.type, media_type: post.media_type, format: post.format, status: 'ready',
    title: `${post.title} (copy)`.slice(0, 120), prompt: post.prompt, input: post.input, content: post.content, caption: post.caption, hashtags: post.hashtags,
    media: post.media.map((m) => ({ ...m, url: swap(m.url) })), cover: swap(post.cover), template: post.template, language: post.language, version: post.version, writer: post.writer,
  });
  res.status(201).json(getPost(id));
});

router.post('/posts/:id/resize', async (req, res) => {
  const { brand, post } = owned(req, 'editor');
  res.status(201).json(await resizePost({ brand, user: req.user, post, format: req.body.format }));
});

router.post('/posts/:id/retry', (req, res) => {
  const { brand, post } = owned(req, 'editor');
  res.json(retryPost({ brand, post }));
});

const MAX_REWRITES = 5;
router.post('/posts/:id/caption/rewrite', async (req, res) => {
  const { brand, post } = owned(req, 'editor');
  if (post.caption_rewrites >= MAX_REWRITES) throw new HttpError(429, "You've used all your caption rewrites for this post. You can still edit it.", 'rewrite_limit');
  const caption = await rewriteCaption(brand, { caption: req.body.caption ?? post.caption, title: post.title, instruction: req.body.instruction, language: post.language });
  update('posts', post.id, { caption, caption_rewrites: post.caption_rewrites + 1, updated_at: now() });
  res.json({ caption, rewrites_left: MAX_REWRITES - post.caption_rewrites - 1 });
});

router.post('/posts/:id/hashtags', (req, res) => {
  const { brand, post } = owned(req, 'editor');
  const tags = makeHashtags(brand, `${post.prompt} ${post.title} ${post.caption}`, Number(req.body.count) || 15).join(' ');
  update('posts', post.id, { hashtags: tags, updated_at: now() });
  res.json({ hashtags: tags });
});

router.post('/posts/:id/share', (req, res) => {
  const { post } = owned(req, 'editor');
  const shareId = post.share_id || shortId(12);
  if (!post.share_id) update('posts', post.id, { share_id: shareId });
  res.json({ share_id: shareId, url: `/s/${shareId}` });
});

router.post('/posts/:id/template', (req, res) => {
  const { brand, post } = owned(req, 'editor');
  const name = String(req.body.name || post.title).slice(0, 80);
  const slides = (post.content.slides || []).map(({ kind, kicker, cta }) => ({ kind, kicker, cta }));
  const row = insert('templates', { id: uuid(), brand_id: brand.id, name, post_type: post.type, template: post.template, format: post.format, content: { slides } });
  res.status(201).json(row);
});

// ---------------------------------------------------------------- templates
router.get('/templates', (req, res) => {
  const brand = brandFor(req);
  res.json(all('SELECT * FROM templates WHERE brand_id = ? ORDER BY created_at DESC', brand.id).map((t) => ({ ...t, content: json(t.content, {}) })));
});
router.delete('/templates/:id', (req, res) => {
  const brand = brandFor(req, 'editor');
  run('DELETE FROM templates WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  res.json({ ok: true });
});

// Test hook: wait for all queued generations (only in test mode).
if (config.isTest) router.post('/__test/idle', async (_req, res) => { await idle(); res.json({ ok: true }); });
