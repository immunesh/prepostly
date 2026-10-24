import { one, all, run, uuid, now, json, insert } from '../db.js';
import { planOf, payerFor } from '../credits.js';
import { createPost } from '../generate.js';
import { planTopics } from './content.js';
import { zonedParts, zonedToUtc } from './besttime.js';
import { notify } from '../notify.js';
import { withMeter } from '../usage.js';

// Auto posting: keeps the next week, two weeks or month of a brand's calendar filled with
// generated posts at the chosen days and times, rotating post types and topics (or store
// products). With approval on, posts wait in the review queue until someone approves them.

export const HORIZONS = [7, 14, 30];
// Posts generated per run. A month of four daily slots is 120 posts; the daily run tops up the rest.
const MAX_PER_RUN = 60;
const PRODUCT_TYPE = { single_image: 'ecom_product', carousel: 'ecom_carousel', video: 'ecom_video', ad_creative: 'ad_creative' };

export function hydrateAutopilot(a) {
  return a && { ...a, enabled: Boolean(a.enabled), require_approval: Boolean(a.require_approval), topics: json(a.topics, []), post_types: json(a.post_types, []), days: json(a.days, []), times: json(a.times, []), account_ids: json(a.account_ids, []) };
}

/** Slot times (UTC ISO) on the given weekdays and wall-clock times in tz, after `from` and up to `to`. */
export function weeklySlots({ days, times, tz = 'UTC', from, to }) {
  const out = [];
  for (let t = from.getTime(); t <= to.getTime() + 864e5; t += 864e5) {
    const { day, weekday } = zonedParts(new Date(t), tz);
    if (!days.includes(weekday)) continue;
    for (const time of times) {
      const iso = zonedToUtc(day, time, tz);
      const at = new Date(iso).getTime();
      if (at > from.getTime() && at <= to.getTime()) out.push(iso);
    }
  }
  return [...new Set(out)].sort();
}

/** Upcoming slot times (UTC ISO) for the autopilot within its horizon. */
export function upcomingSlots(ap, brand, from = new Date()) {
  const horizon = ap.horizon_days || 7;
  return weeklySlots({ days: ap.days, times: ap.times, tz: brand.timezone || 'UTC', from: new Date(from.getTime() + 30 * 60000), to: new Date(from.getTime() + horizon * 864e5) });
}

/** Fill empty slots. Returns the number of posts created. */
export async function runAutopilot(apId, { maxPosts = MAX_PER_RUN } = {}) {
  const ap = hydrateAutopilot(one('SELECT * FROM autopilots WHERE id = ?', apId));
  const brand = one('SELECT * FROM brands WHERE id = ?', ap.brand_id);
  const payer = payerFor(brand);
  const finish = (error) => run('UPDATE autopilots SET last_run_at = ?, next_run_at = ?, last_error = ? WHERE id = ?', now(), new Date(Date.now() + 864e5).toISOString(), error, ap.id);
  if (!planOf(payer).autoPosting) return finish('Auto posting is not included in your plan.'), 0;
  if (!brand.active) return finish('This brand is inactive.'), 0;
  const accounts = ap.account_ids.filter((id) => one("SELECT id FROM social_accounts WHERE id = ? AND brand_id = ? AND status = 'active'", id, brand.id));
  if (!accounts.length) return finish('Connect at least one channel for auto posting.'), 0;

  const taken = new Set(all("SELECT scheduled_at FROM publish_jobs WHERE autopilot_id = ? AND status NOT IN ('discarded','rejected')", ap.id).map((r) => r.scheduled_at));
  const slots = upcomingSlots(ap, brand).filter((s) => !taken.has(s)).slice(0, maxPosts);
  if (!slots.length) return finish(null), 0;

  let products = [];
  if (ap.source === 'products') {
    products = all('SELECT * FROM products WHERE brand_id = ? ORDER BY posted_count ASC, created_at ASC LIMIT ?', brand.id, slots.length).map((p) => ({ ...p, images: json(p.images, []) }));
    if (!products.length) return finish('Import products from your store first (Brand → Integrations).'), 0;
  }
  const direction = [ap.direction, ...ap.topics].filter(Boolean).join('; ');
  const topics = ap.source === 'products' ? [] : await withMeter({ userId: brand.owner_id, brandId: brand.id, job: 'autopilot', ref: ap.id }, () => planTopics(brand, { direction, count: slots.length }));

  const reviewers = all("SELECT user_id FROM brand_members WHERE brand_id = ? AND role IN ('owner','admin','reviewer')", brand.id).map((r) => r.user_id);
  let created = 0;
  let error = null;
  for (let i = 0; i < slots.length; i++) {
    const baseType = ap.post_types[(ap.cursor + i) % ap.post_types.length] || 'single_image';
    const product = products[i % (products.length || 1)];
    const type = ap.source === 'products' ? PRODUCT_TYPE[baseType] || 'ecom_product' : baseType;
    try {
      const post = createPost({
        brand, user: { id: brand.owner_id },
        input: { type, prompt: product ? '' : topics[i] || ap.direction, product_id: product?.id, format: ap.format, autopilot_id: ap.id, template: 'auto' },
      });
      const jobId = uuid();
      insert('publish_jobs', { id: jobId, post_id: post.id, brand_id: brand.id, created_by: brand.owner_id, status: ap.require_approval ? 'in_review' : 'scheduled', scheduled_at: slots[i], caption: '', options: {}, reviewers, autopilot_id: ap.id });
      for (const acc of accounts) insert('publish_targets', { id: uuid(), job_id: jobId, account_id: acc, status: 'pending' });
      if (product) run('UPDATE products SET posted_count = posted_count + 1 WHERE id = ?', product.id);
      created++;
    } catch (e) {
      error = e.message;
      break;
    }
  }
  run('UPDATE autopilots SET cursor = cursor + ? WHERE id = ?', created, ap.id);
  finish(error);
  if (created && ap.require_approval) for (const r of reviewers) notify(r, brand.id, 'autopilot_review', `${created} auto posts are ready for review`, `Approve them before they go live for ${brand.name}.`, '/app/autoposting/review');
  if (error) notify(brand.owner_id, brand.id, 'autopilot_error', 'Auto posting paused', error, '/app/autoposting');
  return created;
}

export async function runDueAutopilots() {
  for (const ap of all('SELECT id FROM autopilots WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)', now())) {
    await runAutopilot(ap.id);
  }
}
