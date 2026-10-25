import { Router } from 'express';
import { one, all, run, tx, uuid, now, deleteBrand } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireAdmin, isAdmin, hashPassword } from '../auth.js';
import { PLANS, CREDIT_COSTS } from '../catalog.js';
import { planStatus } from '../credits.js';
import { priceList, claudeCost, heygenCost, openaiImageCost } from '../usage.js';

// Site admin dashboard: platform stats, API spend, users and credits. Only site admins
// (users.is_admin, or an email listed in ADMIN_EMAILS) can call these routes.

export const router = Router();
router.use('/admin', requireAdmin);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Ledger rows that add credits. Everything else is spending (charges, and refunds of charges).
const GRANT = "(reason IN ('trial_grant', 'monthly_refill', 'admin_adjust') OR reason LIKE 'plan:%')";
// The credit charge a ledger row belongs to, so refunds net against the job they paid back.
const JOB = `CASE WHEN l.reason = 'resize_failed' THEN 'resize'
  WHEN l.reason = 'generation_failed' THEN COALESCE((SELECT c.reason FROM credit_ledger c WHERE c.ref = l.ref AND c.delta < 0 AND c.reason LIKE 'generate:%' ORDER BY c.created_at DESC LIMIT 1), 'generate')
  ELSE l.reason END`;

function windowOf(req) {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  return { days, from: new Date(Date.now() - days * 864e5).toISOString() };
}
const dayKeys = (days) => Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10));
const round = (n, d = 6) => Math.round((n || 0) * 10 ** d) / 10 ** d;
const perCredit = (cost, credits) => (credits > 0 ? round(cost / credits) : null);
const nextMonth = () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};

function userOr404(id) {
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found.');
  return u;
}
function publicUser(u) {
  const { password_hash, ...rest } = u;
  return { ...rest, is_admin: isAdmin(u), admin_via_env: config.adminEmails.includes(u.email), suspended: Boolean(u.suspended) };
}
function ledger(userId, delta, reason, { by, note, brandId = null } = {}) {
  run('INSERT INTO credit_ledger (id, user_id, brand_id, delta, reason, ref, note) VALUES (?, ?, ?, ?, ?, ?, ?)', uuid(), userId, brandId, delta, reason, by || null, note || null);
}

/** Credits spent and API dollars per job (a credit charge reason) since `from`. */
function jobEconomics(from) {
  const credits = all(`SELECT ${JOB} AS job, -SUM(l.delta) AS credits, SUM(l.delta < 0) AS runs FROM credit_ledger l WHERE l.created_at >= ? AND NOT ${GRANT} GROUP BY 1`, from);
  const costs = all("SELECT COALESCE(job, '') AS job, SUM(cost_usd) AS cost, COUNT(*) AS calls FROM api_usage WHERE created_at >= ? GROUP BY 1", from);
  const byJob = new Map(credits.map((c) => [c.job, { job: c.job, credits: c.credits, runs: c.runs, cost: 0, calls: 0 }]));
  const uncharged = [];
  for (const c of costs) {
    const row = byJob.get(c.job);
    if (row) Object.assign(row, { cost: c.cost, calls: c.calls });
    else uncharged.push({ job: c.job || null, cost: round(c.cost), calls: c.calls });
  }
  const jobs = [...byJob.values()].map((r) => ({ ...r, cost: round(r.cost), usd_per_credit: perCredit(r.cost, r.credits), usd_per_run: r.runs ? round(r.cost / r.runs) : null })).sort((a, b) => b.credits - a.credits);
  return { jobs, uncharged };
}

