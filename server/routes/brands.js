import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { one, all, run, uuid, tx, update, insert, deleteBrand } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { TONES, LANGUAGES, FONTS, VOICES } from '../catalog.js';
import { planOf, refreshCredits } from '../credits.js';
import { brandFromWebsite } from '../engines/scraper.js';
import { normHex } from '../engines/render.js';
import { safeFetch } from '../net.js';
import { sniffMime } from '../engines/images.js';
import { publicBrand } from './auth.js';

export const router = Router();
router.use(requireUser);

const TEXT_FIELDS = { name: 80, website: 300, industry: 120, description: 1500, audience: 500, handle: 60, hashtags: 400, cta: 120, ethnicity: 60 };

function cleanPatch(body) {
  const patch = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) if (body[k] !== undefined) patch[k] = String(body[k] ?? '').trim().slice(0, max);
  if (patch.name === '') throw new HttpError(400, 'Brand name cannot be empty.');
  if (patch.handle) patch.handle = patch.handle.replace(/^@/, '');
  if (body.tone !== undefined) {
    if (!TONES.includes(body.tone)) throw new HttpError(400, `Unknown tone "${body.tone}".`);
    patch.tone = body.tone;
  }
  if (body.language !== undefined) {
    if (!LANGUAGES.includes(body.language)) throw new HttpError(400, `Unsupported language "${body.language}".`);
    patch.language = body.language;
  }
  for (const k of ['font_heading', 'font_body']) {
    if (body[k] !== undefined) {
      if (!FONTS.includes(body[k])) throw new HttpError(400, `Unknown font "${body[k]}".`);
      patch[k] = body[k];
    }
  }
  if (body.text_case !== undefined) {
    if (!['default', 'upper', 'title'].includes(body.text_case)) throw new HttpError(400, 'text_case must be default, upper or title.');
    patch.text_case = body.text_case;
  }
  if (body.voice !== undefined) {
    if (!VOICES[body.voice]) throw new HttpError(400, `Unknown voice "${body.voice}".`);
    patch.voice = body.voice;
  }
  if (body.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); } catch { throw new HttpError(400, `Unknown timezone "${body.timezone}".`); }
    patch.timezone = body.timezone;
  }
  for (const k of ['colors', 'gradient']) {
    if (body[k] !== undefined) {
      if (!Array.isArray(body[k])) throw new HttpError(400, `${k} must be a list of hex colors.`);
      patch[k] = JSON.stringify(body[k].slice(0, 6).map((c) => normHex(c, null)).filter(Boolean));
    }
  }
  if (body.palettes !== undefined) {
    if (!Array.isArray(body.palettes) || body.palettes.length > 5) throw new HttpError(400, 'You can add up to 5 palettes.');
    patch.palettes = JSON.stringify(body.palettes.map((p) => (Array.isArray(p) ? p : []).slice(0, 6).map((c) => normHex(c, null)).filter(Boolean)));
  }
  for (const k of ['logo_light', 'logo_dark']) {
    if (body[k] !== undefined) {
      if (body[k] && !/^\/uploads\/[A-Za-z0-9._/-]+$/.test(body[k])) throw new HttpError(400, 'Logos must be uploaded files.');
      patch[k] = body[k] || null;
    }
  }
  if (body.settings !== undefined) patch.settings = JSON.stringify(body.settings || {});
  return patch;
}

/** Download a remote logo into the brand's uploads. */
async function saveRemoteLogo(brandId, userId, url) {
  try {
    const r = await safeFetch(url, { accept: 'image/*', maxBytes: 3 * 1024 * 1024 });
    const mime = sniffMime(r.buffer);
    if (r.status >= 400 || !mime.startsWith('image/')) return null;
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'img';
    const file = `${brandId}/${crypto.randomUUID()}.${ext}`;
    fs.mkdirSync(path.join(config.dataDir, 'uploads', brandId), { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, 'uploads', file), r.buffer);
    insert('uploads', { id: uuid(), brand_id: brandId, user_id: userId, kind: 'image', name: 'Logo (from website)', file: `/uploads/${file}`, mime, size: r.buffer.length });
    return `/uploads/${file}`;
  } catch {
    return null;
  }
}

