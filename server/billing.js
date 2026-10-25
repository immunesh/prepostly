import crypto from 'node:crypto';
import { one, all, run, tx, uuid, now } from './db.js';
import { config } from './config.js';
import { HttpError } from './auth.js';
import { PLANS } from './catalog.js';
import { notify } from './notify.js';

// Plan purchases through Dodo Payments. A checkout only records a pending payment; the plan
// switches on when Dodo's signed webhook reports the payment succeeded.

const PAID = ['core', 'rise', 'enterprise'];
const TOLERANCE_S = 5 * 60;

const addMonths = (iso, n) => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
};

/** Plans that can be bought here (Dodo is configured and the plan has a product). */
export function purchasablePlans() {
  const { apiKey, webhookSecret, products } = config.dodo;
  if (!apiKey || !webhookSecret) return [];
  return PAID.filter((p) => products[p]);
}

async function dodo(method, pathname, body) {
  const res = await fetch(`${config.dodo.baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${config.dodo.apiKey}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    console.error(`[billing] Dodo ${method} ${pathname} failed: ${res.status} ${text.slice(0, 300)}`);
    throw new HttpError(502, 'The payment provider could not start checkout. Please try again in a moment.');
  }
  return data;
}

/** Start a hosted checkout for `plan` and record it as a pending payment. Returns the checkout URL. */
export async function createCheckout(user, plan, returnUrl) {
  if (!PAID.includes(plan)) throw new HttpError(400, 'Choose core, rise or enterprise.');
  if (!purchasablePlans().includes(plan)) throw new HttpError(400, 'Online payment is not set up for this plan yet. Contact us to upgrade.');
  const session = await dodo('POST', '/checkouts', {
    product_cart: [{ product_id: config.dodo.products[plan], quantity: 1 }],
    customer: user.dodo_customer_id ? { customer_id: user.dodo_customer_id } : { email: user.email, name: user.name },
    return_url: returnUrl,
    metadata: { user_id: user.id, plan },
  });
  if (!session?.session_id || !session.checkout_url) throw new HttpError(502, 'The payment provider did not return a checkout link. Please try again.');
  run('INSERT INTO payments (id, user_id, plan, checkout_session_id, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    uuid(), user.id, plan, session.session_id, PLANS[plan].price * 100, 'USD', 'pending');
  return session.checkout_url;
}

/** Cancel the user's subscription at the end of the period they paid for. */
export async function cancelSubscription(user) {
  if (user.plan_source !== 'dodo' || !user.dodo_subscription_id) throw new HttpError(400, 'There is no active subscription to cancel.');
  await dodo('PATCH', `/subscriptions/${encodeURIComponent(user.dodo_subscription_id)}`, { cancel_at_next_billing_date: true });
  run("UPDATE users SET billing_status = 'cancelling' WHERE id = ?", user.id);
}

/** Verify a Standard Webhooks signature (webhook-id, webhook-timestamp, webhook-signature). */
export function verifyWebhook(raw, headers, secret = config.dodo.webhookSecret) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigs = String(headers['webhook-signature'] || '');
  if (!secret || !id || !ts || !sigs) return false;
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.`).update(raw).digest();
  return sigs.split(' ').some((entry) => {
    const [version, sig] = entry.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** The user and plan an event belongs to: its checkout, its subscription, or the metadata we sent. */
function ownerOf(data) {
  const row = data.checkout_session_id ? one('SELECT * FROM payments WHERE checkout_session_id = ?', data.checkout_session_id) : null;
  let user = row ? one('SELECT * FROM users WHERE id = ?', row.user_id) : null;
  if (!user && data.subscription_id) user = one('SELECT * FROM users WHERE dodo_subscription_id = ?', data.subscription_id);
  if (!user && data.metadata?.user_id) user = one('SELECT * FROM users WHERE id = ?', String(data.metadata.user_id));
  if (!user) return null;
  const byProduct = PAID.find((p) => config.dodo.products[p] && config.dodo.products[p] === (data.product_id || data.product_cart?.[0]?.product_id));
  const sameSub = data.subscription_id && data.subscription_id === user.dodo_subscription_id;
  const plan = [row?.plan, data.metadata?.plan, byProduct, sameSub ? user.plan : null].find((p) => PAID.includes(p));
  return { user, plan, row };
}

function onPaymentSucceeded(data) {
  const owner = ownerOf(data);
  if (!owner?.plan) return console.warn(`[billing] payment ${data.payment_id} matched no account or plan`);
  const { user, plan } = owner;
  if (one("SELECT 1 FROM payments WHERE payment_id = ? AND status = 'succeeded'", data.payment_id)) return;
  const row = owner.row && !owner.row.payment_id ? owner.row : null;
  if (row) {
    run("UPDATE payments SET payment_id = ?, subscription_id = ?, amount = ?, currency = ?, status = 'succeeded', updated_at = ? WHERE id = ?",
      data.payment_id, data.subscription_id || null, data.total_amount ?? row.amount, data.currency || row.currency, now(), row.id);
  } else {
    run("INSERT INTO payments (id, user_id, plan, payment_id, subscription_id, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded') ON CONFLICT(payment_id) DO UPDATE SET status = 'succeeded', updated_at = excluded.updated_at",
      uuid(), user.id, plan, data.payment_id, data.subscription_id || null, data.total_amount ?? null, data.currency || null);
  }
  // A renewal of the same plan keeps its start date; a new purchase starts a fresh cycle.
  const renewal = user.plan_source === 'dodo' && user.plan === plan && !row;
  const paidUntil = addMonths(now(), 1);
  run(`UPDATE users SET plan = ?, plan_source = 'dodo', billing_status = 'active', plan_started_at = ?, credits = ?, credits_reset_at = ?, paid_until = ?,
      dodo_customer_id = COALESCE(?, dodo_customer_id), dodo_subscription_id = COALESCE(?, dodo_subscription_id) WHERE id = ?`,
    plan, renewal ? user.plan_started_at : now(), PLANS[plan].credits, paidUntil, paidUntil, data.customer?.customer_id || null, data.subscription_id || null, user.id);
  run('INSERT INTO credit_ledger (id, user_id, delta, reason, ref) VALUES (?, ?, ?, ?, ?)', uuid(), user.id, PLANS[plan].credits - user.credits, renewal ? 'monthly_refill' : `plan:${plan}`, data.payment_id);
  if (!renewal) notify(user.id, null, 'plan_active', `You're on ${PLANS[plan].label}`, `Payment received. ${PLANS[plan].credits.toLocaleString()} credits are ready to use.`, '/app/account');
  // Buying a different plan replaces the old subscription.
  const old = user.dodo_subscription_id;
  if (old && data.subscription_id && old !== data.subscription_id) return { cancel: old };
}

function onPaymentClosed(data, status) {
  const owner = ownerOf(data);
  if (owner?.row && !owner.row.payment_id) run('UPDATE payments SET payment_id = ?, status = ?, updated_at = ? WHERE id = ?', data.payment_id, status, now(), owner.row.id);
  else if (data.payment_id) run('UPDATE payments SET status = ?, updated_at = ? WHERE payment_id = ? AND status != ?', status, now(), data.payment_id, 'succeeded');
}

function onSubscription(type, data) {
  const user = data.subscription_id && one('SELECT * FROM users WHERE dodo_subscription_id = ?', data.subscription_id);
  if (!user) return;
  const status = type === 'subscription.active' || type === 'subscription.renewed' ? 'active' : data.status || type.split('.')[1];
  const until = data.next_billing_date && !Number.isNaN(Date.parse(data.next_billing_date)) ? new Date(data.next_billing_date).toISOString() : null;
  // Keep 'cancelling' until the period actually ends.
  const next = status === 'active' && data.cancel_at_next_billing_date ? 'cancelling' : status;
  run('UPDATE users SET billing_status = ?, paid_until = COALESCE(?, paid_until), credits_reset_at = COALESCE(?, credits_reset_at) WHERE id = ?', next, status === 'active' ? until : null, status === 'active' ? until : null, user.id);
}

/** Apply one verified webhook event. Each webhook-id is processed once. */
export async function handleWebhook(eventId, event) {
  const type = String(event?.type || '');
  const data = event?.data || {};
  const followUp = tx(() => {
    if (one('SELECT 1 FROM webhook_events WHERE id = ?', eventId)) return null;
    run('INSERT INTO webhook_events (id, provider, type) VALUES (?, ?, ?)', eventId, 'dodo', type);
    if (type === 'payment.succeeded') return onPaymentSucceeded(data);
    if (type === 'payment.failed' || type === 'payment.cancelled') return onPaymentClosed(data, type.split('.')[1]);
    if (type.startsWith('subscription.')) return onSubscription(type, data);
    if (type === 'refund.succeeded' && data.payment_id) run("UPDATE payments SET status = 'refunded', updated_at = ? WHERE payment_id = ?", now(), data.payment_id);
    return null;
  });
  if (followUp?.cancel) await dodo('PATCH', `/subscriptions/${encodeURIComponent(followUp.cancel)}`, { status: 'cancelled' }).catch((e) => console.error('[billing] could not cancel replaced subscription', followUp.cancel, e.message));
}

export const paymentsFor = (userId) => all('SELECT id, plan, provider, payment_id, amount, currency, status, created_at, updated_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', userId);
