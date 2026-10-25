import { Router } from 'express';
import { one, json } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { POST_TYPES, FORMATS, TEMPLATES, TONES, LANGUAGES, FONTS, VOICES, MUSIC, PLANS, CREDIT_COSTS, ROLES, AUTOPILOT_SUGGESTIONS } from '../catalog.js';
import { upcomingSpecialDays } from '../engines/content.js';
import { platformList } from '../publishers/index.js';

// Public, unauthenticated endpoints: product catalogue, platforms and shareable previews.

export const router = Router();

router.get('/catalog', (_req, res) => {
  res.json({ post_types: POST_TYPES, formats: FORMATS, templates: TEMPLATES, tones: TONES, languages: LANGUAGES, fonts: FONTS, voices: VOICES, music: MUSIC, plans: PLANS, costs: CREDIT_COSTS, roles: ROLES, platforms: platformList(), special_days: upcomingSpecialDays(new Date(), 10), autopilot_suggestions: AUTOPILOT_SUGGESTIONS, legal: { name: config.legalName, email: config.supportEmail } });
});

router.get('/platforms', (_req, res) => res.json(platformList()));

// Status of a Meta or Threads data deletion request (deletions run as soon as the callback arrives).
router.get('/data-deletion/:code', (req, res) => {
  const d = one('SELECT code, platform, removed, created_at FROM data_deletions WHERE code = ?', req.params.code);
  if (!d) throw new HttpError(404, 'We couldn’t find a deletion request with that code.');
  res.json({ ...d, status: 'completed' });
});

router.get('/share/:shareId', (req, res) => {
  const p = one('SELECT * FROM posts WHERE share_id = ?', req.params.shareId);
  if (!p) throw new HttpError(404, 'This preview link no longer works.');
  const brand = one('SELECT name, logo_light, handle FROM brands WHERE id = ?', p.brand_id);
  res.json({ id: p.id, title: p.title, type: p.type, format: p.format, caption: p.caption, hashtags: p.hashtags, media: json(p.media, []).filter((m) => m.kind !== 'frame'), cover: p.cover, version: p.version, updated_at: p.updated_at, brand });
});

// API-key callers: which brand does this key act on?
export const v1Router = Router();
v1Router.get('/brand', requireUser, (req, res) => {
  const b = brandFor(req);
  res.json({ id: b.id, name: b.name, website: b.website, industry: b.industry, tone: b.tone, language: b.language, colors: json(b.colors, []) });
});
