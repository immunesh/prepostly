import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, startFixtureSite, mockFetch, pngSize } from '../helpers.js';

const brand = { id: 'b1', name: 'Brewly', industry: 'coffee', description: 'Small-batch coffee roaster', audience: 'home baristas', tone: 'Friendly', handle: 'brewly', hashtags: '#brewly', colors: '["#0f766e","#14b8a6"]' };

describe('offline writer', () => {
  let content;
  before(async () => { content = await import('../../server/engines/content.js'); });

  test('topic extraction strips request boilerplate', () => {
    assert.equal(content.topicOf('Create a carousel about cold brew coffee tips.'), 'cold brew coffee tips');
    assert.equal(content.topicOf('Make a post for our summer sale'), 'our summer sale');
    assert.equal(content.topicOf(''), 'your goals');
  });

  test('every post type yields slides, caption and hashtags', async () => {
    const { POST_TYPES } = await import('../../server/catalog.js');
    const product = { title: 'Cold Brew Kit', description: 'Smooth cold brew at home. Includes filters.', price: '34', compare_at_price: '49', currency: 'USD', images: [] };
    for (const type of Object.keys(POST_TYPES)) {
      const out = await content.writePost({ brand, type, prompt: 'Brewing better coffee at home', product, article: type === 'blog_to_carousel' ? { title: 'Brew guide', text: 'x'.repeat(300), sections: [{ heading: 'Fresh beans', text: 'Buy small bags.' }] } : null, specialDay: 'International Coffee Day' });
      assert.equal(out.writer, 'offline', type);
      assert.ok(out.slides.length >= 1, type);
      assert.ok(out.slides.every((s) => s.kind && (s.headline || s.top)), `${type}: ${JSON.stringify(out.slides)}`);
      assert.ok(out.caption.length > 10, type);
      assert.ok(out.hashtags.length >= 3 && out.hashtags.every((h) => h.startsWith('#')), type);
      if (POST_TYPES[type].media === 'video') assert.ok(out.slides.every((s) => s.narration), type);
    }
  });

  test('carousel respects slide count; brand hashtags come first', async () => {
    const out = await content.writePost({ brand, type: 'carousel', prompt: 'espresso basics', slides: 7 });
    assert.equal(out.slides.length, 7);
    assert.equal(out.slides[0].kind, 'cover');
    assert.equal(out.slides.at(-1).kind, 'cta');
    assert.equal(out.hashtags[0], '#brewly');
  });

  test('ad sale math and price formatting', async () => {
    const out = await content.writePost({ brand, type: 'ad_creative', product: { title: 'Mug', price: '15', compare_at_price: '20', currency: 'EUR' } });
    assert.equal(out.slides[0].badge, '25% off');
    assert.equal(out.slides[0].price, '€15');
    assert.equal(content.formatPrice('19.5', 'GBP'), '£19.50');
  });

  test('quote picks a relevant, real attribution', async () => {
    const out = await content.writePost({ brand: { ...brand, industry: 'fitness', description: 'gym' }, type: 'quote', prompt: 'health and fitness' });
    assert.equal(out.slides[0].author, 'Jim Rohn');
  });

  test('upcoming special days are sorted and in the future', () => {
    const days = content.upcomingSpecialDays(new Date('2026-12-20T00:00:00Z'), 3);
    assert.deepEqual(days.map((d) => d.name), ['Christmas Day', "New Year's Eve", "New Year's Day"]);
  });
});

