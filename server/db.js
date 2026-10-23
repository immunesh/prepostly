import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const dbFile = path.join(config.dataDir, 'prepostly.db');
// The app used to be called Cuedis AI; carry an existing database over to the new name.
const oldFile = path.join(config.dataDir, 'cuedis.db');
if (!fs.existsSync(dbFile) && fs.existsSync(oldFile)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(oldFile + ext)) fs.renameSync(oldFile + ext, dbFile + ext);
}
export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  plan_started_at ${TS},
  credits INTEGER NOT NULL DEFAULT 0,
  credits_reset_at TEXT,
  current_brand_id TEXT,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'Friendly',
  language TEXT NOT NULL DEFAULT 'English',
  colors TEXT NOT NULL DEFAULT '[]',
  palettes TEXT NOT NULL DEFAULT '[]',
  gradient TEXT NOT NULL DEFAULT '[]',
  font_heading TEXT NOT NULL DEFAULT 'Poppins',
  font_body TEXT NOT NULL DEFAULT 'Inter',
  text_case TEXT NOT NULL DEFAULT 'default',
  logo_light TEXT,
  logo_dark TEXT,
  handle TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  voice TEXT NOT NULL DEFAULT 'af_heart',
  ethnicity TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS brand_members (
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','reviewer')),
  created_at ${TS},
  PRIMARY KEY (brand_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at ${TS},
  accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  media_type TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generating',
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '{}',
  caption TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',
  cover TEXT,
  template TEXT NOT NULL DEFAULT 'bold',
  language TEXT NOT NULL DEFAULT 'English',
  parent_id TEXT,
  autopilot_id TEXT,
  share_id TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  caption_rewrites INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  writer TEXT NOT NULL DEFAULT '',
  error TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at ${TS},
  updated_at ${TS}
);
CREATE INDEX IF NOT EXISTS posts_brand ON posts(brand_id, created_at);
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at ${TS},
  UNIQUE (brand_id, platform, external_id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  verifier TEXT,
  redirect_uri TEXT NOT NULL,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}',
  reviewers TEXT NOT NULL DEFAULT '[]',
  review_note TEXT,
  reviewed_by TEXT,
  autopilot_id TEXT,
  created_at ${TS},
  updated_at ${TS}
);
CREATE INDEX IF NOT EXISTS jobs_brand ON publish_jobs(brand_id, scheduled_at);
CREATE TABLE IF NOT EXISTS publish_targets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  caption TEXT,
  external_id TEXT,
  url TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  published_at TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  metrics_at TEXT
);
CREATE INDEX IF NOT EXISTS targets_status ON publish_targets(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  action TEXT,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS account_metrics (
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  followers INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  created_at ${TS},
  updated_at ${TS}
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '{}',
  posts TEXT NOT NULL DEFAULT '[]',
  analysis TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new',
  error TEXT,
  last_run_at TEXT,
  created_at ${TS},
  UNIQUE (brand_id, platform, handle)
);
CREATE TABLE IF NOT EXISTS ad_trackers (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  page_id TEXT,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  ads TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new',
  error TEXT,
  last_run_at TEXT,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS autopilots (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'topics',
  direction TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  post_types TEXT NOT NULL DEFAULT '["single_image","carousel"]',
  days TEXT NOT NULL DEFAULT '[1,3,5]',
  times TEXT NOT NULL DEFAULT '["10:00"]',
  account_ids TEXT NOT NULL DEFAULT '[]',
  require_approval INTEGER NOT NULL DEFAULT 1,
  format TEXT NOT NULL DEFAULT 'ig_portrait',
  horizon_days INTEGER NOT NULL DEFAULT 7,
  next_run_at TEXT,
  last_run_at TEXT,
  last_error TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  compare_at_price TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  posted_count INTEGER NOT NULL DEFAULT 0,
  created_at ${TS},
  UNIQUE (brand_id, external_id)
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  post_type TEXT NOT NULL,
  template TEXT NOT NULL,
  format TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id TEXT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id TEXT,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 1,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  last_used_at TEXT,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS data_deletions (
  code TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at ${TS}
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at ${TS}
);
`);

// Columns added after their table was first created.
function addColumn(table, column, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('autopilots', 'horizon_days', 'INTEGER NOT NULL DEFAULT 7');

// ---------- query helpers ----------
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const shortId = (n = 10) => crypto.randomBytes(n).toString('base64url').slice(0, n);

let depth = 0;
/** Run fn inside a transaction (nested calls join the outer one). */
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const json = (s, d = null) => {
  if (s == null || s === '') return d;
  try { return JSON.parse(s); } catch { return d; }
};

/** Insert a row from an object. */
/** Delete a brand with everything in it, including its uploads and rendered media on disk. */
export function deleteBrand(brandId) {
  fs.rmSync(path.join(config.dataDir, 'uploads', brandId), { recursive: true, force: true });
  for (const p of all('SELECT id FROM posts WHERE brand_id = ?', brandId)) fs.rmSync(path.join(config.dataDir, 'media', p.id), { recursive: true, force: true });
  run('DELETE FROM brands WHERE id = ?', brandId);
  // Teammates who had it open move to another brand they belong to.
  run('UPDATE users SET current_brand_id = (SELECT brand_id FROM brand_members m WHERE m.user_id = users.id LIMIT 1) WHERE current_brand_id = ?', brandId);
}

export function insert(table, row) {
  const keys = Object.keys(row);
  const vals = keys.map((k) => (row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k] ?? null));
  run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...vals);
  return row;
}

/** Update a row by id from an object of columns. */
export function update(table, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const vals = keys.map((k) => (patch[k] !== null && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k] ?? null));
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...vals, id);
}