router.get('/brands', (req, res) => {
  res.json(all('SELECT b.*, m.role FROM brands b JOIN brand_members m ON m.brand_id = b.id WHERE m.user_id = ? ORDER BY b.created_at', req.user.id).map(publicBrand));
});

/** Preview brand details from a website without saving. */
router.post('/brands/from-website', async (req, res) => {
  res.json(await brandFromWebsite(req.body.url));
});

router.post('/brands', async (req, res) => {
  const user = refreshCredits(req.user.id);
  const owned = one('SELECT COUNT(*) AS n FROM brands WHERE owner_id = ? AND active = 1', user.id).n;
  const limit = planOf(user).brands;
  if (owned >= limit) throw new HttpError(429, `Your plan includes ${limit} brand${limit === 1 ? '' : 's'}. Upgrade to add more.`, 'brand_limit');
  const patch = cleanPatch({ name: req.body.name || 'My brand', ...req.body, logo_light: undefined, logo_dark: undefined });
  const id = uuid();
  tx(() => {
    run('INSERT INTO brands (id, owner_id, name) VALUES (?, ?, ?)', id, user.id, patch.name);
    update('brands', id, patch);
    run('INSERT INTO brand_members (brand_id, user_id, role) VALUES (?, ?, ?)', id, user.id, 'owner');
    run('UPDATE users SET current_brand_id = ? WHERE id = ?', id, user.id);
  });
  if (req.body.logo_url) {
    const logo = await saveRemoteLogo(id, user.id, req.body.logo_url);
    if (logo) update('brands', id, { logo_light: logo });
  }
  res.status(201).json(publicBrand({ ...one('SELECT * FROM brands WHERE id = ?', id), role: 'owner' }));
});

function brandById(req, min) {
  if (req.apiBrandId && req.apiBrandId !== req.params.id) throw new HttpError(403, 'This API key belongs to another brand.');
  req.headers['x-brand-id'] = req.params.id;
  return brandFor(req, min);
}

router.get('/brands/:id', (req, res) => {
  const b = brandById(req, 'reviewer');
  res.json(publicBrand({ ...b, role: req.role }));
});

router.patch('/brands/:id', async (req, res) => {
  const b = brandById(req, 'admin');
  const patch = cleanPatch(req.body);
  update('brands', b.id, patch);
  if (req.body.logo_url) {
    const logo = await saveRemoteLogo(b.id, req.user.id, req.body.logo_url);
    if (logo) update('brands', b.id, { logo_light: logo });
  }
  res.json(publicBrand({ ...one('SELECT * FROM brands WHERE id = ?', b.id), role: req.role }));
});

function setActive(activate) {
  return (req, res) => {
  const b = brandById(req, 'owner');
  if (activate) {
    const user = refreshCredits(req.user.id);
    const active = one('SELECT COUNT(*) AS n FROM brands WHERE owner_id = ? AND active = 1', user.id).n;
    if (!b.active && active >= planOf(user).brands) throw new HttpError(429, 'Deactivate another brand or upgrade to activate this one.', 'brand_limit');
  }
  update('brands', b.id, { active: activate ? 1 : 0 });
  if (!activate) run('UPDATE autopilots SET enabled = 0 WHERE brand_id = ?', b.id);
  res.json({ ok: true });
  };
}
router.post('/brands/:id/activate', setActive(true));
router.post('/brands/:id/deactivate', setActive(false));

router.delete('/brands/:id', (req, res) => {
  const b = brandById(req, 'owner');
  deleteBrand(b.id);
  res.json({ ok: true });
});

