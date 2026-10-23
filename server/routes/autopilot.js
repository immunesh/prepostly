import { Router } from 'express';
import { one, all, run, uuid, now, insert } from '../db.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { POST_TYPES, FORMATS } from '../catalog.js';
import { planOf, payerFor } from '../credits.js';
import { hydrateAutopilot, upcomingSlots, runAutopilot, HORIZONS } from '../engines/autopilot.js';
import { jobDetail } from './publish.js';

export const router = Router();
router.use(requireUser);

const ALLOWED_TYPES = ['single_image', 'carousel', 'quote', 'meme', 'video', 'voiceover_video', 'ad_creative'];

function getOrCreate(brand) {
  let ap = one('SELECT * FROM autopilots WHERE brand_id = ?', brand.id);
  if (!ap) {
    insert('autopilots', { id: uuid(), brand_id: brand.id });
    ap = one('SELECT * FROM autopilots WHERE brand_id = ?', brand.id);
  }
  return hydrateAutopilot(ap);
}

router.get('/autopilot', (req, res) => {
  const brand = brandFor(req);
  const ap = getOrCreate(brand);
  const jobs = all("SELECT status, COUNT(*) AS n FROM publish_jobs WHERE autopilot_id = ? GROUP BY status", ap.id);
  res.json({
    ...ap,
    allowed: planOf(payerFor(brand)).autoPosting,
    upcoming_slots: upcomingSlots(ap, brand),
    stats: Object.fromEntries(jobs.map((j) => [j.status, j.n])),
    products: one('SELECT COUNT(*) AS n FROM products WHERE brand_id = ?', brand.id).n,
  });
});

router.put('/autopilot', (req, res) => {
  const brand = brandFor(req, 'admin');
  const ap = getOrCreate(brand);
  const b = req.body;
  const patch = {};
  if (b.source !== undefined) {
    if (!['topics', 'products'].includes(b.source)) throw new HttpError(400, 'source must be topics or products.');
    patch.source = b.source;
  }
  if (b.direction !== undefined) {
    const d = String(b.direction).trim();
    if (d && d.length < 10) throw new HttpError(400, 'Tell us what your posts should focus on. Use at least 10 characters.');
    if (d.length > 1000) throw new HttpError(400, "That's longer than we can use. Keep it under 1000 characters.");
    patch.direction = d;
  }
  if (b.topics !== undefined) patch.topics = JSON.stringify((b.topics || []).map(String).slice(0, 12));
  if (b.post_types !== undefined) {
    if (!Array.isArray(b.post_types) || !b.post_types.length || b.post_types.some((t) => !ALLOWED_TYPES.includes(t))) throw new HttpError(400, `Pick at least one post type from: ${ALLOWED_TYPES.map((t) => POST_TYPES[t].label).join(', ')}.`);
    patch.post_types = JSON.stringify(b.post_types);
  }
  if (b.days !== undefined) {
    if (!Array.isArray(b.days) || !b.days.length || b.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'Pick at least one weekday.');
    patch.days = JSON.stringify([...new Set(b.days)].sort());
  }
  if (b.times !== undefined) {
    if (!Array.isArray(b.times) || !b.times.length || b.times.length > 4 || b.times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new HttpError(400, 'Pick 1 to 4 posting times (HH:MM).');
    patch.times = JSON.stringify([...new Set(b.times)].sort());
  }
  if (b.account_ids !== undefined) {
    for (const id of b.account_ids) if (!one('SELECT 1 FROM social_accounts WHERE id = ? AND brand_id = ?', id, brand.id)) throw new HttpError(400, 'Unknown channel.');
    patch.account_ids = JSON.stringify(b.account_ids);
  }
  if (b.horizon_days !== undefined) {
    if (!HORIZONS.includes(Number(b.horizon_days))) throw new HttpError(400, 'Plan ahead for 1 week, 2 weeks or 1 month.');
    patch.horizon_days = Number(b.horizon_days);
    // A longer horizon has new slots to fill, so don't wait for tomorrow's run.
    if (patch.horizon_days > ap.horizon_days) patch.next_run_at = now();
  }
  if (b.require_approval !== undefined) patch.require_approval = b.require_approval ? 1 : 0;
  if (b.format !== undefined) {
    if (!FORMATS[b.format]) throw new HttpError(400, 'Unknown format.');
    patch.format = b.format;
  }
  if (b.enabled !== undefined) {
    if (b.enabled && !planOf(payerFor(brand)).autoPosting) throw new HttpError(403, 'Auto posting is not included in your plan. Upgrade to Rise or Enterprise.', 'paywall');
    patch.enabled = b.enabled ? 1 : 0;
    if (b.enabled) patch.next_run_at = now();
  }
  const keys = Object.keys(patch);
  if (keys.length) run(`UPDATE autopilots SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), ap.id);
  const fresh = getOrCreate(brand);
  if (fresh.enabled && !fresh.account_ids.length) throw new HttpError(400, 'Choose at least one channel for auto posting.');
  res.json(fresh);
});

/** Fill the upcoming slots now instead of waiting for the daily run. */
router.post('/autopilot/run', async (req, res) => {
  const brand = brandFor(req, 'admin');
  const ap = getOrCreate(brand);
  if (!ap.enabled) throw new HttpError(409, 'Turn auto posting on first.');
  const created = await runAutopilot(ap.id);
  const fresh = getOrCreate(brand);
  res.json({ created, error: fresh.last_error });
});

router.get('/autopilot/review', (req, res) => {
  const brand = brandFor(req);
  const ap = getOrCreate(brand);
  res.json(all("SELECT * FROM publish_jobs WHERE autopilot_id = ? AND status IN ('in_review','scheduled','rejected') ORDER BY scheduled_at", ap.id).map(jobDetail));
});

router.post('/autopilot/review/approve-all', (req, res) => {
  const brand = brandFor(req, 'reviewer');
  const ap = getOrCreate(brand);
  const n = run("UPDATE publish_jobs SET status = 'scheduled', reviewed_by = ?, updated_at = ? WHERE autopilot_id = ? AND status = 'in_review'", req.user.id, now(), ap.id).changes;
  res.json({ approved: n });
});
