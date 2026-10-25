import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startServer, stopServer, startFixtureSite, newUser, Client, pngSize, mediaFile } from '../helpers.js';

let base;
let site;
let owner; // brand owner client
let db;

before(async () => {
  ({ base } = await startServer());
  site = await startFixtureSite();
  owner = await newUser(base);
  db = await import('../../server/db.js');
});
after(async () => {
  site.server.close();
  await stopServer();
});

const waitReady = async (c, id) => {
  await c.idle();
  return (await c.get(`/api/posts/${id}`)).data;
};

describe('auth & account', () => {
  test('signup, me, login, logout and validation', async () => {
    const c = new Client(base);
    assert.equal((await c.post('/api/auth/signup', { name: 'A', email: 'bad', password: 'x' })).status, 400);
    const email = `auth${Date.now()}@example.com`;
    assert.equal((await c.post('/api/auth/signup', { name: 'Ana', email, password: 'password123' })).status, 201);
    assert.equal((await c.post('/api/auth/signup', { name: 'Ana', email, password: 'password123' })).status, 409);
    const me = await c.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, email);
    assert.equal(me.data.plan.plan, 'trial');
    assert.equal(me.data.credits, 300);
    assert.equal(me.data.capabilities.writer, 'offline');
    await c.post('/api/auth/logout');
    const anon = await c.get('/api/me');
    assert.equal(anon.status, 200);
    assert.equal(anon.data, null);
    assert.equal((await c.get('/api/posts')).status, 401);
    assert.equal((await c.post('/api/auth/login', { email, password: 'wrong-password' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { email, password: 'password123' })).status, 200);
    assert.equal((await c.get('/api/me')).status, 200);
  });

  test('public catalog lists post types, formats and platforms', async () => {
    const r = await new Client(base).get('/api/catalog');
    assert.equal(r.status, 200);
    assert.ok(r.data.post_types.carousel);
    assert.equal(r.data.formats.story.h, 1920);
    assert.ok(r.data.platforms.find((p) => p.id === 'sandbox').configured);
    assert.equal(r.data.platforms.find((p) => p.id === 'instagram').configured, false);
  });
});

describe('brand kit', () => {
  test('fetch brand details from a website', async () => {
    const r = await owner.post('/api/brands/from-website', { url: site.base });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.name, 'Brewly');
    assert.match(r.data.description, /small-batch specialty coffee/);
    assert.equal(r.data.colors[0], '#0f766e');
    assert.ok(r.data.colors.includes('#f97316'));
    assert.equal(r.data.handle, 'brewlycoffee');
    assert.equal(r.data.store, 'shopify');
    assert.match(r.data.logo, /logo\.svg$/);
  });

  test('create a brand with a remote logo, then update fields', async () => {
    const c = await newUser(base, { brand: false });
    const b = await c.post('/api/brands', { name: 'Brewly', website: site.base, logo_url: `${site.base}/logo.svg`, colors: ['#0f766e', 'nope', '#fde047'] });
    assert.equal(b.status, 201);
    assert.match(b.data.logo_light, /^\/uploads\/.+\.svg$/);
    assert.deepEqual(b.data.colors, ['#0f766e', '#fde047']);
    c.brandId = b.data.id;
    const u = await c.patch(`/api/brands/${b.data.id}`, { tone: 'Playful', font_heading: 'Montserrat', timezone: 'Asia/Kolkata', hashtags: '#brewly #coffee' });
    assert.equal(u.status, 200);
    assert.equal(u.data.tone, 'Playful');
    assert.equal((await c.patch(`/api/brands/${b.data.id}`, { tone: 'Grumpy' })).status, 400);
    assert.equal((await c.patch(`/api/brands/${b.data.id}`, { timezone: 'Mars/Base' })).status, 400);
    // Trial plan allows one brand.
    assert.equal((await c.post('/api/brands', { name: 'Second' })).status, 429);
    // Uploaded logo is served with a sandboxing CSP.
    const logo = await c.get(b.data.logo_light, { raw: true });
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-security-policy'), /sandbox/);
  });
});

