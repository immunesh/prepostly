import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Every test process gets its own data directory and runs offline (no LLM, no voiceover).
export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prepostly-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR, SCHEDULER: 'off', PREPOSTLY_SKIP_DOTENV: '1', LLM_OFFLINE: '1', VOICEOVER: 'off',
  PEXELS_API_KEY: '', UNSPLASH_ACCESS_KEY: '', PIXABAY_API_KEY: '', OPENVERSE: 'off', OPENAI_API_KEY: '', PUBLIC_URL: '',
});

let serverPromise = null;
/** Start the app once per test process on a random port. */
export function startServer() {
  serverPromise ||= import('../server/index.js').then(async ({ start }) => {
    const server = await start({ port: 0, host: '127.0.0.1' });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  });
  return serverPromise;
}

/** Close the app server (call from after()). */
export async function stopServer() {
  if (!serverPromise) return;
  const { server } = await serverPromise;
  const { stopScheduler } = await import('../server/scheduler.js');
  stopScheduler();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

/** Minimal API client with a cookie jar and the brand header. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.brandId = null;
    this.headers = {};
  }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { ...this.headers, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.brandId) h['x-brand-id'] = this.brandId;
    let payload;
    if (body instanceof Buffer) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(u, o) { return this.req('GET', u, undefined, o); }
  post(u, b, o) { return this.req('POST', u, b ?? {}, o); }
  patch(u, b) { return this.req('PATCH', u, b); }
  put(u, b) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
  async idle() { return this.post('/api/__test/idle'); }
}

let counter = 0;
/** Sign up a fresh user and create a brand. Returns a ready client. */
export async function newUser(base, { brand = true, name = 'Test User', brandBody = {} } = {}) {
  const c = new Client(base);
  const email = `user${Date.now()}${++counter}@example.com`;
  const r = await c.post('/api/auth/signup', { name, email, password: 'correct horse battery' });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  c.email = email;
  if (brand) {
    const b = await c.post('/api/brands', { name: 'Brewly Coffee', industry: 'coffee', description: 'Small-batch coffee roaster.', audience: 'home baristas', colors: ['#0f766e', '#14b8a6', '#fde047'], handle: 'brewly', ...brandBody });
    if (b.status !== 201) throw new Error(`brand failed: ${JSON.stringify(b.data)}`);
    c.brandId = b.data.id;
  }
  return c;
}

export function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function mediaFile(url) {
  return path.join(DATA_DIR, url.replace(/^\//, ''));
}

/** Mean loudness of a media file's audio in dB (about -91 for digital silence). */
export async function meanVolume(file) {
  const { default: ffmpegPath } = await import('ffmpeg-static');
  const { spawnSync } = await import('node:child_process');
  const { stderr } = spawnSync(ffmpegPath, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr)?.[1].replace('-inf', '-1000') ?? NaN);
}

// ---------------------------------------------------------------- fixture website & store
const PRODUCT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';

export function startFixtureSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
      const url = new URL(req.url, base);
      if (url.pathname === '/') {
        return send(200, 'text/html', `<!doctype html><html><head><title>Brewly | Small-batch coffee</title>
          <meta name="description" content="Brewly roasts small-batch specialty coffee for home baristas.">
          <meta name="theme-color" content="#0f766e">
          <link rel="apple-touch-icon" href="/logo.svg">
          <style>.btn{background:#f97316;color:#fff}.hero{background:#0f766e}.accent{color:#f97316} body{color:#333333}</style>
          <script src="https://cdn.shopify.com/s/files/theme.js"></script>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Brewly","logo":"${base}/logo.svg"}</script>
          </head><body><img class="site-logo" src="/logo.svg" alt="Brewly logo">
          <a href="https://instagram.com/brewlycoffee">IG</a><h1>Fresh coffee, delivered</h1><p>We roast every week.</p></body></html>`);
      }
      if (url.pathname === '/logo.svg') return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" rx="12" fill="#0f766e"/><text x="100" y="52" font-size="36" text-anchor="middle" fill="#fff">Brewly</text></svg>');
      if (url.pathname === '/product.png') return send(200, 'image/png', Buffer.from(PRODUCT_PNG_B64, 'base64'));
      if (url.pathname === '/products.json') {
        return send(200, 'application/json', JSON.stringify({
          products: [
            { id: 101, title: 'Cold Brew Kit', handle: 'cold-brew-kit', body_html: '<p>Everything you need for smooth cold brew at home. Includes a 1L carafe and filters.</p>', variants: [{ price: '34.00', compare_at_price: '49.00' }], images: [{ src: `${base}/product.png` }] },
            { id: 102, title: 'Ethiopia Yirgacheffe', handle: 'ethiopia', body_html: '<p>Floral, bright and sweet.</p>', variants: [{ price: '18.00', compare_at_price: null }], images: [{ src: `${base}/product.png` }] },
          ],
        }));
      }
      if (url.pathname === '/products/cold-brew-kit.json') return send(200, 'application/json', JSON.stringify({ product: { id: 101, title: 'Cold Brew Kit', body_html: '<p>Smooth cold brew at home.</p>', variants: [{ price: '34.00', compare_at_price: '49.00' }], images: [{ src: `${base}/product.png` }] } }));
      if (url.pathname === '/blog/brewing') {
        return send(200, 'text/html', `<html><head><meta property="og:title" content="How to brew better coffee"></head><body><article><h1>How to brew better coffee</h1>
          <p>${'Great coffee starts long before the kettle boils. '.repeat(6)}</p>
          <h2>Buy fresh beans</h2><p>Coffee is at its best within a month of roasting, so buy small bags often and store them airtight.</p>
          <h2>Grind just before brewing</h2><p>Ground coffee loses aroma within minutes, so a burr grinder makes a bigger difference than any machine.</p>
          <h2>Weigh everything</h2><p>A simple 1:16 ratio of coffee to water by weight gives consistent cups every single morning.</p>
          <h2>Mind the water</h2><p>Filtered water just off the boil extracts sweetness without bitterness from the grounds.</p></article></body></html>`);
      }
      send(404, 'text/plain', 'not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Replace global fetch for platform API tests. Routes: [{ match: (url, init) => bool, reply: (url, init) => ({status, body, headers}) }] */
export function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const route = routes.find((r) => r.match(url, init));
    if (!route) return new Response(JSON.stringify({ error: { message: `unmocked ${url}` } }), { status: 599 });
    const r = route.reply(url, init) || {};
    const body = typeof r.body === 'string' || r.body instanceof Buffer ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status || 200, headers: r.headers || { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
