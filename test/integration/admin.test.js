import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, newUser, Client } from '../helpers.js';

process.env.ADMIN_EMAILS = 'boss@example.com';

let base;
let db;
let usage;
let admin; // signed up with an ADMIN_EMAILS address
let user; // an ordinary customer

before(async () => {
  ({ base } = await startServer());
  db = await import('../../server/db.js');
  usage = await import('../../server/usage.js');
  admin = new Client(base);
  assert.equal((await admin.post('/api/auth/signup', { name: 'Boss', email: 'boss@example.com', password: 'correct horse battery' })).status, 201);
  user = await newUser(base, { name: 'Customer' });
});
after(stopServer);

const userId = (c) => db.one('SELECT id FROM users WHERE email = ?', c.email || 'boss@example.com').id;

describe('admin access', () => {
  test('only site admins can call the admin API', async () => {
    assert.equal((await new Client(base).get('/api/admin/overview')).status, 401);
    const denied = await user.get('/api/admin/overview');
    assert.equal(denied.status, 403);
    assert.equal((await user.get('/api/me')).data.user.is_admin, false);
    assert.equal((await admin.get('/api/me')).data.user.is_admin, true);
    assert.equal((await admin.get('/api/admin/overview')).status, 200);
  });

  test('admins can grant admin access through the database flag', async () => {
    const helper = await newUser(base, { brand: false });
    assert.equal((await helper.get('/api/admin/users')).status, 403);
    assert.equal((await admin.patch(`/api/admin/users/${userId(helper)}`, { is_admin: true })).status, 200);
    assert.equal((await helper.get('/api/admin/users')).status, 200);
    // Admins cannot lock themselves out.
    assert.equal((await admin.patch(`/api/admin/users/${userId(admin)}`, { is_admin: false })).status, 400);
  });
});

describe('stats', () => {
  test('overview counts users, credits and API spend per credit', async () => {
    const p = await user.post('/api/posts', { type: 'quote', prompt: 'Coffee motivation' });
    assert.equal(p.status, 201);
    await user.idle();
    // A metered Claude call for that generation, as the writer would log it.
    usage.withMeter({ userId: userId(user), brandId: user.brandId, job: 'generate:quote', ref: p.data.id }, () => usage.logApiUsage({ provider: 'anthropic', model: 'claude-opus-5-5', feature: 'write_post', input: 3000, output: 1200, cost: 0.036 }));
    usage.withMeter({ userId: userId(user), brandId: user.brandId }, () => usage.logApiUsage({ provider: 'anthropic', model: 'claude-opus-5-5', feature: 'rewrite_caption', input: 500, output: 200, cost: 0.006 }));

    const o = (await admin.get('/api/admin/overview?days=30')).data;
    assert.ok(o.users.total >= 3);
    assert.ok(o.users.new >= 3);
    assert.ok(o.content.posts >= 1);
    assert.ok(o.credits.consumed >= 4);
    assert.equal(o.api.calls, 2);
    assert.equal(o.api.input, 3500);
    assert.equal(o.api.by_provider[0].provider, 'anthropic');
    const job = o.economics.jobs.find((j) => j.job === 'generate:quote');
    assert.deepEqual([job.credits, job.runs, job.cost, job.usd_per_credit], [4, 1, 0.036, 0.009]);
    assert.deepEqual(o.economics.uncharged, [{ job: null, cost: 0.006, calls: 1 }]);
    assert.equal(o.series.length, 30);
    assert.equal(o.series.at(-1).credits, o.credits.consumed);
    assert.equal(o.top_users[0].email, user.email);
  });

  test('usage, user detail, ledger and pricing', async () => {
    const u = (await admin.get('/api/admin/usage?days=7&feature=write_post')).data;
    assert.equal(u.totals.calls, 1);
    assert.equal(u.recent[0].email, user.email);
    assert.deepEqual(u.filters.features, ['rewrite_caption', 'write_post']);

    const list = (await admin.get(`/api/admin/users?q=${encodeURIComponent(user.email)}`)).data;
    assert.equal(list.total, 1);
    assert.deepEqual([list.users[0].brands, list.users[0].posts, list.users[0].credits_used, list.users[0].api_cost], [1, 1, 4, 0.042]);
    assert.equal(list.users[0].password_hash, undefined);

    const d = (await admin.get(`/api/admin/users/${userId(user)}`)).data;
    assert.equal(d.brands.length, 1);
    assert.equal(d.totals.api_cost, 0.042);
    assert.ok(d.ledger.some((l) => l.reason === 'generate:quote'));

    const pricing = (await admin.get('/api/admin/pricing')).data;
    assert.equal(pricing.plans.find((x) => x.id === 'core').usd_per_credit, Math.round((19 / 1300) * 1e6) / 1e6);
    assert.ok(pricing.estimates.length >= 6);
    assert.equal(pricing.measured.usd_per_credit, Math.round((0.042 / 4) * 1e6) / 1e6);
  });
});

