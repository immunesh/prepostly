import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, run } from './db.js';
import { config } from './config.js';

export const SESSION_COOKIE = 'cd_session';
const SESSION_DAYS = 30;
const ROLE_RANK = { reviewer: 1, editor: 2, admin: 3, owner: 4 };

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || ({ 400: 'invalid_request', 401: 'unauthenticated', 402: 'insufficient_credits', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'limit_reached' }[status] || 'server_error');
  }
}

// ---------- passwords ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

// ---------- secrets at rest (social tokens) ----------
let key = null;
function secretKey() {
  if (key) return key;
  let secret = config.secret;
  if (!secret) {
    const file = path.join(config.dataDir, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(file, 'utf8').trim();
  }
  key = crypto.createHash('sha256').update(secret).digest();
  return key;
}
/** Encrypt a string with AES-256-GCM. */
export function seal(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function unseal(sealed) {
  if (!sealed) return null;
  const [v, iv, tag, enc] = String(sealed).split('.');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ---------- sessions ----------
export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires.toISOString());
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd && config.publicUrl.startsWith('https'), expires, path: '/' });
  return token;
}
export function destroySession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
export function userFromSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = one('SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha256(token));
  if (!row) return null;
  if (row.session_expires < new Date().toISOString()) {
    run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    return null;
  }
  return row;
}

// ---------- API keys ----------
export function userFromApiKey(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^(?:Bearer|Token)\s+(cd_[A-Za-z0-9_-]+)$/);
  const raw = m?.[1] || req.headers['x-api-key'];
  if (!raw) return null;
  const k = one('SELECT * FROM api_keys WHERE key_hash = ?', sha256(raw));
  if (!k) return null;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', new Date().toISOString(), k.id);
  const user = one('SELECT * FROM users WHERE id = ?', k.user_id);
  return user ? { user, brandId: k.brand_id, keyId: k.id } : null;
}

// ---------- middleware ----------
export function requireUser(req, _res, next) {
  const user = userFromSession(req);
  if (user) {
    req.user = user;
    return next();
  }
  const viaKey = userFromApiKey(req);
  if (viaKey) {
    req.user = viaKey.user;
    req.apiBrandId = viaKey.brandId;
    return next();
  }
  next(new HttpError(401, 'Sign in to continue.'));
}

/** The caller's role on a brand, or null. */
export function roleOn(userId, brandId) {
  return one('SELECT role FROM brand_members WHERE brand_id = ? AND user_id = ?', brandId, userId)?.role || null;
}
export const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= ROLE_RANK[min];

/**
 * Resolve the active brand for a request (header X-Brand-Id, API key brand, or the
 * user's current brand) and check the caller holds at least `min` role on it.
 */
export function brandFor(req, min = 'reviewer') {
  const id = req.apiBrandId || req.get('x-brand-id') || req.query.brand_id || req.user.current_brand_id;
  if (!id) throw new HttpError(400, 'No brand selected. Create a brand first.', 'no_brand');
  const brand = one('SELECT * FROM brands WHERE id = ?', id);
  const role = brand && roleOn(req.user.id, brand.id);
  if (!brand || !role) throw new HttpError(404, 'Brand not found.');
  if (!atLeast(role, min)) throw new HttpError(403, `This action needs the ${min} role or higher on ${brand.name}.`);
  req.role = role;
  return brand;
}
