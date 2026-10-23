import crypto from 'node:crypto';
import express, { Router } from 'express';
import { all, run, now, shortId } from '../db.js';
import { config, baseUrl } from '../config.js';
import { HttpError } from '../auth.js';

// Callbacks Meta and Threads call when someone removes the app or asks for their data to be deleted.
// Set these URLs in each app's dashboard; app review needs them along with /privacy and /terms.

export const router = Router();
const form = express.urlencoded({ extended: false });

/** Verify a signed_request ("signature.payload", HMAC-SHA256 with the app secret) and return its payload. */
export function parseSignedRequest(signed, secret) {
  const [sig, payload] = String(signed || '').split('.');
  if (!sig || !payload || !secret) throw new HttpError(400, 'Invalid signed request.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(400, 'Invalid signed request.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (String(data.algorithm).toUpperCase() !== 'HMAC-SHA256' || !data.user_id) throw new HttpError(400, 'Invalid signed request.');
  return data;
}

// Each app identifies the person differently: Meta by the app-scoped user id saved on connect, Threads by account id.
const SOURCES = {
  meta: { secret: () => config.oauth.facebook.clientSecret, where: "platform IN ('facebook', 'instagram') AND json_extract(meta, '$.fb_user_id') = ?" },
  threads: { secret: () => config.oauth.threads.clientSecret, where: "platform = 'threads' AND external_id = ?" },
};

function accountsFor(source, req) {
  const { secret, where } = SOURCES[source];
  const { user_id } = parseSignedRequest(req.body?.signed_request, secret());
  return { userId: String(user_id), rows: all(`SELECT id FROM social_accounts WHERE ${where}`, String(user_id)) };
}

for (const source of Object.keys(SOURCES)) {
  router.post(`/callbacks/${source}/data-deletion`, form, (req, res) => {
    const { userId, rows } = accountsFor(source, req);
    for (const r of rows) run('DELETE FROM social_accounts WHERE id = ?', r.id);
    const code = shortId(16);
    run('INSERT INTO data_deletions (code, platform, external_user_id, removed, created_at) VALUES (?, ?, ?, ?, ?)', code, source, userId, rows.length, now());
    res.json({ url: `${baseUrl(req)}/data-deletion?code=${code}`, confirmation_code: code });
  });

  // Removing the app revokes its tokens, so the channels have to be connected again before they can post.
  router.post(`/callbacks/${source}/${source === 'meta' ? 'deauthorize' : 'uninstall'}`, form, (req, res) => {
    const { rows } = accountsFor(source, req);
    for (const r of rows) run("UPDATE social_accounts SET status = 'relink' WHERE id = ?", r.id);
    res.json({ ok: true });
  });
}