// ---------------------------------------------------------------- overview
router.get('/admin/overview', (req, res) => {
  const { days, from } = windowOf(req);
  const n = (sql, ...p) => one(sql, ...p).n || 0;

  const paid = all("SELECT plan, COUNT(*) AS n FROM users WHERE plan != 'trial' GROUP BY plan");
  const trialCutoff = new Date(Date.now() - PLANS.trial.days * 864e5).toISOString();
  const users = {
    total: n('SELECT COUNT(*) AS n FROM users'),
    new: n('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', from),
    active: n(`SELECT COUNT(DISTINCT uid) AS n FROM (
      SELECT user_id AS uid FROM credit_ledger WHERE created_at >= ? AND NOT ${GRANT}
      UNION SELECT created_by FROM posts WHERE created_at >= ?
      UNION SELECT user_id FROM api_usage WHERE created_at >= ?) WHERE uid IS NOT NULL`, from, from, from),
    signed_in: n('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ?', now()),
    suspended: n('SELECT COUNT(*) AS n FROM users WHERE suspended = 1'),
    trials_expired: n("SELECT COUNT(*) AS n FROM users WHERE plan = 'trial' AND plan_started_at < ?", trialCutoff),
    by_plan: all('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan ORDER BY n DESC'),
    // Monthly plan value at list price, for paid and admin-assigned plans alike.
    mrr: paid.reduce((s, p) => s + (PLANS[p.plan]?.price || 0) * p.n, 0),
  };

  const content = {
    brands: n('SELECT COUNT(*) AS n FROM brands'),
    posts: n('SELECT COUNT(*) AS n FROM posts'),
    posts_new: n('SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?', from),
    by_status: all('SELECT status, COUNT(*) AS n FROM posts WHERE created_at >= ? GROUP BY status ORDER BY n DESC', from),
    by_type: all('SELECT type, COUNT(*) AS n FROM posts WHERE created_at >= ? GROUP BY type ORDER BY n DESC', from),
    channels: all('SELECT platform, COUNT(*) AS n FROM social_accounts GROUP BY platform ORDER BY n DESC'),
    published: n("SELECT COUNT(*) AS n FROM publish_targets WHERE status = 'published' AND published_at >= ?", from),
    publish_failed: n("SELECT COUNT(*) AS n FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id WHERE t.status = 'failed' AND j.scheduled_at >= ?", from),
    published_by_platform: all("SELECT a.platform, COUNT(*) AS n FROM publish_targets t JOIN social_accounts a ON a.id = t.account_id WHERE t.status = 'published' AND t.published_at >= ? GROUP BY a.platform ORDER BY n DESC", from),
  };

  const credits = {
    balance: n('SELECT COALESCE(SUM(credits), 0) AS n FROM users'),
    consumed: n(`SELECT -COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE created_at >= ? AND NOT ${GRANT}`, from),
    refunded: n(`SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE created_at >= ? AND delta > 0 AND NOT ${GRANT}`, from),
    granted: n(`SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE created_at >= ? AND ${GRANT}`, from),
    consumed_all_time: n(`SELECT -COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE NOT ${GRANT}`),
  };

  const t = one('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cache FROM api_usage WHERE created_at >= ?', from);
  const api = {
    ...t,
    cost: round(t.cost),
    cost_all_time: round(one('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM api_usage').c),
    by_provider: all('SELECT provider, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(units) AS units, SUM(cost_usd) AS cost FROM api_usage WHERE created_at >= ? GROUP BY provider ORDER BY cost DESC', from),
    by_model: all('SELECT provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM api_usage WHERE created_at >= ? GROUP BY provider, model ORDER BY cost DESC', from),
    by_feature: all('SELECT feature, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens, SUM(cost_usd) AS cost FROM api_usage WHERE created_at >= ? GROUP BY feature ORDER BY cost DESC', from),
  };

  const econ = jobEconomics(from);
  const series = dayKeys(days).map((day) => ({ day, signups: 0, cost: 0, credits: 0, posts: 0 }));
  const byDay = new Map(series.map((s) => [s.day, s]));
  const fill = (rows, key) => rows.forEach((r) => { if (byDay.has(r.day)) byDay.get(r.day)[key] = r.v; });
  fill(all('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS v FROM users WHERE created_at >= ? GROUP BY day', from), 'signups');
  fill(all('SELECT substr(created_at, 1, 10) AS day, ROUND(SUM(cost_usd), 6) AS v FROM api_usage WHERE created_at >= ? GROUP BY day', from), 'cost');
  fill(all(`SELECT substr(created_at, 1, 10) AS day, -SUM(delta) AS v FROM credit_ledger WHERE created_at >= ? AND NOT ${GRANT} GROUP BY day`, from), 'credits');
  fill(all('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS v FROM posts WHERE created_at >= ? GROUP BY day', from), 'posts');

  res.json({
    range: { days, from },
    users,
    content,
    credits,
    api,
    economics: {
      usd_per_credit: perCredit(api.cost, credits.consumed),
      charged_cost: round(econ.jobs.reduce((s, j) => s + j.cost, 0)),
      uncharged_cost: round(econ.uncharged.reduce((s, j) => s + j.cost, 0)),
      ...econ,
    },
    series,
    top_users: all(`SELECT a.user_id AS id, u.email, u.name, u.plan, SUM(a.cost_usd) AS cost, COUNT(*) AS calls FROM api_usage a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.created_at >= ? GROUP BY a.user_id ORDER BY cost DESC LIMIT 8`, from),
  });
});

