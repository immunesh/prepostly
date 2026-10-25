import crypto from 'node:crypto';
import { Router } from 'express';
import { one, all, run, uuid, now, insert } from '../db.js';
import { HttpError, requireUser, brandFor, sha256 } from '../auth.js';
import { PLANS, ROLES } from '../catalog.js';
import { planStatus, refreshCredits, usageThisMonth } from '../credits.js';
import { notify } from '../notify.js';
import { purchasablePlans, paymentsFor } from '../billing.js';
import { publicBrand } from './auth.js';

// Team members and roles, account/plan/credits, API keys and notifications.

export const router = Router();
router.use(requireUser);

// ---------------------------------------------------------------- team
router.get('/team', (req, res) => {
  const brand = brandFor(req);
  res.json({
    members: all('SELECT u.id, u.name, u.email, m.role, m.created_at FROM brand_members m JOIN users u ON u.id = m.user_id WHERE m.brand_id = ? ORDER BY m.created_at', brand.id),
    invites: all('SELECT id, email, role, created_at, token FROM invites WHERE brand_id = ? AND accepted_at IS NULL ORDER BY created_at', brand.id),
    roles: ROLES,
  });
});

router.post('/team/invite', (req, res) => {
  const brand = brandFor(req, 'admin');
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role || 'editor';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!['admin', 'editor', 'reviewer'].includes(role)) throw new HttpError(400, 'Role must be admin, editor or reviewer.');
  if (role === 'admin' && req.role !== 'owner') throw new HttpError(403, 'Only the owner can add admins.');
  const existing = one('SELECT * FROM users WHERE email = ?', email);
  if (existing) {
    if (one('SELECT 1 FROM brand_members WHERE brand_id = ? AND user_id = ?', brand.id, existing.id)) throw new HttpError(409, `${email} is already on this brand.`);
    run('INSERT INTO brand_members (brand_id, user_id, role) VALUES (?, ?, ?)', brand.id, existing.id, role);
    notify(existing.id, brand.id, 'brand_shared', `${req.user.name} added you to ${brand.name}`, `You are now ${role === 'admin' ? 'an' : 'a'} ${role}.`, '/app/dashboard');
    return res.status(201).json({ added: true });
  }
  const token = crypto.randomBytes(20).toString('base64url');
  run('DELETE FROM invites WHERE brand_id = ? AND email = ? AND accepted_at IS NULL', brand.id, email);
  insert('invites', { id: uuid(), brand_id: brand.id, email, role, token, invited_by: req.user.id });
  // No email delivery: the link is returned so it can be shared directly.
  res.status(201).json({ invited: true, link: `/signup?invite=${token}&email=${encodeURIComponent(email)}` });
});