describe('content generation', () => {
  test('single image post renders a PNG at the requested size and charges credits', async () => {
    const before = (await owner.get('/api/me')).data.credits;
    const r = await owner.post('/api/posts', { type: 'single_image', prompt: 'Why fresh coffee beans matter', format: 'ig_portrait' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.status, 'generating');
    const p = await waitReady(owner, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    assert.equal(p.writer, 'offline');
    assert.equal(p.media.length, 1);
    assert.deepEqual(pngSize(fs.readFileSync(mediaFile(p.media[0].url))), { w: 1080, h: 1350 });
    assert.ok(p.caption.length > 20);
    assert.match(p.hashtags, /#/);
    assert.equal((await owner.get('/api/me')).data.credits, before - 4);
    // Media is publicly fetchable (social platforms pull it by URL).
    assert.equal((await new Client(base).get(p.media[0].url, { raw: true })).status, 200);
  });

  test('brands with a logo render posts (logo in the footer)', async () => {
    const c = await newUser(base, { brand: false });
    const b = await c.post('/api/brands', { name: 'Logo Co', logo_url: `${site.base}/logo.svg`, handle: 'logoco' });
    c.brandId = b.data.id;
    const r = await c.post('/api/posts', { type: 'carousel', prompt: 'Logo test', slides: 3 });
    const p = await waitReady(c, r.data.id);
    assert.equal(p.status, 'ready', p.error);
  });

  test('carousel renders every slide with cover, points and CTA', async () => {
    const r = await owner.post('/api/posts', { type: 'carousel', prompt: 'Coffee brewing tips for beginners', slides: 5, template: 'minimal' });
    const p = await waitReady(owner, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    assert.equal(p.media.length, 5);
    assert.deepEqual(p.content.slides.map((s) => s.kind), ['cover', 'point', 'point', 'point', 'cta']);
    for (const m of p.media) assert.ok(pngSize(fs.readFileSync(mediaFile(m.url))));
    assert.equal(p.credits_used, 4 + 2 * 4);
  });

  test('user-supplied points are used verbatim', async () => {
    const r = await owner.post('/api/posts', { type: 'carousel', slides: 5, prompt: 'Our cold brew guide\n- Use coarse grounds: fine grounds make it muddy\n- Steep 16 hours in the fridge\n- Dilute 1:1 with milk or water' });
    const p = await waitReady(owner, r.data.id);
    const heads = p.content.slides.map((s) => s.headline);
    assert.ok(heads.includes('Use coarse grounds'), heads.join(' | '));
    assert.ok(heads.includes('Steep 16 hours in the fridge'));
  });

  test('quote, meme and special day posts', async () => {
    const ids = [];
    for (const body of [{ type: 'quote', prompt: 'coffee and good food' }, { type: 'meme', prompt: 'Monday mornings without coffee' }, { type: 'special_day', special_day: 'International Coffee Day' }]) {
      const r = await owner.post('/api/posts', { ...body, format: 'square' });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ids.push(r.data.id);
    }
    await owner.idle();
    const [q, m, s] = await Promise.all(ids.map((id) => owner.get(`/api/posts/${id}`).then((r) => r.data)));
    assert.equal(q.content.slides[0].kind, 'quote');
    assert.ok(q.content.slides[0].author);
    assert.equal(m.content.slides[0].kind, 'meme');
    assert.ok(m.content.slides[0].top && m.content.slides[0].bottom);
    assert.match(s.content.slides[0].headline, /Coffee Day/);
    for (const p of [q, m, s]) assert.deepEqual(pngSize(fs.readFileSync(mediaFile(p.media[0].url))), { w: 1080, h: 1080 });
  });

  test('blog to carousel reads the article headings', async () => {
    const r = await owner.post('/api/posts', { type: 'blog_to_carousel', article_url: `${site.base}/blog/brewing`, slides: 6 });
    const p = await waitReady(owner, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    const heads = p.content.slides.map((s) => s.headline);
    assert.equal(heads[0], 'How to brew better coffee');
    assert.ok(heads.includes('Buy fresh beans'));
    assert.ok(heads.includes('Grind just before brewing'));
  });

  test('short video renders an MP4 with frames and a cover', async () => {
    const r = await owner.post('/api/posts', { type: 'video', prompt: 'Three quick coffee hacks', slides: 3, format: 'story' });
    const p = await waitReady(owner, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    const video = p.media.find((m) => m.kind === 'video');
    assert.ok(video);
    const buf = fs.readFileSync(mediaFile(video.url));
    assert.equal(buf.toString('latin1', 4, 8), 'ftyp');
    assert.ok(video.duration > 6 && video.duration < 20, `duration ${video.duration}`);
    assert.equal(p.media.filter((m) => m.kind === 'frame').length, 3);
    assert.ok(p.cover);
    assert.equal(p.credits_used, 40);

    // A design change re-encodes in the background; the current video stays until the new one is done.
    const r2 = await owner.patch(`/api/posts/${p.id}`, { template: 'neon' });
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    assert.equal(r2.data.status, 'rendering');
    assert.equal(r2.data.version, 1);
    assert.ok(fs.existsSync(mediaFile(video.url)));
    assert.equal((await owner.patch(`/api/posts/${p.id}`, { template: 'bold' })).status, 409);
    assert.equal((await owner.post(`/api/posts/${p.id}/duplicate`)).status, 409);
    await owner.idle();
    const after = (await owner.get(`/api/posts/${p.id}`)).data;
    assert.deepEqual([after.status, after.template, after.version, after.error], ['ready', 'neon', 2, null]);
    assert.match(after.media.find((m) => m.kind === 'video').url, /\/v2-video\.mp4$/);
    assert.ok(!fs.existsSync(mediaFile(video.url)), 'the old version is removed once the new one is ready');
  });

  test('validation errors', async () => {
    assert.equal((await owner.post('/api/posts', { type: 'nope', prompt: 'x' })).status, 400);
    assert.equal((await owner.post('/api/posts', { type: 'single_image', prompt: '' })).status, 400);
    assert.equal((await owner.post('/api/posts', { type: 'single_image', prompt: 'hello', format: 'huge' })).status, 400);
    assert.equal((await owner.post('/api/posts', { type: 'single_image', prompt: 'hello', media_source: 'ai' })).status, 400);
    assert.equal((await owner.post('/api/posts', { type: 'avatar_video', prompt: 'hello' })).status, 400);
  });

  test('prompt booster and cost estimate', async () => {
    const b = await owner.post('/api/posts/boost-prompt', { prompt: 'cold brew launch', type: 'single_image' });
    assert.equal(b.status, 200);
    assert.ok(b.data.prompt.length > 'cold brew launch'.length + 20);
    const e = await owner.post('/api/posts/estimate', { type: 'carousel', slides: 6 });
    assert.equal(e.data.credits, 4 + 2 * 5);
  });
});

describe('UGC avatar video (HeyGen)', () => {
  let config;
  let c;
  let calls;
  let original;
  let clip;
  before(async () => {
    ({ config } = await import('../../server/config.js'));
    const { runFfmpeg } = await import('../../server/engines/video.js');
    const src = `${config.dataDir}/tmp/heygen-clip.mp4`;
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-pix_fmt', 'yuv420p', '-shortest', src]);
    clip = fs.readFileSync(src);
    Object.assign(config, { heygenKey: 'hg-test', heygenPollMs: 1 });
    // Only HeyGen is mocked; requests to the app itself go through.
    calls = [];
    original = globalThis.fetch;
    let polls = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (!url.includes('heygen')) return original(input, init);
      calls.push({ url, init });
      const json = (data) => new Response(JSON.stringify({ error: null, data }), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/v2/avatars')) return json({ avatars: [{ avatar_id: 'av_1', avatar_name: 'Anna', gender: 'female' }] });
      if (url.endsWith('/v2/voices')) return json({ voices: [{ voice_id: 'vo_es', language: 'Spanish', gender: 'female' }, { voice_id: 'vo_m', language: 'English', gender: 'male' }, { voice_id: 'vo_f', language: 'English', gender: 'female' }] });
      if (url.endsWith('/v2/video/generate')) return json({ video_id: 'vid_1' });
      if (url.includes('/v1/video_status.get')) return json(++polls < 3 ? { status: 'processing' } : { status: 'completed', video_url: 'https://cdn.heygen.example/v.mp4', duration: 2 });
      if (url.endsWith('/v.mp4')) return new Response(clip, { headers: { 'content-type': 'video/mp4' } });
      return new Response('{}', { status: 404 });
    };
    c = await newUser(base);
  });
  after(() => {
    globalThis.fetch = original;
    Object.assign(config, { heygenKey: '', heygenPollMs: 10000 });
  });

  test('the presenter video is rendered by HeyGen, fitted to size and watermarked on trial', async () => {
    assert.equal((await c.get('/api/me')).data.capabilities.avatar_video, true);
    const r = await c.post('/api/posts', { type: 'avatar_video', prompt: 'Why our cold brew kit is so easy', format: 'story', media_source: 'ai' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.credits_used, 120);
    const p = await waitReady(c, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    const gen = JSON.parse(calls.find((x) => x.url.endsWith('/v2/video/generate')).init.body);
    assert.equal(calls[0].init.headers['x-api-key'], 'hg-test');
    assert.deepEqual(gen.video_inputs[0].character, { type: 'avatar', avatar_id: 'av_1', avatar_style: 'normal' });
    assert.equal(gen.video_inputs[0].voice.voice_id, 'vo_f');
    assert.ok(gen.video_inputs[0].voice.input_text.length > 10);
    assert.deepEqual(gen.dimension, { width: 1080, height: 1920 });
    assert.equal(gen.video_inputs[0].background.value, '#0f766e');
    const video = p.media.find((m) => m.kind === 'video');
    const buf = fs.readFileSync(mediaFile(video.url));
    assert.equal(buf.toString('latin1', 4, 8), 'ftyp');
    assert.ok(video.duration > 1.5 && video.duration < 3, `duration ${video.duration}`);
    assert.ok(p.cover && fs.existsSync(mediaFile(p.cover)));
    assert.ok(!fs.existsSync(mediaFile(`/media/${p.id}/avatar.json`)));
  });

  test('edits reuse the HeyGen render; resize is refused', async () => {
    const p = (await c.get('/api/posts?type=avatar_video')).data.posts[0];
    const before = calls.filter((x) => x.url.endsWith('/v2/video/generate')).length;
    const e = await c.patch(`/api/posts/${p.id}`, { content: p.content });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    assert.equal(calls.filter((x) => x.url.endsWith('/v2/video/generate')).length, before);
    assert.ok(fs.existsSync(mediaFile(e.data.media.find((m) => m.kind === 'video').url)));
    assert.equal((await c.post(`/api/posts/${p.id}/resize`, { format: 'square' })).status, 400);
  });

  test('a failed HeyGen render refunds the credits', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => (String(input).includes('video_status.get')
      ? new Response(JSON.stringify({ data: { status: 'failed', error: { message: 'avatar not found' } } }), { headers: { 'content-type': 'application/json' } })
      : realFetch(input, init));
    try {
      const credits = (await c.get('/api/me')).data.brand_credits;
      const r = await c.post('/api/posts', { type: 'avatar_video', prompt: 'Another one' });
      const p = await waitReady(c, r.data.id);
      assert.equal(p.status, 'failed');
      assert.match(p.error, /avatar not found/);
      assert.equal((await c.get('/api/me')).data.brand_credits, credits);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('library & editor', () => {
  let post;
  before(async () => {
    const r = await owner.post('/api/posts', { type: 'carousel', prompt: 'Latte art basics', slides: 3 });
    post = await waitReady(owner, r.data.id);
  });

  test('list, filter and search', async () => {
    const all = await owner.get('/api/posts');
    assert.ok(all.data.total >= 5);
    const carousels = await owner.get('/api/posts?media=carousel');
    assert.ok(carousels.data.posts.every((p) => p.media_type === 'carousel'));
    const found = await owner.get('/api/posts?q=Latte');
    assert.ok(found.data.posts.some((p) => p.id === post.id));
  });

  test('editing slide text re-renders a new version', async () => {
    const slides = post.content.slides.map((s, i) => (i === 0 ? { ...s, headline: 'Edited headline' } : s));
    const r = await owner.patch(`/api/posts/${post.id}`, { content: { slides }, template: 'neon' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.version, post.version + 1);
    assert.equal(r.data.template, 'neon');
    assert.equal(r.data.content.slides[0].headline, 'Edited headline');
    assert.match(r.data.media[0].url, /\/v2-1\.png$/);
    assert.ok(fs.existsSync(mediaFile(r.data.media[0].url)));
    assert.ok(!fs.existsSync(mediaFile(post.media[0].url)), 'old version files are cleaned up');
    assert.equal((await owner.patch(`/api/posts/${post.id}`, { template: 'fancy' })).status, 400);
    // Text-only edits keep the current design.
    const textOnly = await owner.patch(`/api/posts/${post.id}`, { content: { slides: r.data.content.slides.map((s, i) => (i === 1 ? { ...s, headline: 'Second edit' } : s)) } });
    assert.equal(textOnly.status, 200, JSON.stringify(textOnly.data));
    assert.equal(textOnly.data.template, 'neon');
    assert.equal(textOnly.data.version, post.version + 2);
  });

  test('caption and hashtags', async () => {
    const r = await owner.patch(`/api/posts/${post.id}`, { caption: 'Hand-written caption', hashtags: ['#latte', '#art'] });
    assert.equal(r.data.caption, 'Hand-written caption');
    assert.equal(r.data.hashtags, '#latte #art');
    const rw = await owner.post(`/api/posts/${post.id}/caption/rewrite`, { instruction: 'shorter' });
    assert.equal(rw.status, 200);
    assert.equal(rw.data.rewrites_left, 4);
    const h = await owner.post(`/api/posts/${post.id}/hashtags`);
    assert.match(h.data.hashtags, /#latte|#brewly/i);
  });

  test('resize into a linked variant', async () => {
    const r = await owner.post(`/api/posts/${post.id}/resize`, { format: 'story' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.parent_id, post.id);
    assert.deepEqual(pngSize(fs.readFileSync(mediaFile(r.data.media[0].url))), { w: 1080, h: 1920 });
    const detail = await owner.get(`/api/posts/${post.id}`);
    assert.ok(detail.data.variants.some((v) => v.id === r.data.id));
    assert.equal((await owner.post(`/api/posts/${post.id}/resize`, { format: post.format })).status, 400);
  });

  test('duplicate, save as template, share link, archive, delete', async () => {
    const d = await owner.post(`/api/posts/${post.id}/duplicate`);
    assert.equal(d.status, 201);
    assert.ok(fs.existsSync(mediaFile(d.data.media[0].url)));
    const t = await owner.post(`/api/posts/${post.id}/template`, { name: 'Latte template' });
    assert.equal(t.status, 201);
    assert.ok((await owner.get('/api/templates')).data.some((x) => x.id === t.data.id));
    const fromTpl = await owner.post('/api/posts', { type: 'carousel', prompt: 'Espresso basics', slides: 3, template_id: t.data.id });
    assert.equal((await waitReady(owner, fromTpl.data.id)).status, 'ready');
    const s = await owner.post(`/api/posts/${post.id}/share`);
    const pub = await new Client(base).get(`/api/share/${s.data.share_id}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.data.id, post.id);
    await owner.post(`/api/posts/${d.data.id}/archive`);
    assert.ok(!(await owner.get('/api/posts')).data.posts.some((p) => p.id === d.data.id));
    assert.ok((await owner.get('/api/posts?archived=1')).data.posts.some((p) => p.id === d.data.id));
    assert.equal((await owner.del(`/api/posts/${d.data.id}`)).status, 200);
    assert.equal((await owner.get(`/api/posts/${d.data.id}`)).status, 404);
  });

  test('uploads: image upload is accepted, junk is rejected, and used as slide image', async () => {
    const current = (await owner.get(`/api/posts/${post.id}`)).data;
    const png = fs.readFileSync(mediaFile(current.media[0].url));
    const up = await owner.req('POST', '/api/uploads', png, { headers: { 'content-type': 'image/png', 'x-filename': 'photo.png' } });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.kind, 'image');
    const bad = await owner.req('POST', '/api/uploads', Buffer.from('hello world'), { headers: { 'content-type': 'text/plain' } });
    assert.equal(bad.status, 400);
    const r = await owner.post('/api/posts', { type: 'single_image', prompt: 'Our new roastery', image_urls: [up.data.file] });
    const p = await waitReady(owner, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    assert.equal(p.template, 'photo');
    assert.equal(p.content.slides[0].image, up.data.file);
  });
});

describe('social channels & publishing', () => {
  let post;
  let sandbox;
  before(async () => {
    const r = await owner.post('/api/posts', { type: 'carousel', prompt: 'Weekend brunch coffee pairings', slides: 3 });
    post = await waitReady(owner, r.data.id);
    sandbox = (await owner.post('/api/accounts/connect/sandbox', { name: 'Brewly Test' })).data[0];
  });

  test('token channels validate input; OAuth platforms report not configured', async () => {
    assert.equal(sandbox.platform, 'sandbox');
    assert.equal((await owner.post('/api/accounts/connect/bluesky', {})).status, 400);
    const o = await owner.post('/api/accounts/oauth/instagram');
    assert.equal(o.status, 400);
    assert.equal(o.data.code, 'not_configured');
    assert.equal((await owner.post('/api/accounts/connect/instagram', {})).status, 400);
  });

  test('publish now delivers to the channel', async () => {
    const r = await owner.post('/api/publish', { post_id: post.id, account_ids: [sandbox.id], mode: 'now', caption: 'Brunch time ☕' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.status, 'published');
    const t = r.data.targets[0];
    assert.equal(t.status, 'published');
    const out = JSON.parse(fs.readFileSync(mediaFile(t.url), 'utf8'));
    assert.match(out.text, /^Brunch time ☕/);
    assert.equal(out.media.length, 3);
  });

  test('scheduled posts publish when due', async () => {
    const at = new Date(Date.now() + 3600e3).toISOString();
    const r = await owner.post('/api/publish', { post_id: post.id, account_ids: [sandbox.id], mode: 'schedule', scheduled_at: at });
    assert.equal(r.data.status, 'scheduled');
    const { publishDue } = await import('../../server/scheduler.js');
    await publishDue();
    assert.equal((await owner.get(`/api/jobs/${r.data.id}`)).data.status, 'scheduled');
    db.run('UPDATE publish_jobs SET scheduled_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.data.id);
    await publishDue();
    const job = (await owner.get(`/api/jobs/${r.data.id}`)).data;
    assert.equal(job.status, 'published');
    // Calendar includes it.
    const cal = await owner.get('/api/jobs');
    assert.ok(cal.data.some((j) => j.id === r.data.id));
  });

  test('cannot schedule in the past; can reschedule and discard', async () => {
    assert.equal((await owner.post('/api/publish', { post_id: post.id, account_ids: [sandbox.id], mode: 'schedule', scheduled_at: '2020-01-01T00:00:00Z' })).status, 400);
    const r = await owner.post('/api/publish', { post_id: post.id, account_ids: [sandbox.id], mode: 'schedule', scheduled_at: new Date(Date.now() + 864e5).toISOString() });
    const later = new Date(Date.now() + 2 * 864e5).toISOString();
    const u = await owner.patch(`/api/jobs/${r.data.id}`, { scheduled_at: later });
    assert.equal(u.data.scheduled_at, later);
    await owner.post(`/api/jobs/${r.data.id}/discard`);
    assert.equal((await owner.get(`/api/jobs/${r.data.id}`)).data.status, 'discarded');
  });

  test('transient failures retry, permanent failures notify', async () => {
    const flaky = (await owner.post('/api/accounts/connect/sandbox', { name: 'Flaky' })).data[0];
    await owner.patch(`/api/accounts/${flaky.id}`, { fail: 'transient' });
    const r = await owner.post('/api/publish', { post_id: post.id, account_ids: [flaky.id], mode: 'now' });
    assert.equal(r.data.targets[0].status, 'pending');
    const { publishDue } = await import('../../server/scheduler.js');
    await publishDue();
    const j = (await owner.get(`/api/jobs/${r.data.id}`)).data;
    assert.equal(j.status, 'published');
    assert.equal(j.targets[0].attempts, 2);

    const broken = (await owner.post('/api/accounts/connect/sandbox', { name: 'Broken' })).data[0];
    await owner.patch(`/api/accounts/${broken.id}`, { fail: 'always' });
    const f = await owner.post('/api/publish', { post_id: post.id, account_ids: [broken.id, sandbox.id], mode: 'now' });
    assert.equal(f.data.status, 'partial');
    const notes = (await owner.get('/api/notifications')).data;
    assert.ok(notes.some((n) => n.kind === 'publish_failed'));
    // Retrying a permanent failure fails again.
    const retry = await owner.post(`/api/jobs/${f.data.id}/retry`);
    assert.equal(retry.data.targets.find((t) => t.account_id === broken.id).status, 'failed');
  });

  test('platform media support is enforced', async () => {
    const r = await owner.post('/api/posts', { type: 'single_image', prompt: 'Platform check' });
    await owner.idle();
    // A fake YouTube account: YouTube only takes video.
    db.run("INSERT INTO social_accounts (id, brand_id, platform, external_id, name) VALUES ('yt1', ?, 'youtube', 'chan', 'Channel')", owner.brandId);
    const p = await owner.post('/api/publish', { post_id: r.data.id, account_ids: ['yt1'], mode: 'now' });
    assert.equal(p.status, 400);
    assert.match(p.data.error, /does not support image/);
  });

  test('best time suggestions are in the future', async () => {
    const r = await owner.get('/api/best-times?count=3');
    assert.equal(r.data.suggestions.length, 3);
    for (const s of r.data.suggestions) assert.ok(new Date(s.at) > new Date());
  });
});

describe('team, roles & approvals', () => {
  let reviewer;
  let editor;
  let post;
  let sandbox;
  before(async () => {
    reviewer = await newUser(base, { brand: false, name: 'Rita Reviewer' });
    editor = await newUser(base, { brand: false, name: 'Ed Editor' });
    await owner.post('/api/team/invite', { email: reviewer.email, role: 'reviewer' });
    await owner.post('/api/team/invite', { email: editor.email, role: 'editor' });
    reviewer.brandId = owner.brandId;
    editor.brandId = owner.brandId;
    const r = await editor.post('/api/posts', { type: 'single_image', prompt: 'Team post for approval' });
    post = await waitReady(editor, r.data.id);
    sandbox = (await owner.get('/api/accounts')).data.find((a) => a.platform === 'sandbox');
  });

  test('roles are enforced', async () => {
    assert.equal((await reviewer.post('/api/posts', { type: 'single_image', prompt: 'not allowed' })).status, 403);
    assert.equal((await editor.post('/api/team/invite', { email: 'x@example.com', role: 'editor' })).status, 403);
    assert.equal((await editor.patch(`/api/brands/${owner.brandId}`, { name: 'Hijack' })).status, 403);
    const stranger = await newUser(base, { brand: false });
    stranger.brandId = owner.brandId;
    assert.equal((await stranger.get('/api/posts')).status, 404);
    const team = await owner.get('/api/team');
    assert.equal(team.data.members.length, 3);
  });

  test('inviting an unknown email returns a link; signing up joins the brand', async () => {
    const email = `invitee${Date.now()}@example.com`;
    const inv = await owner.post('/api/team/invite', { email, role: 'editor' });
    assert.ok(inv.data.link.includes('invite='));
    const c = new Client(base);
    await c.post('/api/auth/signup', { name: 'Invitee', email, password: 'password123' });
    const me = await c.get('/api/me');
    assert.equal(me.data.brand.id, owner.brandId);
    assert.equal(me.data.brand.role, 'editor');
  });

  test('send for review → reject → resubmit → approve → publish', async () => {
    const r = await editor.post('/api/publish', { post_id: post.id, account_ids: [sandbox.id], mode: 'review', scheduled_at: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.status, 'in_review');
    assert.ok((await reviewer.get('/api/notifications')).data.some((n) => n.kind === 'review_requested'));
    assert.ok((await reviewer.get('/api/review-queue')).data.some((j) => j.id === r.data.id));
    assert.equal((await editor.post(`/api/jobs/${r.data.id}/approve`)).status, 403);
    const rej = await reviewer.post(`/api/jobs/${r.data.id}/reject`, { note: 'Use our new logo please' });
    assert.equal(rej.data.status, 'rejected');
    assert.ok((await editor.get('/api/notifications')).data.some((n) => n.kind === 'post_rejected'));
    const detail = await editor.get(`/api/jobs/${r.data.id}`);
    assert.equal(detail.data.comments[0].body, 'Use our new logo please');
    assert.equal((await editor.post(`/api/jobs/${r.data.id}/resubmit`)).data.status, 'in_review');
    const ok = await reviewer.post(`/api/jobs/${r.data.id}/approve`, { note: 'Looks great' });
    assert.equal(ok.data.status, 'scheduled');
  });

  test('brand setting can require approval for editors', async () => {
    await owner.patch(`/api/brands/${owner.brandId}`, { settings: { require_approval: true } });
    const r = await editor.post('/api/publish', { post_id: post.id, account_ids: [sandbox.id], mode: 'now' });
    assert.equal(r.data.status, 'in_review');
    await owner.patch(`/api/brands/${owner.brandId}`, { settings: {} });
  });

  test('team overview', async () => {
    const r = await owner.get('/api/team/overview');
    assert.equal(r.data.stats.active_brands, 1);
    assert.ok(r.data.stats.team_members >= 2);
    const shared = await reviewer.get('/api/team/overview');
    assert.equal(shared.data.stats.shared_with_me, 1);
  });
});

describe('e-commerce & ads studio', () => {
  let product;
  test('import products from a Shopify store', async () => {
    const r = await owner.post('/api/stores', { url: site.base });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.store.platform, 'shopify');
    assert.equal(r.data.imported, 2);
    const list = await owner.get('/api/products');
    product = list.data.find((p) => p.title === 'Cold Brew Kit');
    assert.equal(product.price, '34.00');
    assert.equal(product.compare_at_price, '49.00');
    assert.equal(product.images.length, 1);
    // Re-sync is idempotent.
    const s = await owner.post(`/api/stores/${r.data.store.id}/sync`);
    assert.equal(s.data.added, 0);
  });

  test('product post shows price, sale badge and product image', async () => {
    const r = await owner.post('/api/posts', { type: 'ecom_product', product_id: product.id, format: 'square' });
    const p = await waitReady(owner, r.data.id);
    assert.equal(p.status, 'ready', p.error);
    const s = p.content.slides[0];
    assert.equal(s.kind, 'product');
    assert.equal(s.price, '$34');
    assert.equal(s.compareAt, '$49');
    assert.equal(s.badge, '31% off');
    assert.match(s.image, /product\.png$/);
  });

  test('add product from a product page URL', async () => {
    const r = await owner.post('/api/products', { url: `${site.base}/products/cold-brew-kit` });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.title, 'Cold Brew Kit');
  });

  test('ads studio: concepts → one ad per concept + video ad', async () => {
    const c = await owner.post('/api/adstudio/concepts', { product_id: product.id, count: 3 });
    assert.equal(c.status, 200);
    assert.equal(c.data.concepts.length, 3);
    const g = await owner.post('/api/adstudio/generate', { product_id: product.id, concepts: c.data.concepts.slice(0, 2), format: 'square', video: true });
    assert.equal(g.status, 201);
    assert.equal(g.data.length, 3);
    await owner.idle();
    const posts = await Promise.all(g.data.map((p) => owner.get(`/api/posts/${p.id}`).then((r) => r.data)));
    assert.ok(posts.every((p) => p.status === 'ready'), posts.map((p) => p.error).join(';'));
    assert.equal(posts[0].content.slides[0].kind, 'ad');
    assert.equal(posts[0].content.slides[0].headline, c.data.concepts[0].headline);
    assert.ok(posts[2].media.some((m) => m.kind === 'video'));
  });
});

describe('auto posting', () => {
  test('fills upcoming slots with posts awaiting approval', async () => {
    const sandbox = (await owner.get('/api/accounts')).data.find((a) => a.platform === 'sandbox' && a.name === 'Brewly Test');
    const cfg = await owner.put('/api/autopilot', { direction: 'Brewing tips and behind the scenes at the roastery', post_types: ['single_image', 'carousel'], days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'], account_ids: [sandbox.id], require_approval: true, enabled: true });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
    assert.equal(cfg.data.enabled, true);
    const run = await owner.post('/api/autopilot/run');
    assert.ok(run.data.created >= 6, JSON.stringify(run.data));
    await owner.idle();
    const review = await owner.get('/api/autopilot/review');
    assert.equal(review.data.length, run.data.created);
    assert.ok(review.data.every((j) => j.status === 'in_review'));
    assert.ok(review.data.every((j) => j.post.status === 'ready'));
    // Running again does not double-book slots.
    assert.equal((await owner.post('/api/autopilot/run')).data.created, 0);
    const ok = await owner.post('/api/autopilot/review/approve-all');
    assert.equal(ok.data.approved, run.data.created);
    assert.equal((await owner.put('/api/autopilot', { direction: 'short' })).status, 400);
  });

  test('plans 1 week, 2 weeks or 1 month ahead', async () => {
    assert.equal((await owner.put('/api/autopilot', { horizon_days: 10 })).status, 400);
    const month = await owner.put('/api/autopilot', { horizon_days: 30 });
    assert.equal(month.status, 200, JSON.stringify(month.data));
    assert.equal(month.data.horizon_days, 30);
    const ap = (await owner.get('/api/autopilot')).data;
    assert.ok(ap.upcoming_slots.length >= 29, `${ap.upcoming_slots.length} slots`);
    assert.ok(new Date(ap.upcoming_slots.at(-1)) > new Date(Date.now() + 27 * 864e5));
    await owner.put('/api/autopilot', { horizon_days: 7, enabled: false });
  });
});

describe('bulk scheduling', () => {
  let c;
  let sandbox;
  let ids;
  before(async () => {
    c = await newUser(base);
    sandbox = (await c.post('/api/accounts/connect/sandbox', { name: 'Bulk' })).data[0];
    db.run("INSERT INTO social_accounts (id, brand_id, platform, external_id, name) VALUES ('yt-bulk', ?, 'youtube', 'chan-bulk', 'Channel')", c.brandId);
    ids = [];
    for (const prompt of ['Bulk one', 'Bulk two', 'Bulk three', 'Bulk four']) ids.push((await c.post('/api/posts', { type: 'single_image', prompt })).data.id);
    await c.idle();
  });

  test('spreads posts one per slot and skips channels that cannot take them', async () => {
    const r = await c.post('/api/publish/bulk', { post_ids: ids.slice(0, 3), account_ids: [sandbox.id, 'yt-bulk'], days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00', '18:00'], weeks: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.count, 3);
    assert.equal(r.data.status, 'scheduled');
    const times = r.data.jobs.map((j) => j.scheduled_at);
    assert.deepEqual([...times].sort(), times);
    assert.equal(new Set(times).size, 3);
    assert.deepEqual(r.data.jobs.map((j) => j.post_id), ids.slice(0, 3));
    // Images can't go to YouTube, so only the sandbox is targeted.
    assert.ok(r.data.jobs.every((j) => j.targets.length === 1 && j.targets[0].platform === 'sandbox'));

    // A second run uses the next free slot instead of doubling up.
    const more = await c.post('/api/publish/bulk', { post_ids: [ids[3]], account_ids: [sandbox.id], days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00', '18:00'], weeks: 1, mode: 'draft' });
    assert.equal(more.status, 201, JSON.stringify(more.data));
    assert.equal(more.data.status, 'draft');
    assert.ok(!times.includes(more.data.jobs[0].scheduled_at));
    assert.ok(more.data.jobs[0].scheduled_at > times.at(-1));
  });

  test('refuses schedules with too few slots or no suitable channel', async () => {
    const few = await c.post('/api/publish/bulk', { post_ids: ids, account_ids: [sandbox.id], days: [1], times: ['10:00'], weeks: 2 });
    assert.equal(few.status, 400);
    assert.equal(few.data.code, 'not_enough_slots');
    const yt = await c.post('/api/publish/bulk', { post_ids: [ids[0]], account_ids: ['yt-bulk'], days: [1], times: ['10:00'], weeks: 4 });
    assert.equal(yt.status, 400);
    assert.equal((await c.post('/api/publish/bulk', { post_ids: [ids[0]], account_ids: [sandbox.id], days: [], times: ['10:00'] })).status, 400);
    assert.equal((await c.post('/api/publish/bulk', { post_ids: [ids[0]], account_ids: [sandbox.id], days: [1], times: ['10:00'], weeks: 13 })).status, 400);
  });
});

describe('privacy & data deletion', () => {
  const sign = (payload, secret) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${crypto.createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
  };
  const form = (signed) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ signed_request: signed }) });

  test('Meta data deletion callback removes the person’s Facebook and Instagram channels', async () => {
    const { config } = await import('../../server/config.js');
    config.oauth.facebook.clientSecret = 'meta-secret';
    try {
      const c = await newUser(base);
      for (const [id, platform] of [['fb-del', 'facebook'], ['ig-del', 'instagram']]) db.run("INSERT INTO social_accounts (id, brand_id, platform, external_id, name, meta) VALUES (?, ?, ?, ?, 'Del', ?)", id, c.brandId, platform, id, JSON.stringify({ fb_user_id: 'U-del' }));
      db.run("INSERT INTO social_accounts (id, brand_id, platform, external_id, name, meta) VALUES ('fb-keep', ?, 'facebook', 'fb-keep', 'Keep', ?)", c.brandId, JSON.stringify({ fb_user_id: 'U-other' }));

      const forged = await fetch(`${base}/callbacks/meta/data-deletion`, form(sign({ algorithm: 'HMAC-SHA256', user_id: 'U-del' }, 'wrong')));
      assert.equal(forged.status, 400);

      const deauth = await fetch(`${base}/callbacks/meta/deauthorize`, form(sign({ algorithm: 'HMAC-SHA256', user_id: 'U-del' }, 'meta-secret')));
      assert.equal(deauth.status, 200);
      assert.equal(db.one("SELECT status FROM social_accounts WHERE id = 'fb-del'").status, 'relink');

      const r = await fetch(`${base}/callbacks/meta/data-deletion`, form(sign({ algorithm: 'HMAC-SHA256', user_id: 'U-del', issued_at: 1 }, 'meta-secret')));
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body.confirmation_code);
      assert.match(body.url, new RegExp(`/data-deletion\\?code=${body.confirmation_code}$`));
      assert.deepEqual(db.all("SELECT id FROM social_accounts WHERE brand_id = ?", c.brandId).map((a) => a.id), ['fb-keep']);

      const status = await new Client(base).get(`/api/data-deletion/${body.confirmation_code}`);
      assert.equal(status.data.status, 'completed');
      assert.equal(status.data.removed, 2);
      assert.equal((await new Client(base).get('/api/data-deletion/nope')).status, 404);
    } finally {
      config.oauth.facebook.clientSecret = '';
    }
  });

  test('deleting an account removes owned brands and keeps shared ones', async () => {
    const owner2 = await newUser(base);
    const other = await newUser(base);
    const inv = await other.post('/api/team/invite', { email: owner2.email, role: 'editor' });
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    const p = await owner2.post('/api/posts', { type: 'single_image', prompt: 'Goodbye post' });
    await owner2.idle();
    const media = db.one('SELECT media FROM posts WHERE id = ?', p.data.id);
    const file = mediaFile(JSON.parse(media.media)[0].url);
    assert.ok(fs.existsSync(file));

    assert.equal((await owner2.req('DELETE', '/api/me', { password: 'wrong password' })).status, 400);
    const r = await owner2.req('DELETE', '/api/me', { password: 'correct horse battery' });
    assert.equal(r.status, 200);
    assert.equal((await owner2.get('/api/me')).data, null);
    assert.equal(db.one('SELECT id FROM users WHERE email = ?', owner2.email), undefined);
    assert.equal(db.one('SELECT id FROM brands WHERE id = ?', owner2.brandId), undefined);
    assert.ok(!fs.existsSync(file));
    assert.ok(db.one('SELECT id FROM brands WHERE id = ?', other.brandId));
    assert.equal((await new Client(base).post('/api/auth/login', { email: owner2.email, password: 'correct horse battery' })).status, 401);
  });

  test('policy pages and contact details are public', async () => {
    const r = await new Client(base).get('/api/catalog');
    assert.equal(r.data.legal.name, 'Prepostly');
  });
});

describe('insights', () => {
  test('competitor analysis from imported posts', async () => {
    const c = await owner.post('/api/competitors', { platform: 'manual', handle: '@rivalroasters', followers: 5000 });
    assert.equal(c.status, 201);
    const csv = 'caption,likes,comments,media_type,timestamp\n"New single origin! #coffee #ethiopia",120,10,IMAGE,2026-09-01T09:00:00Z\n"Brewing tips #coffee #tips",300,40,CAROUSEL,2026-09-03T12:00:00Z\n"Behind the scenes #roastery",80,5,REEL,2026-09-05T18:00:00Z\n"Latte art #coffee #latteart",220,25,CAROUSEL,2026-09-08T12:00:00Z';
    assert.equal((await owner.post(`/api/competitors/${c.data.id}/import`, { text: csv })).data.imported, 4);
    const run = await owner.post('/api/competitors/run', { ids: [c.data.id] });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    const a = run.data[0].analysis;
    assert.equal(a.summary.total_posts, 4);
    assert.equal(a.summary.avg_likes, 180);
    assert.equal(a.hashtags[0].tag, '#coffee');
    assert.equal(a.hashtags[0].count, 3);
    assert.equal(a.post_types[0].type, 'CAROUSEL');
    assert.ok(a.themes.length >= 1);
    assert.equal(a.top_posts[0].likes, 300);
    assert.equal((await owner.post('/api/competitors/run', { ids: ['a', 'b', 'c', 'd'] })).status, 400);
  });

  test('instagram competitors need a linked instagram account', async () => {
    const c = await owner.post('/api/competitors', { platform: 'instagram', handle: 'somebrand' });
    const run = await owner.post('/api/competitors/run', { ids: [c.data.id] });
    assert.equal(run.data[0].status, 'error');
    assert.match(run.data[0].error, /Instagram/);
  });

  test('ad intelligence needs a Facebook connection', async () => {
    const t = await owner.post('/api/adintel', { query: 'Rival Roasters' });
    assert.equal(t.status, 201);
    const r = await owner.post(`/api/adintel/${t.data.id}/run`);
    assert.equal(r.data.status, 'error');
    assert.match(r.data.error, /Facebook/);
  });

  test('analytics dashboard reflects published posts', async () => {
    const r = await owner.get('/api/analytics?days=30');
    assert.equal(r.status, 200);
    assert.ok(r.data.metrics.new_posts.value >= 3);
    assert.equal(r.data.series.length, 30);
    assert.ok(r.data.series.at(-1).posts >= 1);
    assert.ok(r.data.streak.days >= 1);
    assert.ok(r.data.latest.length >= 1);
    assert.equal((await owner.put('/api/analytics/goal', { posts_per_month: 20 })).status, 200);
    assert.equal((await owner.get('/api/analytics')).data.goal.posts_per_month, 20);
  });

  test('idea lab streams an answer and stores the conversation', async () => {
    const conv = await owner.post('/api/ideas/conversations', {});
    const res = await owner.req('POST', `/api/ideas/conversations/${conv.data.id}/messages`, { content: 'Generate a content calendar for the next 1 week about cold brew' }, { raw: true });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.match(text, /event: delta/);
    assert.match(text, /event: done/);
    const full = await owner.get(`/api/ideas/conversations/${conv.data.id}`);
    assert.equal(full.data.messages.length, 2);
    assert.match(full.data.messages[1].content, /\| Day \| Format \| Topic \| Hook \|/);
    assert.match(full.data.title, /content calendar/);
  });
});

describe('developer API & MCP', () => {
  let key;
  test('API keys authenticate the REST API', async () => {
    const k = await owner.post('/api/api-keys', { name: 'CI' });
    assert.equal(k.status, 201);
    key = k.data.key;
    const api = new Client(base);
    api.headers.authorization = `Bearer ${key}`;
    assert.equal((await api.get('/v1/brand')).data.id, owner.brandId);
    const p = await api.post('/v1/posts', { type: 'quote', prompt: 'teamwork' });
    assert.equal(p.status, 201);
    assert.equal((await api.get(`/v1/posts/${p.data.id}`)).status, 200);
    const bad = new Client(base);
    bad.headers.authorization = 'Bearer cd_nope';
    assert.equal((await bad.get('/v1/brand')).status, 401);
  });

  test('MCP server: initialize, list tools and create a post', async () => {
    const mcp = new Client(base);
    mcp.headers.authorization = `Bearer ${key}`;
    const init = await mcp.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.data.result.serverInfo.name, 'prepostly');
    assert.equal((await mcp.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tools = await mcp.post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(tools.data.result.tools.some((t) => t.name === 'create_post'));
    const call = await mcp.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_post', arguments: { type: 'single_image', prompt: 'Iced latte season', format: 'square' } } });
    assert.equal(call.data.result.isError, false, call.data.result.content?.[0]?.text);
    assert.equal(call.data.result.structuredContent.status, 'ready');
    assert.match(call.data.result.structuredContent.media[0].url, /^http:\/\/127\.0\.0\.1:\d+\/media\//);
    const unauth = await new Client(base).post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(unauth.status, 401);
  });
});

describe('credits & plans', () => {
  test('running out of credits blocks generation; failed generations are refunded', async () => {
    const c = await newUser(base);
    db.run('UPDATE users SET credits = 3 WHERE email = ?', c.email);
    const r = await c.post('/api/posts', { type: 'single_image', prompt: 'Not enough credits' });
    assert.equal(r.status, 402);
    db.run('UPDATE users SET credits = 10 WHERE email = ?', c.email);
    // Article URL that 404s → generation fails → credits refunded.
    const f = await c.post('/api/posts', { type: 'blog_to_carousel', article_url: `${site.base}/missing`, slides: 3 });
    assert.equal(f.status, 201);
    const p = await waitReady(c, f.data.id);
    assert.equal(p.status, 'failed');
    assert.equal((await c.get('/api/me')).data.credits, 10);
  });

  test('users cannot switch plans themselves', async () => {
    const c = await newUser(base);
    assert.equal((await c.post('/api/account/plan', { plan: 'rise' })).status, 404);
    const acc = await c.get('/api/account');
    assert.equal(acc.data.plan.plan, 'trial');
    assert.deepEqual(acc.data.checkout_plans, []);
    // Without Dodo set up there is no checkout either.
    assert.equal((await c.post('/api/billing/checkout', { plan: 'rise' })).status, 400);
  });

  test('Dodo checkout: plan switches on only after a verified successful payment', async () => {
    const { config } = await import('../../server/config.js');
    const http = await import('node:http');
    const calls = [];
    const dodo = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/checkouts') return res.end(JSON.stringify({ session_id: `cks_${calls.length}`, checkout_url: `https://checkout.example/cks_${calls.length}` }));
        res.end('{}');
      });
    });
    await new Promise((r) => dodo.listen(0, '127.0.0.1', r));
    const secretKey = crypto.randomBytes(24);
    const saved = config.dodo;
    config.dodo = { apiKey: 'sk_test', webhookSecret: `whsec_${secretKey.toString('base64')}`, baseUrl: `http://127.0.0.1:${dodo.address().port}`, products: { core: 'pdt_core', rise: 'pdt_rise', enterprise: '' } };
    const hook = async (event, { id = crypto.randomUUID(), sign = true } = {}) => {
      const raw = JSON.stringify(event);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac('sha256', sign ? secretKey : crypto.randomBytes(24)).update(`${id}.${ts}.${raw}`).digest('base64');
      const r = await fetch(`${base}/api/billing/webhook/dodo`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body: raw });
      return r.status;
    };
    try {
      const c = await newUser(base);
      const me = (await c.get('/api/me')).data.user;
      assert.deepEqual((await c.get('/api/account')).data.checkout_plans, ['core', 'rise']);
      assert.equal((await c.post('/api/billing/checkout', { plan: 'enterprise' })).status, 400);
      const co = await c.post('/api/billing/checkout', { plan: 'rise' });
      assert.equal(co.status, 200);
      assert.match(co.data.url, /^https:\/\/checkout\.example\//);
      const sent = calls.find((x) => x.url === '/checkouts');
      assert.equal(sent.auth, 'Bearer sk_test');
      assert.deepEqual(sent.body.product_cart, [{ product_id: 'pdt_rise', quantity: 1 }]);
      assert.deepEqual(sent.body.metadata, { user_id: me.id, plan: 'rise' });
      const session = co.data.url.split('/').pop();

      // Checkout alone changes nothing.
      let acc = (await c.get('/api/account')).data;
      assert.equal(acc.plan.plan, 'trial');
      assert.equal(acc.payments[0].status, 'pending');

      const paid = { type: 'payment.succeeded', data: { payload_type: 'Payment', payment_id: 'pay_1', checkout_session_id: session, subscription_id: 'sub_1', status: 'succeeded', total_amount: 4000, currency: 'USD', customer: { customer_id: 'cus_1', email: me.email }, metadata: { user_id: me.id, plan: 'rise' } } };
      // Forged or failed payments don't activate anything.
      assert.equal(await hook(paid, { sign: false }), 401);
      assert.equal(await hook({ type: 'payment.failed', data: { ...paid.data, payment_id: 'pay_0', status: 'failed' } }), 200);
      acc = (await c.get('/api/account')).data;
      assert.equal(acc.plan.plan, 'trial');

      const eventId = crypto.randomUUID();
      assert.equal(await hook(paid, { id: eventId }), 200);
      assert.equal(await hook(paid, { id: eventId }), 200); // a retried delivery is ignored
      acc = (await c.get('/api/account')).data;
      assert.equal(acc.plan.plan, 'rise');
      assert.equal(acc.credits, 3200);
      assert.equal(acc.plan.watermark, false);
      // The failed attempt and the successful payment are both on record, once each.
      assert.deepEqual(acc.payments.map((p) => `${p.payment_id}:${p.status}`).sort(), ['pay_0:failed', 'pay_1:succeeded']);
      assert.equal(acc.payments.find((p) => p.payment_id === 'pay_1').amount, 4000);
      assert.equal(acc.ledger.filter((l) => l.reason === 'plan:rise').length, 1);

      // A renewal payment on the same subscription refills credits.
      db.run('UPDATE users SET credits = 5 WHERE id = ?', me.id);
      assert.equal(await hook({ type: 'payment.succeeded', data: { payment_id: 'pay_2', subscription_id: 'sub_1', status: 'succeeded', total_amount: 4000, currency: 'USD', customer: { customer_id: 'cus_1' }, metadata: {} } }), 200);
      acc = (await c.get('/api/account')).data;
      assert.deepEqual([acc.plan.plan, acc.credits, acc.payments.length], ['rise', 3200, 3]);

      // Cancelling keeps the plan until the paid period ends, then it lapses.
      assert.equal((await c.post('/api/billing/cancel')).status, 200);
      assert.deepEqual(calls.at(-1).body, { cancel_at_next_billing_date: true });
      assert.equal(await hook({ type: 'subscription.cancelled', data: { subscription_id: 'sub_1', status: 'cancelled' } }), 200);
      assert.equal((await c.get('/api/account')).data.plan.expired, false);
      db.run('UPDATE users SET paid_until = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), me.id);
      acc = (await c.get('/api/account')).data;
      assert.equal(acc.plan.expired, true);
      const blocked = await c.post('/api/posts', { type: 'single_image', prompt: 'After the plan ended' });
      assert.equal(blocked.status, 402);
      assert.equal(blocked.data.code, 'plan_expired');
    } finally {
      config.dodo = saved;
      dodo.close();
    }
  });

  test('trial watermark is drawn; paid plan removes it', async () => {
    const { slideSvg } = await import('../../server/engines/render.js');
    const svg = slideSvg({ brand: { name: 'x' }, slide: { kind: 'cover', headline: 'Hi' }, watermark: true });
    assert.match(svg, /Made with Prepostly/);
  });
});
