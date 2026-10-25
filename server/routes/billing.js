import { Router } from 'express';
import { one } from '../db.js';
import { baseUrl } from '../config.js';
import { HttpError, requireUser } from '../auth.js';
import { createCheckout, cancelSubscription, verifyWebhook, handleWebhook } from '../billing.js';

// Plan checkout (Dodo Payments) for account owners. Plans switch on from the webhook only.

export const router = Router();

router.post('/billing/checkout', requireUser, async (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.user.id);
  const url = await createCheckout(user, String(req.body.plan || ''), `${baseUrl(req)}/app/account?checkout=return`);
  res.json({ url });
});

router.post('/billing/cancel', requireUser, async (req, res) => {
  await cancelSubscription(one('SELECT * FROM users WHERE id = ?', req.user.id));
  res.json({ ok: true });
});

/** Dodo webhook. Mounted with a raw body parser: the signature covers the exact bytes. */
export async function dodoWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyWebhook(raw, req.headers)) throw new HttpError(401, 'Invalid webhook signature.');
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  await handleWebhook(String(req.headers['webhook-id']), event);
  res.json({ received: true });
}