router.delete('/team/invites/:id', (req, res) => {
  const brand = brandFor(req, 'admin');
  run('DELETE FROM invites WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  res.json({ ok: true });
});

router.patch('/team/:userId', (req, res) => {
  const brand = brandFor(req, 'admin');
  const m = one('SELECT * FROM brand_members WHERE brand_id = ? AND user_id = ?', brand.id, req.params.userId);
  if (!m) throw new HttpError(404, 'Member not found.');
  if (m.role === 'owner') throw new HttpError(403, "The owner's role can't be changed.");
  if (!['admin', 'editor', 'reviewer'].includes(req.body.role)) throw new HttpError(400, 'Role must be admin, editor or reviewer.');
  if ((req.body.role === 'admin' || m.role === 'admin') && req.role !== 'owner') throw new HttpError(403, 'Only the owner can change admins.');
  run('UPDATE brand_members SET role = ? WHERE brand_id = ? AND user_id = ?', req.body.role, brand.id, m.user_id);
  res.json({ ok: true });
});

router.delete('/team/:userId', (req, res) => {
  const self = req.params.userId === req.user.id;
  const brand = brandFor(req, self ? 'reviewer' : 'admin');
  const m = one('SELECT * FROM brand_members WHERE brand_id = ? AND user_id = ?', brand.id, req.params.userId);
  if (!m) throw new HttpError(404, 'Member not found.');
  if (m.role === 'owner') throw new HttpError(403, 'The owner cannot be removed. Delete the brand instead.');
  if (m.role === 'admin' && !self && req.role !== 'owner') throw new HttpError(403, 'Only the owner can remove admins.');
  run('DELETE FROM brand_members WHERE brand_id = ? AND user_id = ?', brand.id, m.user_id);
  res.json({ ok: true });
});

/** Team & Brands overview across everything the user can access. */
router.get('/team/overview', (req, res) => {
  const brands = all('SELECT b.*, m.role FROM brands b JOIN brand_members m ON m.brand_id = b.id WHERE m.user_id = ? ORDER BY b.created_at', req.user.id).map((b) => ({
    ...publicBrand(b),
    members: one('SELECT COUNT(*) AS n FROM brand_members WHERE brand_id = ?', b.id).n,
    channels: one('SELECT COUNT(*) AS n FROM social_accounts WHERE brand_id = ?', b.id).n,
    posts: one('SELECT COUNT(*) AS n FROM posts WHERE brand_id = ?', b.id).n,
    storage: one('SELECT COALESCE(SUM(size),0) AS n FROM uploads WHERE brand_id = ?', b.id).n,
    owner: one('SELECT name, email FROM users WHERE id = ?', b.owner_id),
  }));
  const mine = brands.filter((b) => b.owner_id === req.user.id);
  res.json({
    brands,
    stats: {
      active_brands: mine.filter((b) => b.active).length,
      brand_limit: (PLANS[req.user.plan] || PLANS.trial).brands,
      team_members: one('SELECT COUNT(DISTINCT m.user_id) AS n FROM brand_members m JOIN brands b ON b.id = m.brand_id WHERE b.owner_id = ? AND m.user_id != ?', req.user.id, req.user.id).n,
      shared_with_me: brands.length - mine.length,
      connected_channels: mine.reduce((s, b) => s + b.channels, 0),
      storage_bytes: mine.reduce((s, b) => s + b.storage, 0),
    },
  });
});

// ---------------------------------------------------------------- account & plan
router.get('/account', (req, res) => {
  const user = refreshCredits(req.user.id);
  res.json({
    plan: planStatus(user),
    credits: user.credits,
    credits_reset_at: user.credits_reset_at,
    usage: {
      competitor_runs: usageThisMonth(user.id, 'competitor_run'),
      posts_this_month: one("SELECT COUNT(*) AS n FROM posts p JOIN brands b ON b.id = p.brand_id WHERE b.owner_id = ? AND p.created_at >= ?", user.id, `${now().slice(0, 7)}-01`).n,
      credits_by_reason: all("SELECT reason, -SUM(delta) AS credits FROM credit_ledger WHERE user_id = ? AND delta < 0 AND created_at >= ? GROUP BY reason ORDER BY credits DESC", user.id, `${now().slice(0, 7)}-01`),
    },
    ledger: all('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', user.id),
    plans: PLANS,
    // Plans are bought through checkout when it's set up; otherwise a site admin assigns them.
    checkout_plans: purchasablePlans(),
    payments: paymentsFor(user.id),
  });
});

// ---------------------------------------------------------------- API keys
router.get('/api-keys', (req, res) => {
  const brand = brandFor(req, 'admin');
  res.json(all('SELECT id, name, key_hint, last_used_at, created_at FROM api_keys WHERE brand_id = ? AND user_id = ? ORDER BY created_at DESC', brand.id, req.user.id));
});
router.post('/api-keys', (req, res) => {
  const brand = brandFor(req, 'admin');
  const key = `cd_${crypto.randomBytes(24).toString('base64url')}`;
  const row = insert('api_keys', { id: uuid(), user_id: req.user.id, brand_id: brand.id, name: String(req.body.name || 'API key').slice(0, 60), key_hash: sha256(key), key_hint: `${key.slice(0, 6)}…${key.slice(-4)}` });
  res.status(201).json({ id: row.id, name: row.name, key, key_hint: row.key_hint });
});
router.delete('/api-keys/:id', (req, res) => {
  run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- notifications
router.get('/notifications', (req, res) => {
  res.json(all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', req.user.id).map((n) => ({ ...n, read: Boolean(n.read) })));
});
router.post('/notifications/read', (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

