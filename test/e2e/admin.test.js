import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServer, newUser } from '../helpers.js';

// Drives the admin dashboard in Chrome: every tab renders, and an admin can add credits
// and suspend a user from the user panel. Fails on any console error or uncaught page error.

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const SHOTS = process.env.E2E_SCREENSHOTS || '';

let base;
let db;
let browser;
let page;
let admin;
let customer;
const problems = [];

before(async () => {
  assert.ok(fs.existsSync(new URL('../../dist/index.html', import.meta.url)), 'Run `npm run build` before the e2e test.');
  assert.ok(CHROME, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  ({ base } = await startServer());
  db = await import('../../server/db.js');
  const usage = await import('../../server/usage.js');
  admin = await newUser(base, { name: 'Site Boss' });
  db.run('UPDATE users SET is_admin = 1 WHERE email = ?', admin.email);
  customer = await newUser(base, { name: 'Cara Customer' });
  const p = await customer.post('/api/posts', { type: 'quote', prompt: 'Coffee motivation' });
  await customer.idle();
  const uid = db.one('SELECT id FROM users WHERE email = ?', customer.email).id;
  usage.withMeter({ userId: uid, brandId: customer.brandId, job: 'generate:quote', ref: p.data.id }, () => usage.logApiUsage({ provider: 'anthropic', model: 'claude-opus-5-5', feature: 'write_post', input: 3000, output: 1200, cost: 0.036 }));
  usage.withMeter({ userId: uid, brandId: customer.brandId }, () => usage.logApiUsage({ provider: 'heygen', feature: 'avatar_video', units: 60, cost: 1 }));

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}\n${e.stack}`));
  page.on('dialog', (d) => d.accept());
  page.setDefaultTimeout(20000);
});
after(async () => {
  await browser?.close();
  await stopServer();
});

async function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('admin signs in and opens every tab', async () => {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Admin dashboard' }).click();
  await page.getByRole('heading', { name: 'Admin', exact: true }).waitFor();
  await page.getByText('API cost per credit').waitFor();
  await page.getByText('What a credit costs, by feature').waitFor();
  await shot('admin-01-overview');

  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByText(customer.email).waitFor();
  await shot('admin-02-users');

  await page.getByRole('tab', { name: 'API usage' }).click();
  await page.getByText('Recent calls').waitFor();
  await page.getByRole('cell', { name: 'claude-opus-5-5' }).first().waitFor();
  await shot('admin-03-usage');

  await page.getByRole('tab', { name: 'Credit ledger' }).click();
  await page.getByRole('cell', { name: 'Generate · quote' }).first().waitFor();
  await shot('admin-04-ledger');

  await page.getByRole('tab', { name: 'Credit pricing' }).click();
  await page.getByText('Measured API cost per credit').waitFor();
  await page.getByText('Estimated API cost per action').waitFor();
  await shot('admin-05-pricing');
  assert.deepEqual(problems, []);
});

test('admin adds credits and suspends a user', async () => {
  const id = db.one('SELECT id FROM users WHERE email = ?', customer.email).id;
  const before = db.one('SELECT credits FROM users WHERE id = ?', id).credits;
  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByRole('row').filter({ hasText: customer.email }).getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Credits', { exact: true }).fill('250');
  await page.getByLabel('Note').fill('Goodwill');
  await page.getByRole('button', { name: '＋ Add', exact: true }).click();
  await page.getByText('Added 250 credits').waitFor();
  assert.equal(db.one('SELECT credits FROM users WHERE id = ?', id).credits, before + 250);
  await page.getByRole('cell', { name: /Goodwill/ }).first().waitFor();

  await page.getByRole('switch', { name: 'Suspended' }).click();
  await page.getByText('Account suspended and signed out').waitFor();
  assert.equal(db.one('SELECT suspended FROM users WHERE id = ?', id).suspended, 1);
  await shot('admin-06-user');
  assert.deepEqual(problems, []);
});

test('non-admins get no admin link and are sent away from the page', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const other = await newUser(base, { name: 'Regular' });
  await p.goto(`${base}/login`);
  await p.getByLabel('Email').fill(other.email);
  await p.getByLabel('Password').fill('correct horse battery');
  await p.getByRole('button', { name: 'Log in' }).click();
  await p.getByRole('link', { name: 'Content library' }).waitFor();
  assert.equal(await p.getByRole('link', { name: 'Admin dashboard' }).count(), 0);
  await p.goto(`${base}/app/admin`);
  await p.waitForURL(/\/app\/dashboard/);
  assert.deepEqual(errs, []);
  await ctx.close();
});
