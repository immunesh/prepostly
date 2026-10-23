import { one, run, tx, uuid, now } from './db.js';
import { PLANS } from './catalog.js';
import { HttpError } from './auth.js';

const addMonths = (iso, n) => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
};

export const planOf = (user) => PLANS[user.plan] || PLANS.trial;

/** Refill monthly credits when the cycle rolled over. Returns the fresh user row. */
export function refreshCredits(userId) {
  const user = one('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw new HttpError(404, 'Account not found.');
  if (user.plan === 'trial') return user;
  if (!user.credits_reset_at || user.credits_reset_at <= now()) {
    const plan = planOf(user);
    let next = user.credits_reset_at || addMonths(now(), 1);
    while (next <= now()) next = addMonths(next, 1);
    tx(() => {
      run('UPDATE users SET credits = ?, credits_reset_at = ? WHERE id = ?', plan.credits, next, userId);
      run('INSERT INTO credit_ledger (id, user_id, delta, reason) VALUES (?, ?, ?, ?)', uuid(), userId, plan.credits - user.credits, 'monthly_refill');
    });
    return one('SELECT * FROM users WHERE id = ?', userId);
  }
  return user;
}

/** The account that pays for a brand (its owner). */
export function payerFor(brand) {
  return refreshCredits(brand.owner_id);
}

export function planStatus(user) {
  const plan = planOf(user);
  if (user.plan === 'trial') {
    const ends = new Date(new Date(user.plan_started_at).getTime() + plan.days * 864e5).toISOString();
    return { plan: user.plan, ...plan, trialEndsAt: ends, expired: ends < now() };
  }
  return { plan: user.plan, ...plan, expired: false };
}

/** Deduct credits from the brand owner's balance, or throw 402. */
export function charge(brand, amount, reason, ref = null) {
  const payer = payerFor(brand);
  const status = planStatus(payer);
  if (status.expired) throw new HttpError(402, 'Your free trial has ended. Choose a plan to keep creating.', 'plan_expired');
  if (amount <= 0) return payer.credits;
  return tx(() => {
    const fresh = one('SELECT credits FROM users WHERE id = ?', payer.id);
    if (fresh.credits < amount) throw new HttpError(402, `This needs ${amount} credits and ${fresh.credits} are left. Upgrade or wait for your monthly refill.`);
    run('UPDATE users SET credits = credits - ? WHERE id = ?', amount, payer.id);
    run('INSERT INTO credit_ledger (id, user_id, brand_id, delta, reason, ref) VALUES (?, ?, ?, ?, ?, ?)', uuid(), payer.id, brand.id, -amount, reason, ref);
    return fresh.credits - amount;
  });
}

/** Return credits after a failed generation ("No credits were used"). */
export function refund(brand, amount, reason, ref = null) {
  if (amount <= 0) return;
  tx(() => {
    run('UPDATE users SET credits = credits + ? WHERE id = ?', amount, brand.owner_id);
    run('INSERT INTO credit_ledger (id, user_id, brand_id, delta, reason, ref) VALUES (?, ?, ?, ?, ?, ?)', uuid(), brand.owner_id, brand.id, amount, reason, ref);
  });
}

export function recordUsage(userId, brandId, kind, amount = 1) {
  run('INSERT INTO usage_events (id, user_id, brand_id, kind, amount) VALUES (?, ?, ?, ?, ?)', uuid(), userId, brandId, kind, amount);
}

export function usageThisMonth(userId, kind) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return one('SELECT COALESCE(SUM(amount),0) AS n FROM usage_events WHERE user_id = ? AND kind = ? AND created_at >= ?', userId, kind, start.toISOString()).n;
}

/** Enforce a monthly quota such as competitor runs. */
export function checkQuota(brand, kind, limitKey, amount = 1) {
  const payer = payerFor(brand);
  const limit = planOf(payer)[limitKey];
  const used = usageThisMonth(payer.id, kind);
  if (used + amount > limit) throw new HttpError(429, `You have reached your monthly limit (${limit}) for ${kind.replace(/_/g, ' ')}. Upgrade for more.`, 'monthly_limit_reached');
  return { payer, used, limit };
}
