import { Router } from 'express';
import { one, all, run, uuid, now, insert, update, json } from '../db.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { checkQuota, recordUsage, payerFor, planOf } from '../credits.js';
import { fetchCompetitor, analyze, parseImport } from '../engines/competitor.js';
import { fetchAds, summarizeAds } from '../engines/adintel.js';
import { createPost } from '../generate.js';

// Competitor analysis and Ad Intelligence.

export const router = Router();
router.use(requireUser);

const MAX_PER_RUN = 3;
const competitorOut = (c) => ({ ...c, profile: json(c.profile, {}), analysis: json(c.analysis, {}), posts: undefined, post_count: json(c.posts, []).length });

router.get('/competitors', (req, res) => {
  const brand = brandFor(req);
  res.json(all('SELECT * FROM competitors WHERE brand_id = ? ORDER BY created_at', brand.id).map(competitorOut));
});

router.post('/competitors', (req, res) => {
  const brand = brandFor(req, 'editor');
  const platform = req.body.platform;
  if (!['instagram', 'facebook', 'manual'].includes(platform)) throw new HttpError(400, 'Platform must be instagram, facebook or manual.');
  const handle = String(req.body.handle || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(instagram|facebook)\.com\//, '').replace(/\/.*$/, '');
  if (!handle) throw new HttpError(400, 'Enter the competitor handle or page name.');
  if (one('SELECT id FROM competitors WHERE brand_id = ? AND platform = ? AND handle = ?', brand.id, platform, handle)) throw new HttpError(409, 'That competitor is already added.');
  const row = insert('competitors', { id: uuid(), brand_id: brand.id, platform, handle, name: req.body.name || handle, profile: { followers: Number(req.body.followers) || null } });
  res.status(201).json(competitorOut(one('SELECT * FROM competitors WHERE id = ?', row.id)));
});

function competitor(req, min) {
  const brand = brandFor(req, min);
  const c = one('SELECT * FROM competitors WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!c) throw new HttpError(404, 'Competitor not found.');
  return { brand, c };
}

router.get('/competitors/:id', (req, res) => {
  const { c } = competitor(req);
  const out = competitorOut(c);
  if (req.query.from || req.query.to) return analyze(out.profile, json(c.posts, []), { from: req.query.from, to: req.query.to }).then((analysis) => res.json({ ...out, analysis }));
  res.json(out);
});

/** Paste posts (CSV/JSON) for a manual competitor. */
router.post('/competitors/:id/import', async (req, res) => {
  const { c } = competitor(req, 'editor');
  const posts = parseImport(req.body.text);
  const profile = { ...json(c.profile, {}), ...(req.body.followers ? { followers: Number(req.body.followers) } : {}) };
  update('competitors', c.id, { posts, profile });
  res.json({ imported: posts.length });
});

/** Fetch fresh data and analyze. Counts toward the monthly competitor-run quota. */
router.post('/competitors/run', async (req, res) => {
  const brand = brandFor(req, 'editor');
  const ids = (req.body.ids || []).slice(0, 50);
  if (!ids.length) throw new HttpError(400, 'Choose competitors to analyze.');
  if (ids.length > MAX_PER_RUN) throw new HttpError(400, `You can run up to ${MAX_PER_RUN} competitors at a time. Run the rest in a new request.`, 'handle_limit_reached');
  checkQuota(brand, 'competitor_run', 'competitorRuns', ids.length);
  const results = [];
  for (const id of ids) {
    const c = one('SELECT * FROM competitors WHERE id = ? AND brand_id = ?', id, brand.id);
    if (!c) continue;
    try {
      const { profile, posts } = await fetchCompetitor(brand, c);
      const analysis = await analyze(profile, posts);
      update('competitors', c.id, { profile, posts, analysis, status: 'ready', error: null, last_run_at: now(), name: profile.name || c.name });
      recordUsage(payerFor(brand).id, brand.id, 'competitor_run');
    } catch (e) {
      update('competitors', c.id, { status: 'error', error: e.message, last_run_at: now() });
    }
    results.push(competitorOut(one('SELECT * FROM competitors WHERE id = ?', id)));
  }
  res.json(results);
});

router.delete('/competitors/:id', (req, res) => {
  const { c } = competitor(req, 'editor');
  run('DELETE FROM competitors WHERE id = ?', c.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Ad Intelligence
const trackerOut = (t) => ({ ...t, ads: undefined, summary: json(t.summary, {}) });

router.get('/adintel', (req, res) => {
  const brand = brandFor(req);
  res.json({ limit: planOf(payerFor(brand)).adTrackers, trackers: all('SELECT * FROM ad_trackers WHERE brand_id = ? ORDER BY created_at', brand.id).map(trackerOut) });
});

router.post('/adintel', (req, res) => {
  const brand = brandFor(req, 'editor');
  const limit = planOf(payerFor(brand)).adTrackers;
  if (one('SELECT COUNT(*) AS n FROM ad_trackers WHERE brand_id = ?', brand.id).n >= limit) throw new HttpError(429, `Your plan tracks up to ${limit} competitor brands.`, 'tracker_limit');
  const query = String(req.body.query || '').trim();
  if (!query) throw new HttpError(400, 'Enter a competitor brand name or Facebook Page ID.');
  const isId = /^\d{5,}$/.test(query);
  const row = insert('ad_trackers', { id: uuid(), brand_id: brand.id, query, page_id: isId ? query : null, name: req.body.name || query, country: String(req.body.country || 'US').toUpperCase().slice(0, 2) });
  res.status(201).json(trackerOut(one('SELECT * FROM ad_trackers WHERE id = ?', row.id)));
});

function tracker(req, min) {
  const brand = brandFor(req, min);
  const t = one('SELECT * FROM ad_trackers WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!t) throw new HttpError(404, 'Tracker not found.');
  return { brand, t };
}

router.get('/adintel/:id', (req, res) => {
  const { t } = tracker(req);
  res.json({ ...trackerOut(t), ads: json(t.ads, []) });
});

router.post('/adintel/:id/run', async (req, res) => {
  const { brand, t } = tracker(req, 'editor');
  try {
    const ads = await fetchAds(brand, t);
    const summary = summarizeAds(ads);
    update('ad_trackers', t.id, { ads: summary.ads, summary: { ...summary, ads: undefined }, status: 'ready', error: null, last_run_at: now(), name: ads[0]?.page_name || t.name });
  } catch (e) {
    update('ad_trackers', t.id, { status: 'error', error: e.message, last_run_at: now() });
  }
  const fresh = one('SELECT * FROM ad_trackers WHERE id = ?', t.id);
  res.json({ ...trackerOut(fresh), ads: json(fresh.ads, []) });
});

/** Recreate a competitor ad's angle as an original ad creative for your brand. */
router.post('/adintel/:id/recreate', (req, res) => {
  const { brand, t } = tracker(req, 'editor');
  const ad = json(t.ads, []).find((a) => a.id === req.body.ad_id);
  if (!ad) throw new HttpError(404, 'Ad not found.');
  const post = createPost({
    brand, user: req.user,
    input: {
      type: 'ad_creative', format: req.body.format || 'square', product_id: req.body.product_id,
      prompt: `Write an original ad for ${brand.name}${req.body.product_id ? '' : ` (${brand.description || brand.industry})`} inspired by this competitor ad's angle, without copying its wording or claims. Competitor angle: "${ad.title || ''} ${ad.body.slice(0, 400)}"`,
    },
  });
  res.status(201).json(post);
});

router.delete('/adintel/:id', (req, res) => {
  const { t } = tracker(req, 'editor');
  run('DELETE FROM ad_trackers WHERE id = ?', t.id);
  res.json({ ok: true });
});
