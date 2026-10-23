import crypto from 'node:crypto';
import { Router } from 'express';
import { one, all, run, json } from '../db.js';
import { baseUrl } from '../config.js';
import { HttpError, requireUser, brandFor, userFromSession } from '../auth.js';
import { PLATFORMS } from '../catalog.js';
import { planOf, payerFor } from '../credits.js';
import { adapter, saveAccounts, publicAccount } from '../publishers/index.js';
import { PublishError } from '../publishers/common.js';

export const router = Router();
// OAuth callbacks are top-level navigations from the platform, mounted outside /api.
export const callbackRouter = Router();

const redirectFor = (req, platform) => `${baseUrl(req)}/oauth/callback/${platform}`;

function checkChannelLimit(brand, adding = 1) {
  const payer = payerFor(brand);
  const used = one("SELECT COUNT(*) AS n FROM social_accounts a JOIN brands b ON b.id = a.brand_id WHERE b.owner_id = ? AND a.platform != 'sandbox'", payer.id).n;
  const limit = planOf(payer).channels;
  if (used + adding > limit) throw new HttpError(429, `Your plan includes ${limit} connected channels. Remove one or upgrade.`, 'channel_limit');
}

router.use(requireUser);

router.get('/accounts', (req, res) => {
  const brand = brandFor(req);
  res.json(all('SELECT * FROM social_accounts WHERE brand_id = ? ORDER BY platform, name', brand.id).map(publicAccount));
});

/** Connect a token-based channel (Bluesky, Mastodon, Telegram, Sandbox). */
router.post('/accounts/connect/:platform', async (req, res) => {
  const brand = brandFor(req, 'admin');
  const { platform } = req.params;
  if (PLATFORMS[platform]?.auth !== 'token') throw new HttpError(400, `${PLATFORMS[platform]?.label || platform} connects with OAuth. Use the Connect button.`);
  let accounts;
  try {
    accounts = await adapter(platform).connect(req.body || {});
  } catch (e) {
    if (e instanceof PublishError) throw new HttpError(400, e.message);
    throw e;
  }
  if (platform !== 'sandbox') checkChannelLimit(brand, accounts.length);
  const ids = saveAccounts(brand.id, platform, accounts);
  res.status(201).json(ids.map((id) => publicAccount(one('SELECT * FROM social_accounts WHERE id = ?', id))));
});

/** Begin OAuth: returns the platform authorization URL. */
router.post('/accounts/oauth/:platform', (req, res) => {
  const brand = brandFor(req, 'admin');
  const { platform } = req.params;
  const a = adapter(platform);
  if (PLATFORMS[platform].auth !== 'oauth') throw new HttpError(400, 'This channel connects with a token.');
  // The server owner adds each platform's app credentials (see README); users only see that it isn't offered yet.
  if (!a.configured()) throw new HttpError(400, `${PLATFORMS[platform].label} isn't available yet. Choose another channel for now.`, 'not_configured');
  checkChannelLimit(brand);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = redirectFor(req, platform);
  run('DELETE FROM oauth_states WHERE created_at < ?', new Date(Date.now() - 3600e3).toISOString());
  run('INSERT INTO oauth_states (state, brand_id, user_id, platform, verifier, redirect_uri) VALUES (?, ?, ?, ?, ?, ?)', state, brand.id, req.user.id, platform, verifier, redirectUri);
  res.json({ url: a.authUrl({ state, redirectUri, challenge }) });
});

router.patch('/accounts/:id', (req, res) => {
  const brand = brandFor(req, 'admin');
  const row = one('SELECT * FROM social_accounts WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!row) throw new HttpError(404, 'Account not found.');
  const meta = json(row.meta, {});
  if (req.body.board_id !== undefined) {
    if (!(meta.boards || []).some((b) => b.id === req.body.board_id)) throw new HttpError(400, 'Unknown board.');
    meta.board_id = req.body.board_id;
  }
  if (row.platform === 'sandbox' && req.body.fail !== undefined) meta.fail = ['always', 'transient'].includes(req.body.fail) ? req.body.fail : undefined;
  run('UPDATE social_accounts SET meta = ? WHERE id = ?', JSON.stringify(meta), row.id);
  res.json(publicAccount(one('SELECT * FROM social_accounts WHERE id = ?', row.id)));
});

router.delete('/accounts/:id', (req, res) => {
  const brand = brandFor(req, 'admin');
  run('DELETE FROM social_accounts WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  res.json({ ok: true });
});

callbackRouter.get('/oauth/callback/:platform', async (req, res) => {
  const back = (q) => res.redirect(`/app/brand?tab=social&${new URLSearchParams(q)}`);
  const st = one('SELECT * FROM oauth_states WHERE state = ? AND platform = ?', String(req.query.state || ''), req.params.platform);
  if (!st) return back({ error: 'This connection link expired. Try connecting again.' });
  run('DELETE FROM oauth_states WHERE state = ?', st.state);
  const user = userFromSession(req);
  if (user && user.id !== st.user_id) return back({ error: 'You are signed in as a different user than the one who started linking.' });
  if (req.query.error) return back({ error: `${PLATFORMS[st.platform].label} did not grant access (${req.query.error_description || req.query.error}).` });
  try {
    const accounts = await adapter(st.platform).exchange({ code: String(req.query.code || ''), redirectUri: st.redirect_uri, verifier: st.verifier });
    const ids = saveAccounts(st.brand_id, st.platform, accounts);
    back({ connected: st.platform, count: String(ids.length) });
  } catch (e) {
    back({ error: e.message });
  }
});

