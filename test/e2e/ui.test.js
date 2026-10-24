import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServer, startFixtureSite } from '../helpers.js';

// Drives the built web app (npm run build) in Chrome through the core journey:
// sign up → brand from website → create carousel → edit → connect channel → publish →
// calendar → analytics → Idea Lab. Fails on any console error or uncaught page error.

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const SHOTS = process.env.E2E_SCREENSHOTS || '';

let base;
let site;
let browser;
let page;
const problems = [];

before(async () => {
  assert.ok(fs.existsSync(new URL('../../dist/index.html', import.meta.url)), 'Run `npm run build` before the e2e test.');
  assert.ok(CHROME, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  ({ base } = await startServer());
  site = await startFixtureSite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}\n${e.stack}`));
  page.setDefaultTimeout(20000);
});
after(async () => {
  await browser?.close();
  site?.server.close();
  await stopServer();
});

async function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

test('landing → sign up → onboarding from website', async () => {
  await page.goto(base);
  await page.getByRole('link', { name: 'Start free trial' }).click();
  await page.getByLabel('Your name').fill('Maya Founder');
  await page.getByLabel('Work email').fill(`maya${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('a-strong-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Let’s set up your brand' }).waitFor();
  await page.getByLabel('Website').fill(site.base);
  await page.getByRole('button', { name: 'Fetch my brand' }).click();
  await page.getByRole('heading', { name: 'Confirm your brand kit' }).waitFor();
  assert.equal(await page.getByLabel('Brand name').inputValue(), 'Brewly');
  await shot('01-onboarding');
  await page.getByRole('button', { name: 'Create brand' }).click();
  await page.getByRole('heading', { name: 'Create your next post' }).waitFor();
  await shot('02-create-types');
});

test('create a carousel, watch it generate, then edit a slide', async () => {
  await page.getByRole('button', { name: /Carousel A multi-slide post/ }).click();
  await page.getByLabel('What is your post about?').fill('Cold brew at home\n- Use coarse grounds: fine grounds turn muddy\n- Steep for 16 hours in the fridge\n- Dilute 1:1 with milk or water');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByRole('img', { name: 'Slide 1' }).waitFor({ timeout: 60000 });
  assert.ok(await page.getByRole('img', { name: 'Slide 3' }).isVisible());
  await shot('03-post-ready');
  await page.getByRole('img', { name: 'Slide 2' }).click();
  const headline = page.getByLabel('Headline');
  assert.equal(await headline.inputValue(), 'Use coarse grounds');
  await headline.fill('Always use coarse grounds');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await page.getByText('Changes applied').waitFor();
  assert.match(await page.getByRole('img', { name: 'Slide 1' }).getAttribute('src'), /v2-1\.png/);
  await page.getByRole('tab', { name: 'Caption' }).click();
  assert.ok((await page.getByLabel('Caption', { exact: true }).inputValue()).length > 20);
});

test('connect a sandbox channel and publish now', async () => {
  const postUrl = page.url();
  await page.goto(`${base}/app/brand?tab=social`);
  await page.getByRole('button', { name: /Sandbox \(test channel\)/ }).click();
  await page.getByLabel('Channel name').fill('Brewly Test Feed');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('Connected Brewly Test Feed').waitFor();
  await shot('04-channels');
  await page.goto(postUrl);
  await page.getByRole('button', { name: /Publish \/ schedule/ }).click();
  await page.getByRole('button', { name: '⚡ Now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish now' }).click();
  await page.getByText('Published! 🎉').waitFor();
});

test('calendar, analytics and team pages render the published post', async () => {
  await page.getByRole('link', { name: 'Content calendar' }).click();
  await page.locator('.cal .event.published').first().waitFor();
  await shot('05-calendar');
  await page.locator('.cal .event.published').first().click();
  await page.getByRole('dialog', { name: 'Published post' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Analytics' }).click();
  await page.getByRole('heading', { name: /1-day posting streak/ }).waitFor();
  await shot('06-dashboard');
  await page.getByRole('link', { name: 'Team & brands' }).click();
  await page.getByText('Maya Founder (you)').waitFor();
});

test('idea lab streams an answer', async () => {
  await page.getByRole('link', { name: 'Idea Lab' }).click();
  await page.getByRole('button', { name: /Generate a content calendar/ }).click();
  await page.locator('.msg.assistant table').waitFor();
  await shot('07-idea-lab');
  assert.ok(await page.getByRole('button', { name: /Create a post from this/ }).isVisible());
  // Reopening the saved conversation shows the question and the stored answer.
  await page.getByRole('button', { name: /New conversation/ }).click();
  await page.getByRole('heading', { name: 'Try Idea Lab' }).waitFor();
  await page.locator('.chat-list').getByRole('button', { name: /content calendar/ }).click();
  await page.locator('.msg.assistant table').waitFor();
  assert.equal(await page.locator('.msg.user').count(), 1);
});

test('no console or page errors', () => {
  assert.deepEqual(problems, []);
});