describe('Claude writer request', () => {
  // The SDK binds fetch when the client is created, so one mock serves the whole suite.
  let config;
  let mock;
  let replyBody;
  before(async () => {
    ({ config } = await import('../../server/config.js'));
    config.anthropicConfigured = true;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mock = mockFetch([{ match: (u) => u.includes('api.anthropic.com/v1/messages'), reply: () => ({ body: replyBody }) }]);
  });
  after(() => {
    config.anthropicConfigured = false;
    mock.restore();
  });
  const message = (content, stop_reason = 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, usage: { input_tokens: 10, output_tokens: 20 } });

  test('sends a structured-output request and normalizes the reply', async () => {
    const reply = { title: 'Cold brew 101', slides: [{ headline: 'Cold brew, simplified', body: 'Three steps.', kicker: 'Guide', cta: '', stat: '', image_query: 'cold brew', narration: '' }, { headline: 'Coarse grind', body: 'Avoid mud.', kicker: '', cta: '', stat: '', image_query: 'grinder', narration: '' }, { headline: 'Try it', body: '', kicker: '', cta: 'Shop now', stat: '', image_query: 'coffee', narration: '' }], caption: 'Hook\n\nValue\n\nCTA', hashtags: ['coldbrew', '#coffee'], quote_author: '', meme_top: '', meme_bottom: '' };
    replyBody = message([{ type: 'text', text: JSON.stringify(reply) }]);
    const { writePost } = await import('../../server/engines/content.js');
    const out = await writePost({ brand, type: 'carousel', prompt: 'cold brew', slides: 3 });
    assert.equal(out.writer, 'claude');
    assert.deepEqual(out.slides.map((s) => s.kind), ['cover', 'point', 'cta']);
    assert.deepEqual(out.hashtags, ['#brewly', '#coldbrew', '#coffee']);
    const call = mock.calls.at(-1);
    const body = JSON.parse(call.body);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema.additionalProperties, false);
    assert.equal(body.fallbacks, 'default');
    const beta = call.headers instanceof Headers ? call.headers.get('anthropic-beta') : call.headers['anthropic-beta'];
    assert.match(String(beta), /server-side-fallback-2026-07-01/);
  });

  test('a refusal becomes a clear 422', async () => {
    replyBody = message([], 'refusal');
    const { writePost } = await import('../../server/engines/content.js');
    await assert.rejects(writePost({ brand, type: 'single_image', prompt: 'x' }), (e) => e.status === 422);
  });

  test('a truncated reply is reported, not parsed', async () => {
    replyBody = message([{ type: 'text', text: '{"title": "cut' }], 'max_tokens');
    const { writePost } = await import('../../server/engines/content.js');
    await assert.rejects(writePost({ brand, type: 'single_image', prompt: 'x' }), (e) => e.status === 502);
  });
});

describe('renderer', () => {
  let r;
  before(async () => { r = await import('../../server/engines/render.js'); });

  test('text wrapping and fitting', () => {
    const lines = r.wrap('one two three four five six', 300, 40, 0.6);
    assert.ok(lines.length > 1);
    assert.ok(lines.every((l) => l.length * 40 * 0.6 <= 300 || !l.includes(' ')));
    const f = r.fit('A very long headline that needs to shrink to fit', { maxWidth: 600, maxLines: 2, max: 120, min: 30 });
    assert.ok(f.size < 120 && f.lines.length <= 2);
    const t = r.fit('word '.repeat(200), { maxWidth: 200, maxLines: 2, max: 40, min: 30 });
    assert.equal(t.lines.length, 2);
    assert.ok(t.lines[1].endsWith('…'));
  });

  test('palette derivation and contrast', () => {
    const p = r.paletteFor({ colors: '["#ffffff"]' });
    assert.equal(p.primary, '#ffffff');
    assert.equal(r.contrastOn('#ffffff'), '#111111');
    assert.equal(r.contrastOn('#0f172a'), '#ffffff');
    assert.equal(r.normHex('abc'), '#aabbcc');
    assert.equal(r.normHex('nope', null), null);
  });

  test('every template × slide kind renders a valid PNG at every format', async () => {
    const { FORMATS, TEMPLATES } = await import('../../server/catalog.js');
    const kinds = [{ kind: 'cover', headline: 'Hello & <welcome>', body: 'Body', kicker: 'Kick' }, { kind: 'point', headline: 'Point', body: 'Detail' }, { kind: 'cta', headline: 'Act', cta: 'Go' }, { kind: 'quote', headline: 'Quote', author: 'Me' }, { kind: 'meme', top: 'Top', bottom: 'Bottom' }, { kind: 'product', headline: 'Prod', price: '$5', compareAt: '$9', badge: 'Sale', cta: 'Buy' }, { kind: 'ad', headline: 'Ad', disclaimer: 'T&C' }, { kind: 'stat', stat: '42%', headline: 'Stat' }];
    for (const [fmt, f] of Object.entries(FORMATS)) {
      for (const tpl of Object.keys(TEMPLATES)) {
        for (const slide of kinds) {
          const svg = r.slideSvg({ brand, slide, index: 1, total: 3, format: fmt, template: tpl });
          assert.ok(svg.includes(`viewBox="0 0 ${f.w} ${f.h}"`));
          assert.ok(!svg.includes('<welcome>'), 'text is escaped');
        }
      }
      const { png } = await r.renderSlide({ brand, slide: kinds[0], format: fmt, template: 'bold' });
      assert.deepEqual(pngSize(png), { w: f.w, h: f.h });
    }
  });

  test('static font weights resolve to registered family names', () => {
    assert.match(r.family('Poppins', 800), /^'Poppins ExtraBold'/);
    assert.match(r.family('Playfair Display', 900), /^'Playfair Display Black'/);
    assert.match(r.family('Unknown Font', 400), /^'Unknown Font'/);
  });
});

