import { Router } from 'express';
import { one, all, run, uuid, now, tx, json, deleteBrand } from '../db.js';
import { config } from '../config.js';
import { HttpError, hashPassword, verifyPassword, createSession, destroySession, requireUser, userFromSession, isAdmin } from '../auth.js';
import { PLANS } from '../catalog.js';
import { planStatus, refreshCredits } from '../credits.js';
import { llmAvailable, writerName } from '../engines/llm.js';
import { stockAvailable, aiImagesAvailable } from '../engines/images.js';
import { ttsStatus } from '../engines/tts.js';
import { avatarAvailable } from '../engines/avatar.js';

export const router = Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Join brands this email was invited to. */
function acceptPendingInvites(user) {
  for (const inv of all('SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL', user.email)) {
    run('INSERT OR IGNORE INTO brand_members (brand_id, user_id, role) VALUES (?, ?, ?)', inv.brand_id, user.id, inv.role);
    run('UPDATE invites SET accepted_at = ? WHERE id = ?', now(), inv.id);
  }
}

router.post('/auth/signup', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name) throw new HttpError(400, 'Enter your name.');
  if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Use at least 8 characters for your password.');
  if (one('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
  const id = uuid();
  tx(() => {
    run('INSERT INTO users (id, email, name, password_hash, plan, credits) VALUES (?, ?, ?, ?, ?, ?)', id, email, name, hashPassword(password), 'trial', PLANS.trial.credits);
    run('INSERT INTO credit_ledger (id, user_id, delta, reason) VALUES (?, ?, ?, ?)', uuid(), id, PLANS.trial.credits, 'trial_grant');
  });
  const user = one('SELECT * FROM users WHERE id = ?', id);
  acceptPendingInvites(user);
  const shared = one('SELECT brand_id FROM brand_members WHERE user_id = ? LIMIT 1', id);
  if (shared) run('UPDATE users SET current_brand_id = ? WHERE id = ?', shared.brand_id, id);
  createSession(res, id);
  res.status(201).json({ ok: true });
});

router.post('/auth/login', (req, res) => {
  const user = one('SELECT * FROM users WHERE email = ?', String(req.body.email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
  if (user.suspended) throw new HttpError(403, 'This account is suspended. Contact support.', 'suspended');
  acceptPendingInvites(user);
  createSession(res, user.id);
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

export function brandsFor(userId) {
  return all(`SELECT b.*, m.role FROM brands b JOIN brand_members m ON m.brand_id = b.id WHERE m.user_id = ? ORDER BY b.created_at`, userId).map(publicBrand);
}

export function publicBrand(b) {
  return { ...b, colors: json(b.colors, []), palettes: json(b.palettes, []), gradient: json(b.gradient, []), settings: json(b.settings, {}), active: Boolean(b.active) };
}

// Anonymous visitors get null (not 401) so the web app can check the session quietly.
router.get('/me', (req, res, next) => (userFromSession(req) ? requireUser(req, res, next) : res.json(null)), (req, res) => {
  const user = refreshCredits(req.user.id);
  const brands = brandsFor(user.id);
  let current = brands.find((b) => b.id === user.current_brand_id) || brands[0] || null;
  if (current && current.id !== user.current_brand_id) run('UPDATE users SET current_brand_id = ? WHERE id = ?', current.id, user.id);
  // Credits are spent from the current brand owner's balance.
  const payer = current ? refreshCredits(current.owner_id) : user;
  res.json({
    user: { id: user.id, name: user.name, email: user.email, created_at: user.created_at, is_admin: isAdmin(user) },
    plan: planStatus(user),
    credits: user.credits,
    brand_credits: payer.credits,
    brand_plan: planStatus(payer),
    brands,
    brand: current,
    unread: one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', user.id).n,
    capabilities: {
      writer: writerName(),
      llm: llmAvailable(),
      stock: stockAvailable(),
      ai_images: aiImagesAvailable(),
      voiceover: ttsStatus.state,
      avatar_video: avatarAvailable(),
      public_url: config.publicUrl || null,
      billing: config.billingMode,
    },
  });
});

// Deletes the account, every brand it owns (with posts, media and connected channels) and its sessions.
// Brands it only belongs to stay with their owners.
router.delete('/me', requireUser, (req, res) => {
  if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash)) throw new HttpError(400, 'Your password is incorrect.');
  for (const b of all('SELECT id FROM brands WHERE owner_id = ?', req.user.id)) deleteBrand(b.id);
  destroySession(req, res);
  run('DELETE FROM users WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

router.patch('/me', requireUser, (req, res) => {
  const { name, current_brand_id, password, new_password } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) throw new HttpError(400, 'Name cannot be empty.');
    run('UPDATE users SET name = ? WHERE id = ?', String(name).trim(), req.user.id);
  }
  if (current_brand_id !== undefined) {
    if (!one('SELECT 1 FROM brand_members WHERE brand_id = ? AND user_id = ?', current_brand_id, req.user.id)) throw new HttpError(404, 'Brand not found.');
    run('UPDATE users SET current_brand_id = ? WHERE id = ?', current_brand_id, req.user.id);
  }
  if (new_password !== undefined) {
    if (!verifyPassword(String(password || ''), req.user.password_hash)) throw new HttpError(400, 'Your current password is incorrect.');
    if (String(new_password).length < 8) throw new HttpError(400, 'Use at least 8 characters for your password.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(new_password)), req.user.id);
  }
  res.json({ ok: true });
});
