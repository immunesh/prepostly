import { all } from '../db.js';

// Suggests publishing times: from the brand's own engagement history when there is enough
// of it, otherwise from widely observed engagement peaks. Times are in the brand timezone.

const DEFAULT_SLOTS = [
  // [weekday 0=Sun..6, hour, weight]
  [2, 9, 10], [3, 9, 10], [4, 9, 9], [2, 12, 8], [3, 12, 9], [4, 12, 8], [1, 11, 7], [5, 10, 7],
  [3, 18, 7], [2, 19, 6], [4, 19, 6], [6, 10, 5], [0, 11, 4], [1, 18, 5], [5, 13, 5],
];

/** Offset in minutes of a timezone at a given instant (positive east of UTC). */
export function tzOffsetMinutes(tz, date = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Convert a wall-clock date + time in tz to a UTC ISO string. */
export function zonedToUtc(day, time, tz) {
  const [h, m] = String(time).split(':').map(Number);
  const guess = new Date(`${day}T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00Z`);
  const off = tzOffsetMinutes(tz, guess);
  const first = new Date(guess.getTime() - off * 60000);
  const off2 = tzOffsetMinutes(tz, first);
  return new Date(guess.getTime() - off2 * 60000).toISOString();
}

/** Wall-clock parts of an instant in tz. */
export function zonedParts(date, tz) {
  const shifted = new Date(new Date(date).getTime() + tzOffsetMinutes(tz, new Date(date)) * 60000);
  return { day: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

/** Engagement-weighted (weekday, hour) slots for a brand. */
export function slotWeights(brandId) {
  const rows = all(`SELECT t.published_at, t.likes + t.comments * 2 + t.shares * 3 AS score FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id
    WHERE j.brand_id = ? AND t.status = 'published' AND t.published_at IS NOT NULL AND t.metrics_at IS NOT NULL`, brandId);
  if (rows.length < 8) return { source: 'industry', slots: DEFAULT_SLOTS };
  const tz = all('SELECT timezone FROM brands WHERE id = ?', brandId)[0]?.timezone || 'UTC';
  const agg = new Map();
  for (const r of rows) {
    const p = zonedParts(r.published_at, tz);
    const k = `${p.weekday}:${p.hour}`;
    const a = agg.get(k) || { n: 0, s: 0 };
    a.n++;
    a.s += r.score;
    agg.set(k, a);
  }
  const slots = [...agg.entries()].map(([k, v]) => {
    const [d, h] = k.split(':').map(Number);
    return [d, h, v.s / v.n];
  }).sort((a, b) => b[2] - a[2]).slice(0, 12);
  return { source: 'history', slots };
}

/** Next `count` suggested publish times (UTC ISO), avoiding hours that already have posts. */
export function suggestTimes(brand, { count = 3, after = new Date() } = {}) {
  const { slots, source } = slotWeights(brand.id);
  const tz = brand.timezone || 'UTC';
  const busy = new Set(all("SELECT scheduled_at FROM publish_jobs WHERE brand_id = ? AND status IN ('scheduled','in_review','published') AND scheduled_at >= ?", brand.id, after.toISOString()).map((r) => r.scheduled_at.slice(0, 13)));
  const out = [];
  const minLead = after.getTime() + 20 * 60000;
  for (let d = 0; d < 14 && out.length < count * 3; d++) {
    const dayDate = new Date(after.getTime() + d * 864e5);
    const { day, weekday } = zonedParts(dayDate, tz);
    for (const [wd, hour, weight] of slots) {
      if (wd !== weekday) continue;
      const iso = zonedToUtc(day, `${hour}:00`, tz);
      if (new Date(iso).getTime() < minLead || busy.has(iso.slice(0, 13))) continue;
      out.push({ at: iso, weight, source });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, count);
}