describe('scheduling math', () => {
  let bt;
  before(async () => { bt = await import('../../server/engines/besttime.js'); });

  test('zoned conversions round-trip across DST', () => {
    assert.equal(bt.zonedToUtc('2026-07-01', '09:00', 'America/New_York'), '2026-07-01T13:00:00.000Z');
    assert.equal(bt.zonedToUtc('2026-12-01', '09:00', 'America/New_York'), '2026-12-01T14:00:00.000Z');
    assert.equal(bt.zonedToUtc('2026-06-01', '10:30', 'Asia/Kolkata'), '2026-06-01T05:00:00.000Z');
    const z = bt.zonedParts('2026-06-01T05:00:00.000Z', 'Asia/Kolkata');
    assert.deepEqual([z.day, z.hour, z.minute], ['2026-06-01', 10, 30]);
  });

  test('video scene starts account for crossfades', async () => {
    const { sceneStarts } = await import('../../server/engines/video.js');
    const { starts, total } = sceneStarts([3, 3, 3], 0.5);
    assert.deepEqual(starts, [0, 2.5, 5]);
    assert.equal(total, 8);
  });

  test('autopilot slots respect days, times and the horizon', async () => {
    const { upcomingSlots } = await import('../../server/engines/autopilot.js');
    const from = new Date('2026-10-19T00:00:00Z'); // Monday
    const slots = upcomingSlots({ days: [1, 3], times: ['09:00', '18:00'] }, { timezone: 'UTC' }, from);
    assert.deepEqual(slots.slice(0, 4), ['2026-10-19T09:00:00.000Z', '2026-10-19T18:00:00.000Z', '2026-10-21T09:00:00.000Z', '2026-10-21T18:00:00.000Z']);
    assert.ok(slots.every((s) => new Date(s) <= new Date(from.getTime() + 7 * 864e5)));
    // Planning a month ahead covers about four weeks of the same pattern.
    const month = upcomingSlots({ days: [1, 3], times: ['09:00', '18:00'], horizon_days: 30 }, { timezone: 'UTC' }, from);
    assert.equal(month.length, 18);
    assert.ok(new Date(month.at(-1)) > new Date(from.getTime() + 28 * 864e5));
  });

  test('weekly slots follow the brand timezone across daylight saving changes', async () => {
    const { weeklySlots } = await import('../../server/engines/autopilot.js');
    const ist = weeklySlots({ days: [1], times: ['10:00', '18:00'], tz: 'Asia/Kolkata', from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z') });
    assert.deepEqual(ist, ['2026-10-19T04:30:00.000Z', '2026-10-19T12:30:00.000Z', '2026-10-26T04:30:00.000Z', '2026-10-26T12:30:00.000Z']);
    // New York leaves daylight saving time on November 1, 2026: 9:00 moves from 13:00 to 14:00 UTC.
    const ny = weeklySlots({ days: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'], tz: 'America/New_York', from: new Date('2026-10-31T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') });
    assert.deepEqual(ny, ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
  });
});

describe('competitor & ad analytics', () => {
  test('engagement, hashtags, types and best slot', async () => {
    const { analyze, parseImport } = await import('../../server/engines/competitor.js');
    const posts = parseImport('caption,likes,comments,media_type,timestamp\n"A #x",10,0,IMAGE,2026-01-05T09:00:00Z\n"B #x #y",30,10,REEL,2026-01-06T12:00:00Z\n"C, with comma",20,0,IMAGE,2026-01-07T09:00:00Z');
    assert.equal(posts[2].caption, 'C, with comma');
    const a = await analyze({ followers: 1000 }, posts);
    assert.equal(a.summary.avg_engagement, 23.3);
    assert.equal(a.summary.engagement_rate, 2.33);
    assert.equal(a.hashtags[0].tag, '#x');
    assert.deepEqual(a.post_types.map((t) => t.type), ['IMAGE', 'REEL']);
    assert.deepEqual(a.posting_times.best_slot_utc, { weekday: 2, hour: 12, avg_engagement: 40 });
  });

  test('ad longevity ranks winners', async () => {
    const { summarizeAds } = await import('../../server/engines/adintel.js');
    const s = summarizeAds([
      { id: '1', body: 'Shop now and save 20%', title: '', caption: '', started: '2026-01-01', stopped: null, platforms: ['facebook', 'instagram'] },
      { id: '2', body: 'Learn more about us', title: '', caption: '', started: '2026-09-01', stopped: '2026-09-05', platforms: ['facebook'] },
    ], new Date('2026-10-01'));
    assert.equal(s.winners[0].id, '1');
    assert.equal(s.winners[0].days_running, 273);
    assert.equal(s.active, 1);
    assert.equal(s.long_runners, 1);
    assert.equal(s.platforms.facebook, 2);
    assert.ok(s.angles.some((a) => a.angle === 'offer-led'));
  });
});

describe('scraper & network safety', () => {
  let site;
  let scraper;
  before(async () => {
    site = await startFixtureSite();
    scraper = await import('../../server/engines/scraper.js');
  });
  after(() => site.server.close());

  test('article extraction', async () => {
    const a = await scraper.extractArticle(`${site.base}/blog/brewing`);
    assert.equal(a.title, 'How to brew better coffee');
    assert.deepEqual(a.sections.map((s) => s.heading), ['Buy fresh beans', 'Grind just before brewing', 'Weigh everything', 'Mind the water']);
  });

  test('private addresses are blocked outside test mode', async () => {
    const { config } = await import('../../server/config.js');
    const { safeFetch } = await import('../../server/net.js');
    config.allowPrivateFetch = false;
    try {
      await assert.rejects(safeFetch(`${site.base}/`), /private network/);
      await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data'), /private network/);
      await assert.rejects(safeFetch('file:///etc/passwd'), /Only http and https/);
    } finally {
      config.allowPrivateFetch = true;
    }
  });

  test('webp images are converted for the renderer', async () => {
    const { toDataUri } = await import('../../server/engines/images.js');
    const { runFfmpeg } = await import('../../server/engines/video.js');
    const src = path.join(DATA_DIR, 'media', 'probe.png');
    fs.writeFileSync(src, (await (await import('../../server/engines/render.js')).renderSlide({ brand, slide: { kind: 'cover', headline: 'x' }, format: 'square' })).png);
    const webp = path.join(DATA_DIR, 'media', 'probe.webp');
    await runFfmpeg(['-i', src, webp]);
    const uri = await toDataUri('/media/probe.webp');
    assert.match(uri, /^data:image\/png;base64,/);
    assert.equal(await toDataUri('/media/../secret'), null);
  });
});

describe('secrets at rest', () => {
  test('social tokens are sealed with AES-GCM', async () => {
    const { seal, unseal } = await import('../../server/auth.js');
    const s = seal('EAAB-secret-token');
    assert.ok(s.startsWith('v1.') && !s.includes('secret'));
    assert.equal(unseal(s), 'EAAB-secret-token');
    const tampered = s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA');
    assert.throws(() => unseal(tampered));
    assert.equal(seal(''), null);
  });
});

describe('HeyGen avatar engine', () => {
  let config;
  let mock;
  before(async () => {
    ({ config } = await import('../../server/config.js'));
    Object.assign(config, { heygenKey: 'hg-test', heygenPollMs: 1 });
  });
  after(() => {
    mock?.restore();
    Object.assign(config, { heygenKey: '', heygenAvatarId: '', heygenVoiceId: '', heygenPollMs: 10000 });
  });

  test('configured avatar and voice skip the account lookups', async () => {
    Object.assign(config, { heygenAvatarId: 'av_set', heygenVoiceId: 'vo_set' });
    mock = mockFetch([]);
    const { pickPresenter } = await import('../../server/engines/avatar.js');
    assert.deepEqual(await pickPresenter('English'), { avatar_id: 'av_set', voice_id: 'vo_set' });
    assert.equal(mock.calls.length, 0);
    mock.restore();
    Object.assign(config, { heygenAvatarId: '', heygenVoiceId: '' });
  });

  test('a saved job id is resumed instead of starting a new render', async () => {
    const dir = path.join(DATA_DIR, 'media', 'avatar-resume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'avatar.json'), JSON.stringify({ video_id: 'vid_saved' }));
    mock = mockFetch([
      { match: (u) => u.includes('video_status.get?video_id=vid_saved'), reply: () => ({ body: { data: { status: 'completed', video_url: 'https://cdn.heygen.example/v.mp4', thumbnail_url: 'https://cdn.heygen.example/t.jpg', duration: 21.5 } } }) },
      { match: (u) => u.endsWith('/v.mp4'), reply: () => ({ body: Buffer.from('mp4'), headers: { 'content-type': 'video/mp4' } }) },
      { match: (u) => u.endsWith('/t.jpg'), reply: () => ({ body: Buffer.from('jpg'), headers: { 'content-type': 'image/jpeg' } }) },
    ]);
    const { renderAvatarVideo } = await import('../../server/engines/avatar.js');
    const r = await renderAvatarVideo({ dir, script: 'Hi there', w: 1080, h: 1920 });
    assert.ok(!mock.calls.some((c) => c.url.includes('/v2/video/generate')));
    assert.equal(r.duration, 21.5);
    assert.equal(fs.readFileSync(r.video, 'utf8'), 'mp4');
    assert.equal(fs.readFileSync(r.thumb, 'utf8'), 'jpg');
    assert.ok(!fs.existsSync(path.join(dir, 'avatar.json')));
  });

  test('a rejected key gives a clear message', async () => {
    mock = mockFetch([{ match: (u) => u.includes('api.heygen.com'), reply: () => ({ status: 401, body: { message: 'Unauthorized' } }) }]);
    const { startAvatarVideo } = await import('../../server/engines/avatar.js');
    await assert.rejects(startAvatarVideo({ script: 'Hi', w: 1080, h: 1080 }), /HEYGEN_API_KEY/);
  });
});

describe('stock photo providers', () => {
  let config;
  let images;
  let mock;
  before(async () => {
    ({ config } = await import('../../server/config.js'));
    images = await import('../../server/engines/images.js');
  });
  after(() => {
    mock?.restore();
    Object.assign(config, { pixabayKey: '', openverse: false });
  });

  test('without keys, Openverse supplies commercial-use photos with a CC credit', async () => {
    Object.assign(config, { openverse: true });
    assert.equal(images.stockAvailable(), true);
    mock = mockFetch([{
      match: (u) => u.startsWith('https://api.openverse.org/v1/images/'),
      reply: () => ({ body: { results: [
        { url: 'https://live.staticflickr.com/1/a.jpg', thumbnail: 'https://api.openverse.org/thumb/a', title: 'Latte art', creator: 'Ana', license: 'by', license_version: '2.0', foreign_landing_url: 'https://flickr.com/a' },
        { url: 'https://live.staticflickr.com/1/b.jpg', creator: 'Ben', license: 'cc0' },
        { url: '', creator: 'skipped', license: 'by' },
      ] } }),
    }]);
    const r = await images.searchStock('latte art openverse', { orientation: 'portrait', count: 3 });
    const u = new URL(mock.calls[0].url);
    assert.equal(u.searchParams.get('license_type'), 'commercial,modification');
    assert.equal(u.searchParams.get('aspect_ratio'), 'tall');
    assert.equal(r.length, 2);
    assert.equal(r[0].credit, '"Latte art" by Ana (CC BY 2.0) via Openverse');
    assert.equal(r[0].link, 'https://flickr.com/a');
    assert.equal(r[1].credit, 'Photo by Ben (CC0) via Openverse');

    // The same search is served from the cache.
    await images.searchStock('latte art openverse', { orientation: 'portrait', count: 3 });
    assert.equal(mock.calls.length, 1);
    mock.restore();
    config.openverse = false;
    assert.equal(images.stockAvailable(), false);
  });

  test('a Pixabay key is used before Openverse', async () => {
    Object.assign(config, { pixabayKey: 'px-test', openverse: true });
    mock = mockFetch([{
      match: (u) => u.startsWith('https://pixabay.com/api/'),
      reply: () => ({ body: { hits: [{ largeImageURL: 'https://pixabay.com/get/big.jpg', webformatURL: 'https://pixabay.com/get/web.jpg', user: 'Maya', pageURL: 'https://pixabay.com/photos/1' }] } }),
    }]);
    const r = await images.searchStock('pixabay beach', { orientation: 'landscape', count: 2 });
    const u = new URL(mock.calls[0].url);
    assert.equal(mock.calls.length, 1);
    assert.equal(u.searchParams.get('key'), 'px-test');
    assert.equal(u.searchParams.get('orientation'), 'horizontal');
    assert.equal(u.searchParams.get('per_page'), '3');
    assert.deepEqual(r, [{ url: 'https://pixabay.com/get/big.jpg', thumb: 'https://pixabay.com/get/web.jpg', credit: 'Image by Maya from Pixabay', link: 'https://pixabay.com/photos/1' }]);
    mock.restore();
    Object.assign(config, { pixabayKey: '' });
  });

  test('a failing Pixabay request falls back to Openverse', async () => {
    Object.assign(config, { pixabayKey: 'px-bad', openverse: true });
    mock = mockFetch([
      { match: (u) => u.startsWith('https://pixabay.com/api/'), reply: () => ({ status: 429, body: 'rate limit' }) },
      { match: (u) => u.startsWith('https://api.openverse.org/'), reply: () => ({ body: { results: [{ url: 'https://example.org/c.jpg', creator: 'Cy', license: 'by-sa', license_version: '4.0' }] } }) },
    ]);
    const r = await images.searchStock('fallback mountains', { orientation: 'square' });
    assert.equal(r[0].credit, 'Photo by Cy (CC BY-SA 4.0) via Openverse');
    assert.equal(new URL(mock.calls[1].url).searchParams.get('aspect_ratio'), 'square');
  });
});

test('an Openverse error is retried once', async () => {
  const { config } = await import('../../server/config.js');
  const images = await import('../../server/engines/images.js');
  config.openverse = true;
  let n = 0;
  const mock = mockFetch([{ match: (u) => u.startsWith('https://api.openverse.org/'), reply: () => (++n === 1 ? { status: 500, body: 'error' } : { body: { results: [{ url: 'https://example.org/d.jpg', creator: 'Di', license: 'by' }] } }) }]);
  try {
    const r = await images.searchStock('retry harbour', { orientation: 'landscape' });
    assert.equal(mock.calls.length, 2);
    assert.equal(r[0].credit, 'Photo by Di (CC BY) via Openverse');
  } finally {
    mock.restore();
    config.openverse = false;
  }
});

test('Openverse searches keywords, then drops the first or last word', async () => {
  const { config } = await import('../../server/config.js');
  const images = await import('../../server/engines/images.js');
  config.openverse = true;
  const mock = mockFetch([{
    match: (u) => u.startsWith('https://api.openverse.org/'),
    reply: (u) => ({ body: { results: new URL(u).searchParams.get('q') === 'cozy coffee shop' ? [{ url: 'https://example.org/e.jpg', creator: 'Ed', license: 'cc0' }] : [] } }),
  }]);
  try {
    const [a, b] = await Promise.all([1, 2].map(() => images.searchStock('Five tips for a cozy coffee shop morning', { orientation: 'square' })));
    assert.deepEqual(mock.calls.map((c) => new URL(c.url).searchParams.get('q')), ['cozy coffee shop morning', 'coffee shop morning', 'cozy coffee shop']);
    assert.equal(a[0].url, 'https://example.org/e.jpg');
    assert.deepEqual(a, b);
  } finally {
    mock.restore();
    config.openverse = false;
  }
});

describe('background music', () => {
  test('each mood makes a full-length, audible, unclipped track that is the same for the same post', async () => {
    const { composeMusic, MUSIC_MOODS } = await import('../../server/engines/music.js');
    const { MUSIC } = await import('../../server/catalog.js');
    assert.deepEqual([...MUSIC_MOODS, 'none'].sort(), Object.keys(MUSIC).sort());
    for (const mood of MUSIC_MOODS) {
      const a = composeMusic({ seconds: 6, mood, seed: 'post-1', rate: 24000 });
      assert.equal(a.length, 6 * 24000);
      let peak = 0;
      let energy = 0;
      for (const x of a) { peak = Math.max(peak, Math.abs(x)); energy += x * x; }
      assert.ok(peak <= 0.51 && peak > 0.4, `${mood} peak ${peak}`);
      assert.ok(Math.sqrt(energy / a.length) > 0.03, `${mood} is audible`);
      assert.equal(a[0], 0, 'fades in from silence');
      assert.deepEqual(composeMusic({ seconds: 6, mood, seed: 'post-1', rate: 24000 }), a);
    }
    const other = composeMusic({ seconds: 6, mood: 'upbeat', seed: 'post-2', rate: 24000 });
    assert.notDeepEqual(other, composeMusic({ seconds: 6, mood: 'upbeat', seed: 'post-1', rate: 24000 }));
    assert.throws(() => composeMusic({ seconds: 2, mood: 'disco' }), /Unknown music/);
  });
});