// ---------------------------------------------------------------- users
const USER_SORT = { created: 'u.created_at DESC', api_cost: 'api_cost DESC', credits_used: 'credits_used DESC', credits: 'u.credits DESC', name: 'u.name COLLATE NOCASE' };

router.get('/admin/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const plan = String(req.query.plan || '');
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = 50;
  const where = ['1 = 1'];
  const p = [];
  if (q) { where.push('(u.email LIKE ? OR u.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (PLANS[plan]) { where.push('u.plan = ?'); p.push(plan); }
  if (req.query.status === 'suspended') where.push('u.suspended = 1');
  const total = one(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, ...p).n;
  const rows = all(`SELECT u.*,
      (SELECT COUNT(*) FROM brands b WHERE b.owner_id = u.id) AS brands,
      (SELECT COUNT(*) FROM posts x JOIN brands b ON b.id = x.brand_id WHERE b.owner_id = u.id) AS posts,
      (SELECT -COALESCE(SUM(l.delta), 0) FROM credit_ledger l WHERE l.user_id = u.id AND NOT ${GRANT}) AS credits_used,
      (SELECT COALESCE(SUM(a.cost_usd), 0) FROM api_usage a WHERE a.user_id = u.id) AS api_cost,
      (SELECT MAX(l.created_at) FROM credit_ledger l WHERE l.user_id = u.id) AS last_activity
    FROM users u WHERE ${where.join(' AND ')} ORDER BY ${USER_SORT[req.query.sort] || USER_SORT.created} LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
  res.json({ total, page, pages: Math.max(1, Math.ceil(total / size)), users: rows.map((u) => ({ ...publicUser(u), api_cost: round(u.api_cost) })) });
});

router.get('/admin/users/:id', (req, res) => {
  const u = userOr404(req.params.id);
  res.json({
    user: publicUser(u),
    plan: planStatus(u),
    sessions: one('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', u.id, now()).n,
    brands: all(`SELECT b.id, b.name, b.created_at,
        (SELECT COUNT(*) FROM posts x WHERE x.brand_id = b.id) AS posts,
        (SELECT COUNT(*) FROM social_accounts s WHERE s.brand_id = b.id) AS channels,
        (SELECT COUNT(*) FROM brand_members m WHERE m.brand_id = b.id) AS members
      FROM brands b WHERE b.owner_id = ? ORDER BY b.created_at`, u.id),
    payments: all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', u.id),
    member_of: all("SELECT b.id, b.name, m.role FROM brand_members m JOIN brands b ON b.id = m.brand_id WHERE m.user_id = ? AND b.owner_id != ?", u.id, u.id),
    ledger: all('SELECT l.*, a.email AS by_email FROM credit_ledger l LEFT JOIN users a ON a.id = l.ref AND l.reason = \'admin_adjust\' WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 100', u.id),
    usage: all('SELECT provider, model, feature, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(units) AS units, SUM(cost_usd) AS cost FROM api_usage WHERE user_id = ? GROUP BY provider, model, feature ORDER BY cost DESC', u.id),
    totals: {
      api_cost: round(one('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM api_usage WHERE user_id = ?', u.id).c),
      credits_used: one(`SELECT -COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE user_id = ? AND NOT ${GRANT}`, u.id).n,
    },
  });
});

router.post('/admin/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const plan = req.body.plan || 'trial';
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Use at least 8 characters for the password.');
  if (!PLANS[plan]) throw new HttpError(400, 'Unknown plan.');
  if (one('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email already exists.');
  const credits = req.body.credits === undefined || req.body.credits === '' ? PLANS[plan].credits : Number(req.body.credits);
  if (!Number.isInteger(credits) || credits < 0) throw new HttpError(400, 'Credits must be a whole number of 0 or more.');
  const id = uuid();
  tx(() => {
    run('INSERT INTO users (id, email, name, password_hash, plan, plan_source, credits, credits_reset_at, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, email, name, hashPassword(password), plan, plan === 'trial' ? null : 'admin', credits, plan === 'trial' ? null : nextMonth(), req.body.is_admin ? 1 : 0);
    ledger(id, PLANS[plan].credits, plan === 'trial' ? 'trial_grant' : `plan:${plan}`);
    if (credits !== PLANS[plan].credits) ledger(id, credits - PLANS[plan].credits, 'admin_adjust', { by: req.user.id, note: 'Starting balance set by admin' });
  });
  res.status(201).json(publicUser(userOr404(id)));
});

router.patch('/admin/users/:id', (req, res) => {
  const u = userOr404(req.params.id);
  const self = u.id === req.user.id;
  const b = req.body;
  tx(() => {
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 120);
      if (!name) throw new HttpError(400, 'Name cannot be empty.');
      run('UPDATE users SET name = ? WHERE id = ?', name, u.id);
    }
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (one('SELECT id FROM users WHERE email = ? AND id != ?', email, u.id)) throw new HttpError(409, 'Another account already uses this email.');
      run('UPDATE users SET email = ? WHERE id = ?', email, u.id);
    }
    if (b.is_admin !== undefined) {
      if (self && !b.is_admin) throw new HttpError(400, 'You cannot remove your own admin access.');
      run('UPDATE users SET is_admin = ? WHERE id = ?', b.is_admin ? 1 : 0, u.id);
    }
    if (b.suspended !== undefined) {
      if (self && b.suspended) throw new HttpError(400, 'You cannot suspend your own account.');
      run('UPDATE users SET suspended = ? WHERE id = ?', b.suspended ? 1 : 0, u.id);
      // Suspending signs them out everywhere; API keys stop working through requireUser.
      if (b.suspended) run('DELETE FROM sessions WHERE user_id = ?', u.id);
    }
    if (b.plan !== undefined) {
      if (!PLANS[b.plan]) throw new HttpError(400, 'Unknown plan.');
      // A plan change starts a fresh cycle (for trials, a fresh trial) and refills to the plan's credits.
      const credits = b.keep_credits ? one('SELECT credits FROM users WHERE id = ?', u.id).credits : PLANS[b.plan].credits;
      const before = one('SELECT credits FROM users WHERE id = ?', u.id).credits;
      // An admin-assigned plan refills monthly on its own, outside any payment subscription.
      run('UPDATE users SET plan = ?, plan_source = ?, billing_status = NULL, paid_until = NULL, plan_started_at = ?, credits = ?, credits_reset_at = ? WHERE id = ?', b.plan, b.plan === 'trial' ? null : 'admin', now(), credits, b.plan === 'trial' ? null : nextMonth(), u.id);
      ledger(u.id, credits - before, `plan:${b.plan}`, { by: req.user.id, note: 'Plan changed by admin' });
    }
    if (b.credits !== undefined) {
      const credits = Number(b.credits);
      if (!Number.isInteger(credits) || credits < 0 || credits > 10_000_000) throw new HttpError(400, 'Credits must be a whole number from 0 to 10,000,000.');
      const before = one('SELECT credits FROM users WHERE id = ?', u.id).credits;
      if (credits !== before) {
        run('UPDATE users SET credits = ? WHERE id = ?', credits, u.id);
        ledger(u.id, credits - before, 'admin_adjust', { by: req.user.id, note: String(b.note || 'Balance set by admin').slice(0, 300) });
      }
    }
  });
  res.json(publicUser(userOr404(u.id)));
});

router.post('/admin/users/:id/credits', (req, res) => {
  const u = userOr404(req.params.id);
  const delta = Number(req.body.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000_000) throw new HttpError(400, 'Enter a whole number of credits to add (or a negative number to remove).');
  if (u.credits + delta < 0) throw new HttpError(400, `This account has ${u.credits} credits, so you can remove at most ${u.credits}.`);
  tx(() => {
    run('UPDATE users SET credits = credits + ? WHERE id = ?', delta, u.id);
    ledger(u.id, delta, 'admin_adjust', { by: req.user.id, note: String(req.body.note || '').slice(0, 300) || null });
  });
  res.json({ ok: true, credits: u.credits + delta });
});

// Deletes the account, every brand it owns (with posts, media and channels) and its sessions.
// Its API usage rows stay, so spend history remains complete.
router.delete('/admin/users/:id', (req, res) => {
  const u = userOr404(req.params.id);
  if (u.id === req.user.id) throw new HttpError(400, 'You cannot delete your own account from the admin dashboard.');
  for (const b of all('SELECT id FROM brands WHERE owner_id = ?', u.id)) deleteBrand(b.id);
  run('DELETE FROM users WHERE id = ?', u.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- payments
router.get('/admin/payments', (req, res) => {
  const { days, from } = windowOf(req);
  res.json({
    days,
    payments: all('SELECT p.*, u.email, u.name FROM payments p JOIN users u ON u.id = p.user_id WHERE p.created_at >= ? ORDER BY p.created_at DESC LIMIT 500', from),
    revenue: all("SELECT currency, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE status = 'succeeded' AND created_at >= ? GROUP BY currency", from),
  });
});

// ---------------------------------------------------------------- API usage
router.get('/admin/usage', (req, res) => {
  const { days, from } = windowOf(req);
  const where = ['a.created_at >= ?'];
  const p = [from];
  for (const k of ['provider', 'feature', 'model']) if (req.query[k]) { where.push(`a.${k} = ?`); p.push(String(req.query[k])); }
  if (req.query.user) { where.push('a.user_id = ?'); p.push(String(req.query.user)); }
  const w = where.join(' AND ');
  const series = dayKeys(days).map((day) => ({ day, cost: 0, calls: 0, tokens: 0 }));
  const byDay = new Map(series.map((s) => [s.day, s]));
  for (const r of all(`SELECT substr(a.created_at, 1, 10) AS day, SUM(a.cost_usd) AS cost, COUNT(*) AS calls, SUM(a.input_tokens + a.output_tokens) AS tokens FROM api_usage a WHERE ${w} GROUP BY day`, ...p)) {
    if (byDay.has(r.day)) Object.assign(byDay.get(r.day), { cost: round(r.cost), calls: r.calls, tokens: r.tokens });
  }
  res.json({
    range: { days, from },
    series,
    totals: one(`SELECT COUNT(*) AS calls, COALESCE(SUM(a.cost_usd), 0) AS cost, COALESCE(SUM(a.input_tokens), 0) AS input, COALESCE(SUM(a.output_tokens), 0) AS output,
      COALESCE(SUM(a.cache_read_tokens), 0) AS cache_read, COALESCE(SUM(a.cache_write_tokens), 0) AS cache_write FROM api_usage a WHERE ${w}`, ...p),
    by_model: all(`SELECT a.provider, a.model, COUNT(*) AS calls, SUM(a.input_tokens) AS input, SUM(a.output_tokens) AS output, SUM(a.cache_read_tokens) AS cache_read, SUM(a.units) AS units, SUM(a.cost_usd) AS cost
      FROM api_usage a WHERE ${w} GROUP BY a.provider, a.model ORDER BY cost DESC`, ...p),
    by_feature: all(`SELECT a.provider, a.feature, COUNT(*) AS calls, SUM(a.input_tokens) AS input, SUM(a.output_tokens) AS output, SUM(a.units) AS units, SUM(a.cost_usd) AS cost,
      AVG(a.cost_usd) AS avg_cost FROM api_usage a WHERE ${w} GROUP BY a.provider, a.feature ORDER BY cost DESC`, ...p),
    by_user: all(`SELECT a.user_id AS id, u.email, u.name, u.plan, COUNT(*) AS calls, SUM(a.input_tokens + a.output_tokens) AS tokens, SUM(a.cost_usd) AS cost
      FROM api_usage a LEFT JOIN users u ON u.id = a.user_id WHERE ${w} GROUP BY a.user_id ORDER BY cost DESC LIMIT 25`, ...p),
    recent: all(`SELECT a.*, u.email FROM api_usage a LEFT JOIN users u ON u.id = a.user_id WHERE ${w} ORDER BY a.created_at DESC LIMIT 100`, ...p),
    filters: {
      providers: all('SELECT DISTINCT provider FROM api_usage ORDER BY provider').map((r) => r.provider),
      features: all('SELECT DISTINCT feature FROM api_usage ORDER BY feature').map((r) => r.feature),
    },
  });
});

// ---------------------------------------------------------------- credit ledger
router.get('/admin/ledger', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = 100;
  const where = ['1 = 1'];
  const p = [];
  const q = String(req.query.q || '').trim();
  if (q) { where.push('(u.email LIKE ? OR u.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (req.query.kind === 'grants') where.push(GRANT.replaceAll('reason', 'l.reason'));
  if (req.query.kind === 'spend') where.push(`NOT ${GRANT.replaceAll('reason', 'l.reason')}`);
  if (req.query.kind === 'admin') where.push("l.reason = 'admin_adjust'");
  const w = where.join(' AND ');
  const total = one(`SELECT COUNT(*) AS n FROM credit_ledger l JOIN users u ON u.id = l.user_id WHERE ${w}`, ...p).n;
  const rows = all(`SELECT l.*, u.email, u.name, b.name AS brand_name, a.email AS by_email FROM credit_ledger l
      JOIN users u ON u.id = l.user_id LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN users a ON a.id = l.ref AND l.reason = 'admin_adjust'
    WHERE ${w} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
  res.json({ total, page, pages: Math.max(1, Math.ceil(total / size)), rows });
});

// ---------------------------------------------------------------- pricing
// Typical tokens per Claude call before there is measured data (writer prompts include the brand kit).
const TYPICAL = { write_post: { input: 3000, output: 1200 }, chat_message: { input: 2500, output: 900 }, ad_concepts: { input: 2000, output: 1500 } };

router.get('/admin/pricing', (req, res) => {
  const { days, from } = windowOf({ query: { days: req.query.days || 90 } });
  const prices = priceList();
  const writer = config.anthropicModel;
  const claude = (k) => claudeCost(writer, { ...TYPICAL[k], cacheRead: 0, cacheWrite: 0 });
  const est = (label, credits, cost, basis) => ({ label, credits, cost: round(cost), usd_per_credit: perCredit(cost, credits), basis });
  const imageCost = openaiImageCost(null);
  const estimates = [
    est('Image post', CREDIT_COSTS.image, claude('write_post'), 'One Claude call to write the post; stock photos are free'),
    est('Carousel (5 slides)', CREDIT_COSTS.image + CREDIT_COSTS.carousel_slide * 4, claude('write_post'), 'One Claude call; slides render on the server'),
    est('Video post', CREDIT_COSTS.video, claude('write_post'), 'One Claude call; video renders on the server'),
    est('Voiceover video', CREDIT_COSTS.voiceover_video, claude('write_post'), 'One Claude call; on-device voiceover is free'),
    est('Avatar video (60 s)', CREDIT_COSTS.avatar_video, claude('write_post') + heygenCost(60), `Claude script + HeyGen at $${config.heygenUsdPerMinute}/min`),
    est('AI image add-on', CREDIT_COSTS.ai_image, imageCost, `${config.openaiImageModel}, ${config.openaiImageUsd != null ? 'flat price from OPENAI_IMAGE_USD' : 'typical price per image'}`),
    est('Idea Lab message', CREDIT_COSTS.chat_message, claude('chat_message'), 'One streamed Claude reply'),
    est('Ad concepts', CREDIT_COSTS.ad_concepts, claude('ad_concepts'), 'One Claude call'),
  ];
  const econ = jobEconomics(from);
  const measuredCost = econ.jobs.reduce((s, j) => s + j.cost, 0) + econ.uncharged.reduce((s, j) => s + j.cost, 0);
  const measuredCredits = econ.jobs.reduce((s, j) => s + j.credits, 0);
  res.json({
    prices,
    credit_costs: CREDIT_COSTS,
    typical_tokens: TYPICAL,
    estimates,
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, price: p.price, credits: p.credits, usd_per_credit: perCredit(p.price, p.credits) })),
    measured: { days, usd_per_credit: perCredit(measuredCost, measuredCredits), cost: round(measuredCost), credits: measuredCredits, ...econ },
  });
});
