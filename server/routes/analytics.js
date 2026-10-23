import { Router } from 'express';
import { one, all, run, json } from '../db.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { zonedParts } from '../engines/besttime.js';
import { jobDetail } from './publish.js';

export const router = Router();
router.use(requireUser);

const dayKey = (iso, tz) => zonedParts(iso, tz).day;

function rangeStats(brandId, from, to) {
  const t = one(`SELECT COUNT(DISTINCT j.id) AS posts, COALESCE(SUM(t.likes + t.comments + t.shares),0) AS engagement, COALESCE(SUM(t.impressions),0) AS impressions
    FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id WHERE j.brand_id = ? AND t.status = 'published' AND t.published_at >= ? AND t.published_at < ?`, brandId, from, to);
  return t;
}

function followersAt(brandId, day) {
  return one(`SELECT COALESCE(SUM(m.followers),0) AS n FROM social_accounts a JOIN account_metrics m ON m.account_id = a.id
    WHERE a.brand_id = ? AND m.day = (SELECT MAX(day) FROM account_metrics WHERE account_id = a.id AND day <= ?)`, brandId, day).n;
}

const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

router.get('/analytics', (req, res) => {
  const brand = brandFor(req);
  const tz = brand.timezone || 'UTC';
  const days = Math.max(7, Math.min(365, Number(req.query.days) || 30));
  const to = new Date();
  const from = new Date(to.getTime() - days * 864e5);
  const prevFrom = new Date(from.getTime() - days * 864e5);
  const cur = rangeStats(brand.id, from.toISOString(), to.toISOString());
  const prev = rangeStats(brand.id, prevFrom.toISOString(), from.toISOString());
  const followersNow = followersAt(brand.id, to.toISOString().slice(0, 10));
  const followersThen = followersAt(brand.id, from.toISOString().slice(0, 10));

  const published = all(`SELECT t.published_at, t.likes, t.comments, t.shares, a.platform FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id JOIN social_accounts a ON a.id = t.account_id
    WHERE j.brand_id = ? AND t.status = 'published' AND t.published_at >= ? ORDER BY t.published_at`, brand.id, from.toISOString());

  const series = [];
  for (let i = days - 1; i >= 0; i--) series.push({ day: dayKey(new Date(to.getTime() - i * 864e5).toISOString(), tz), posts: 0, engagement: 0, followers: null });
  const byDay = new Map(series.map((s) => [s.day, s]));
  const distribution = Array.from({ length: 7 }, () => Array(24).fill(0));
  const platforms = {};
  for (const p of published) {
    const z = zonedParts(p.published_at, tz);
    const s = byDay.get(z.day);
    const e = p.likes + p.comments + p.shares;
    if (s) { s.posts++; s.engagement += e; }
    distribution[z.weekday][z.hour]++;
    platforms[p.platform] = (platforms[p.platform] || 0) + e;
  }
  for (const r of all(`SELECT m.day, SUM(m.followers) AS n FROM account_metrics m JOIN social_accounts a ON a.id = m.account_id WHERE a.brand_id = ? AND m.day >= ? GROUP BY m.day`, brand.id, series[0].day)) {
    if (byDay.has(r.day)) byDay.get(r.day).followers = r.n;
  }

  // Posting streak: consecutive days (ending today or yesterday) with a published post.
  const postedDays = new Set(all(`SELECT t.published_at FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id WHERE j.brand_id = ? AND t.status = 'published' AND t.published_at >= ?`, brand.id, new Date(Date.now() - 400 * 864e5).toISOString()).map((r) => dayKey(r.published_at, tz)));
  let streak = 0;
  const today = dayKey(new Date().toISOString(), tz);
  for (let i = postedDays.has(today) ? 0 : 1; i < 400; i++) {
    if (postedDays.has(dayKey(new Date(Date.now() - i * 864e5).toISOString(), tz))) streak++;
    else break;
  }
  const last14 = Array.from({ length: 14 }, (_, i) => {
    const d = dayKey(new Date(Date.now() - (13 - i) * 864e5).toISOString(), tz);
    return { day: d, posted: postedDays.has(d) };
  });

  const settings = json(brand.settings, {});
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthPosts = [...postedDays].filter((d) => d >= monthStart).length;
  const generated = one('SELECT COUNT(*) AS n FROM posts WHERE brand_id = ? AND created_at >= ?', brand.id, from.toISOString()).n;

  res.json({
    range: { from: from.toISOString(), to: to.toISOString(), days },
    metrics: {
      new_posts: { value: cur.posts, change: pct(cur.posts, prev.posts) },
      followers: { value: followersNow, change: followersThen ? pct(followersNow, followersThen) : null },
      engagement: { value: cur.engagement, change: pct(cur.engagement, prev.engagement) },
      impressions: { value: cur.impressions, change: pct(cur.impressions, prev.impressions) },
      generated,
    },
    series,
    distribution,
    engagement_by_platform: Object.entries(platforms).map(([platform, engagement]) => ({ platform, engagement })),
    streak: { days: streak, last14 },
    goal: { posts_per_month: settings.goal_posts_per_month || null, email: Boolean(settings.goal_email), this_month: monthPosts },
    upcoming: all("SELECT * FROM publish_jobs WHERE brand_id = ? AND status IN ('scheduled','in_review') AND scheduled_at >= ? ORDER BY scheduled_at LIMIT 5", brand.id, new Date().toISOString()).map(jobDetail),
    latest: all("SELECT * FROM publish_jobs WHERE brand_id = ? AND status IN ('published','partial') ORDER BY scheduled_at DESC LIMIT 5", brand.id).map(jobDetail),
  });
});

router.put('/analytics/goal', (req, res) => {
  const brand = brandFor(req, 'editor');
  const n = Number(req.body.posts_per_month);
  if (!Number.isInteger(n) || n < 1 || n > 300) throw new HttpError(400, 'Set a goal between 1 and 300 posts per month.');
  const settings = { ...json(brand.settings, {}), goal_posts_per_month: n, goal_email: Boolean(req.body.email) };
  run('UPDATE brands SET settings = ? WHERE id = ?', JSON.stringify(settings), brand.id);
  res.json({ ok: true });
});