describe('managing users', () => {
  test('add, remove and set credits with a ledger trail', async () => {
    const id = userId(user);
    const before = db.one('SELECT credits FROM users WHERE id = ?', id).credits;
    const add = await admin.post(`/api/admin/users/${id}/credits`, { delta: 500, note: 'Support goodwill' });
    assert.equal(add.status, 200);
    assert.equal(add.data.credits, before + 500);
    assert.equal((await admin.post(`/api/admin/users/${id}/credits`, { delta: -(before + 501) })).status, 400);
    assert.equal((await admin.post(`/api/admin/users/${id}/credits`, { delta: 1.5 })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${id}`, { credits: 42, note: 'Reset' })).data.credits, 42);
    const adj = db.all("SELECT * FROM credit_ledger WHERE user_id = ? AND reason = 'admin_adjust' ORDER BY created_at", id);
    assert.deepEqual(adj.map((l) => [l.delta, l.note, l.ref]), [[500, 'Support goodwill', userId(admin)], [42 - before - 500, 'Reset', userId(admin)]]);
    // Admin grants are not counted as consumption.
    const ledger = (await admin.get('/api/admin/ledger?kind=admin')).data;
    assert.equal(ledger.rows[0].by_email, 'boss@example.com');
    assert.equal((await user.get('/api/account')).data.credits, 42);
  });

  test('change plan refills credits', async () => {
    const r = await admin.patch(`/api/admin/users/${userId(user)}`, { plan: 'rise' });
    assert.deepEqual([r.data.plan, r.data.credits], ['rise', 3200]);
    assert.ok(r.data.credits_reset_at > new Date().toISOString());
  });

  test('suspend signs the user out and blocks login', async () => {
    const id = userId(user);
    assert.equal((await admin.patch(`/api/admin/users/${id}`, { suspended: true })).status, 200);
    assert.equal((await user.get('/api/me')).data, null);
    const fresh = new Client(base);
    const login = await fresh.post('/api/auth/login', { email: user.email, password: 'correct horse battery' });
    assert.equal(login.status, 403);
    assert.equal((await admin.patch(`/api/admin/users/${userId(admin)}`, { suspended: true })).status, 400);
    await admin.patch(`/api/admin/users/${id}`, { suspended: false });
    assert.equal((await fresh.post('/api/auth/login', { email: user.email, password: 'correct horse battery' })).status, 200);
  });

  test('create and delete accounts', async () => {
    const c = await admin.post('/api/admin/users', { name: 'New Hire', email: 'Hire@Example.com', password: 'longenough', plan: 'core', credits: 50 });
    assert.equal(c.status, 201);
    assert.deepEqual([c.data.email, c.data.plan, c.data.credits], ['hire@example.com', 'core', 50]);
    assert.equal((await admin.post('/api/admin/users', { name: 'Dup', email: 'hire@example.com', password: 'longenough' })).status, 409);
    const login = new Client(base);
    assert.equal((await login.post('/api/auth/login', { email: 'hire@example.com', password: 'longenough' })).status, 200);

    assert.equal((await admin.del(`/api/admin/users/${userId(admin)}`)).status, 400);
    const id = userId(user);
    assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 200);
    assert.equal((await admin.get(`/api/admin/users/${id}`)).status, 404);
    assert.equal(db.one('SELECT COUNT(*) AS n FROM brands WHERE owner_id = ?', id).n, 0);
    // API spend history outlives the account.
    assert.equal(db.one('SELECT COUNT(*) AS n FROM api_usage WHERE user_id = ?', id).n, 2);
  });
});
