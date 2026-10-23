import { one, all, run, uuid, json, now, update } from '../db.js';
import { seal, unseal, HttpError } from '../auth.js';
import { PLATFORMS } from '../catalog.js';
import { facebook, instagram, threads } from './meta.js';
import { linkedin, linkedin_page } from './linkedin.js';
import { x } from './x.js';
import { pinterest } from './pinterest.js';
import { youtube, google_business } from './google.js';
import { tiktok } from './tiktok.js';
import { bluesky, mastodon, telegram, sandbox } from './token.js';
import { PublishError, postMedia } from './common.js';

export const ADAPTERS = { facebook, instagram, threads, linkedin, linkedin_page, x, pinterest, youtube, tiktok, google_business, bluesky, mastodon, telegram, sandbox };

export function adapter(platform) {
  const a = ADAPTERS[platform];
  if (!a) throw new HttpError(400, `Unknown platform "${platform}".`);
  return a;
}

/** Platforms with whether this server can connect them. */
export function platformList() {
  return Object.entries(PLATFORMS).map(([id, p]) => ({ id, ...p, configured: ADAPTERS[id].configured(), fields: p.fields?.map(({ key, label, secret }) => ({ key, label, secret: Boolean(secret) })) }));
}

/** Account row with tokens decrypted (server-side only). */
export function accountWithTokens(row) {
  return { ...row, meta: json(row.meta, {}), access_token: unseal(row.access_token), refresh_token: unseal(row.refresh_token) };
}

/** Public shape of an account (no tokens). */
export function publicAccount(row) {
  const meta = json(row.meta, {});
  const expiresSoon = row.token_expires_at && row.token_expires_at < new Date(Date.now() + 3 * 864e5).toISOString() && !row.refresh_token;
  return {
    id: row.id, platform: row.platform, name: row.name, username: row.username, avatar: row.avatar, status: row.status,
    followers: meta.followers ?? null, boards: meta.boards, board_id: meta.board_id, created_at: row.created_at, needs_relink: row.status === 'relink' || Boolean(expiresSoon),
  };
}

/** Save accounts returned by an adapter (upsert by platform + external id). */
export function saveAccounts(brandId, platform, accounts) {
  const saved = [];
  for (const a of accounts) {
    const existing = one('SELECT id FROM social_accounts WHERE brand_id = ? AND platform = ? AND external_id = ?', brandId, platform, a.external_id);
    const row = {
      name: a.name, username: a.username || '', avatar: a.avatar || null, access_token: seal(a.access_token), refresh_token: seal(a.refresh_token),
      token_expires_at: a.token_expires_at || null, meta: JSON.stringify(a.meta || {}), status: 'active',
    };
    if (existing) {
      update('social_accounts', existing.id, row);
      saved.push(existing.id);
    } else {
      const id = uuid();
      run('INSERT INTO social_accounts (id, brand_id, platform, external_id, name, username, avatar, access_token, refresh_token, token_expires_at, meta, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id, brandId, platform, a.external_id, row.name, row.username, row.avatar, row.access_token, row.refresh_token, row.token_expires_at, row.meta, row.status);
      saved.push(id);
    }
  }
  return saved;
}

/** Refresh an account's token when it is close to expiry. */
async function ensureFresh(account) {
  const a = ADAPTERS[account.platform];
  if (!a.refresh || !account.token_expires_at) return account;
  if (account.token_expires_at > new Date(Date.now() + 10 * 60 * 1000).toISOString()) return account;
  const t = await a.refresh(account);
  run('UPDATE social_accounts SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?', seal(t.access_token), seal(t.refresh_token ?? account.refresh_token), t.token_expires_at || null, account.id);
  return { ...account, ...t };
}

/** Publish one target (one post to one account). Throws PublishError on failure. */
export async function publishTarget(targetId) {
  const target = one('SELECT * FROM publish_targets WHERE id = ?', targetId);
  const job = one('SELECT * FROM publish_jobs WHERE id = ?', target.job_id);
  const post = one('SELECT * FROM posts WHERE id = ?', job.post_id);
  const row = one('SELECT * FROM social_accounts WHERE id = ?', target.account_id);
  if (!post || post.status !== 'ready') throw new PublishError('The post is not ready to publish.');
  if (!row) throw new PublishError('The social account was removed.');
  if (row.status === 'relink') throw new PublishError(`${PLATFORMS[row.platform].label} needs to be relinked.`, { relink: true });
  const p = { ...post, media: json(post.media, []), content: json(post.content, {}) };
  const options = json(job.options, {});
  const media = options.text_only ? [] : postMedia(p);
  const supported = PLATFORMS[row.platform].media;
  const kind = !media.length ? 'text' : media[0].kind === 'video' ? 'video' : media.length > 1 ? 'carousel' : 'image';
  if (!supported.includes(kind)) throw new PublishError(`${PLATFORMS[row.platform].label} does not support ${kind} posts.`);
  let account = accountWithTokens(row);
  try {
    account = await ensureFresh(account);
  } catch (e) {
    run("UPDATE social_accounts SET status = 'relink' WHERE id = ?", row.id);
    throw e instanceof PublishError ? new PublishError(e.message, { relink: true }) : e;
  }
  const caption = target.caption ?? job.caption ?? p.caption;
  const hashtags = options.include_hashtags === false ? '' : p.hashtags;
  try {
    return await adapter(row.platform).publish({ account, media, caption, hashtags, options: { ...options, ...(options.per_platform?.[row.platform] || {}) }, title: p.title, cover: p.cover, post: p, targetId });
  } catch (e) {
    if (e.relink) run("UPDATE social_accounts SET status = 'relink' WHERE id = ?", row.id);
    throw e;
  }
}

/** Pull engagement metrics for recently published targets. */
export async function syncMetrics({ sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const targets = all("SELECT t.*, a.platform FROM publish_targets t JOIN social_accounts a ON a.id = t.account_id WHERE t.status = 'published' AND t.published_at >= ? AND (t.metrics_at IS NULL OR t.metrics_at < ?)", since, new Date(Date.now() - 3600e3).toISOString());
  for (const t of targets) {
    const a = ADAPTERS[t.platform];
    if (!a.metrics || !t.external_id) continue;
    try {
      const acc = accountWithTokens(one('SELECT * FROM social_accounts WHERE id = ?', t.account_id));
      const m = await a.metrics({ account: acc, externalId: t.external_id });
      run('UPDATE publish_targets SET likes = ?, comments = ?, shares = ?, impressions = ?, metrics_at = ? WHERE id = ?', m.likes || 0, m.comments || 0, m.shares || 0, m.impressions || 0, now(), t.id);
    } catch (e) {
      run('UPDATE publish_targets SET metrics_at = ? WHERE id = ?', now(), t.id);
    }
  }
  // Daily follower snapshots.
  const day = now().slice(0, 10);
  for (const row of all("SELECT * FROM social_accounts WHERE status = 'active'")) {
    const a = ADAPTERS[row.platform];
    if (!a.followers || one('SELECT 1 FROM account_metrics WHERE account_id = ? AND day = ?', row.id, day)) continue;
    try {
      const n = await a.followers({ account: accountWithTokens(row) });
      if (n != null) run('INSERT OR REPLACE INTO account_metrics (account_id, day, followers) VALUES (?, ?, ?)', row.id, day, n);
    } catch { /* metrics are best effort */ }
  }
}
