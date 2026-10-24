import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer, stopServer, newUser } from '../helpers.js';

// The app re-checks the session every 30 seconds. A failed check (dropped connection,
// deploy restart, proxy error) must keep the user signed in; only the server saying the
// session is gone signs them out.

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

let base;
let db;
let browser;
let page;
let user;

before(async () => {
  assert.ok(fs.existsSync(new URL('../../dist/index.html', import.meta.url)), 'Run `npm run build` before the e2e test.');
  assert.ok(CHROME, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  ({ base } = await startServer());
  db = await import('../../server/db.js');
  user = await newUser(base, { name: 'Sam Steady' });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(20000);
  await page.clock.install();
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Content library' }).waitFor();
});
after(async () => {
  await browser?.close();
  await stopServer();
});

test('a failed session check keeps the user signed in', async () => {
  await page.route('**/api/me', (r) => r.fulfill({ status: 502, body: 'Bad gateway' }));
  await page.clock.runFor(31_000); // the 30 s check fires and fails
  await page.clock.runFor(10_000); // its retries fail too
  await page.route('**/api/me', (r) => r.abort('internetdisconnected'));
  await page.clock.runFor(41_000);
  assert.match(page.url(), /\/app\//);
  assert.ok(await page.getByRole('link', { name: 'Content library' }).isVisible());
  await page.unroute('**/api/me');
});

test('an ended session still signs the user out', async () => {
  db.run('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)', user.email);
  await page.clock.runFor(31_000);
  await page.waitForURL(/\/login/);
});
