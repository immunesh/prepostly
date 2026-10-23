import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, mockFetch } from '../helpers.js';

// Platform adapters against mocked APIs: each test asserts the request sequence the
// platform's official API requires.

let A;
let common;
const img = path.join(DATA_DIR, 'img.png');
const vid = path.join(DATA_DIR, 'vid.mp4');
const media = (n = 1) => Array.from({ length: n }, (_, i) => ({ kind: 'image', path: `/media/p/v1-${i + 1}.png`, file: img, mime: 'image/png', w: 1080, h: 1350 }));
const video = [{ kind: 'video', path: '/media/p/v1-video.mp4', file: vid, mime: 'video/mp4', w: 1080, h: 1920, duration: 12 }];
let mock;

before(async () => {
  fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(vid, Buffer.alloc(2048, 1));
  process.env.PUBLIC_URL = 'https://prepostly.example.com';
  const { config } = await import('../../server/config.js');
  config.publicUrl = 'https://prepostly.example.com';
  Object.assign(config.oauth.facebook, { clientId: 'app', clientSecret: 'secret' });
  A = (await import('../../server/publishers/index.js')).ADAPTERS;
  common = await import('../../server/publishers/common.js');
});
afterEach(() => mock?.restore());

const json = (body, status = 200, headers) => ({ status, body, headers });

describe('common helpers', () => {
  test('composeText drops hashtags before truncating the caption', () => {
    assert.equal(common.composeText('Hello world', '#a #b', 100), 'Hello world\n\n#a #b');
    assert.equal(common.composeText('Hello world', '#aaaa #bbbb', 18), 'Hello world\n\n#aaaa');
    const long = common.composeText('word '.repeat(100), '#x', 30);
    assert.ok([...long].length <= 30);
    assert.ok(long.endsWith('…'));
  });

  test('api() surfaces platform error messages and marks retryable / relink errors', async () => {
    mock = mockFetch([
      { match: (u) => u.endsWith('/rate'), reply: () => json({ error: { message: 'Too many calls' } }, 429) },
      { match: (u) => u.endsWith('/auth'), reply: () => json({ message: 'Invalid token' }, 401) },
      { match: (u) => u.endsWith('/bad'), reply: () => json({ errors: [{ message: 'Text too long' }] }, 400) },
    ]);
    await assert.rejects(common.api('X', 'https://h/rate'), (e) => e.retryable && /Too many calls/.test(e.message));
    await assert.rejects(common.api('X', 'https://h/auth'), (e) => e.relink && !e.retryable);
    await assert.rejects(common.api('X', 'https://h/bad'), (e) => !e.retryable && /X: Text too long/.test(e.message));
  });
});

describe('Facebook', () => {
  test('carousel: unpublished photo uploads then a feed post with attached_media', async () => {
    let n = 0;
    mock = mockFetch([
      { match: (u) => u.includes('/PAGE/photos'), reply: () => json({ id: `photo${++n}` }) },
      { match: (u) => u.includes('/PAGE/feed'), reply: () => json({ id: 'PAGE_123' }) },
    ]);
    const r = await A.facebook.publish({ account: { external_id: 'PAGE', access_token: 'tok' }, media: media(3), caption: 'Hi', hashtags: '#x' });
    assert.equal(r.external_id, 'PAGE_123');
    assert.equal(mock.calls.filter((c) => c.url.includes('/photos')).length, 3);
    const feed = new URLSearchParams(mock.calls.at(-1).body);
    assert.equal(feed.get('message'), 'Hi\n\n#x');
    assert.equal(JSON.parse(feed.get('attached_media[2]')).media_fbid, 'photo3');
    const photo = mock.calls[0].body;
    assert.ok(photo instanceof FormData);
    assert.equal(photo.get('published'), 'false');
  });

  test('video uploads the file to graph-video', async () => {
    mock = mockFetch([{ match: (u) => u.includes('graph-video.facebook.com') && u.includes('/PAGE/videos'), reply: () => json({ id: 'v1' }) }]);
    const r = await A.facebook.publish({ account: { external_id: 'PAGE', access_token: 'tok' }, media: video, caption: 'Watch', hashtags: '' });
    assert.equal(r.external_id, 'v1');
    assert.ok(mock.calls[0].body.get('source'));
  });

  test('OAuth exchange returns one account per Page', async () => {
    mock = mockFetch([
      { match: (u) => u.includes('/oauth/access_token') && u.includes('code='), reply: () => json({ access_token: 'short' }) },
      { match: (u) => u.includes('/oauth/access_token') && u.includes('fb_exchange_token'), reply: () => json({ access_token: 'long' }) },
      { match: (u) => u.includes('/me/accounts'), reply: () => json({ data: [{ id: 'P1', name: 'Brewly', access_token: 'pt', instagram_business_account: { id: 'IG1', username: 'brewly' } }] }) },
      { match: (u) => u.includes('/me?'), reply: () => json({ id: 'U1' }) },
    ]);
    const fb = await A.facebook.exchange({ code: 'c', redirectUri: 'https://x/cb' });
    assert.deepEqual(fb.map((a) => a.external_id), ['P1']);
    const ig = await A.instagram.exchange({ code: 'c', redirectUri: 'https://x/cb' });
    assert.equal(ig[0].external_id, 'IG1');
    assert.equal(ig[0].meta.page_id, 'P1');
  });
});

describe('Instagram', () => {
  test('carousel: child containers, carousel container, status polling, publish, permalink', async () => {
    let n = 0;
    mock = mockFetch([
      { match: (u, i) => u.includes('/IG/media') && !u.includes('publish') && i.method === 'POST', reply: () => json({ id: `c${++n}` }) },
      { match: (u) => /\/c\d\?fields=status_code/.test(u), reply: () => json({ status_code: 'FINISHED' }) },
      { match: (u) => u.includes('/IG/media_publish'), reply: () => json({ id: 'M1' }) },
      { match: (u) => u.includes('/M1?fields=permalink'), reply: () => json({ permalink: 'https://instagram.com/p/abc' }) },
    ]);
    const r = await A.instagram.publish({ account: { external_id: 'IG', access_token: 't', username: 'brewly' }, media: media(3), caption: 'Hello', hashtags: '#coffee' });
    assert.equal(r.url, 'https://instagram.com/p/abc');
    const creates = mock.calls.filter((c) => c.url.includes('/IG/media') && !c.url.includes('publish')).map((c) => new URLSearchParams(c.body));
    assert.equal(creates.length, 4);
    assert.equal(creates[0].get('is_carousel_item'), 'true');
    assert.equal(creates[0].get('image_url'), 'https://prepostly.example.com/media/p/v1-1.jpg');
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'img.jpg')), 'JPEG copy saved next to the PNG');
    assert.equal(creates[3].get('media_type'), 'CAROUSEL');
    assert.equal(creates[3].get('children'), 'c1,c2,c3');
    assert.equal(creates[3].get('caption'), 'Hello\n\n#coffee');
  });

  test('video posts as a Reel and fails cleanly on processing error', async () => {
    mock = mockFetch([
      { match: (u, i) => u.includes('/IG/media') && i.method === 'POST', reply: () => json({ id: 'r1' }) },
      { match: (u) => u.includes('/r1?fields=status_code'), reply: () => json({ status_code: 'ERROR', status: 'Bad video' }) },
    ]);
    await assert.rejects(A.instagram.publish({ account: { external_id: 'IG', access_token: 't' }, media: video, caption: '', hashtags: '' }, ), /Bad video/);
    assert.equal(new URLSearchParams(mock.calls[0].body).get('media_type'), 'REELS');
  });

  test('requires a public URL', async () => {
    const { config } = await import('../../server/config.js');
    const prev = config.publicUrl;
    config.publicUrl = 'http://127.0.0.1:4100';
    await assert.rejects(A.instagram.publish({ account: { external_id: 'IG', access_token: 't' }, media: media(1), caption: '', hashtags: '' }), /isn't available yet/);
    config.publicUrl = prev;
  });
});

describe('LinkedIn', () => {
  test('commentary escapes reserved characters and keeps hashtags', async () => {
    const { linkedinCommentary } = await import('../../server/publishers/linkedin.js');
    assert.equal(linkedinCommentary('Hi (all) @team #coffee_time #1!'), 'Hi \\(all\\) \\@team {hashtag|\\#|coffee_time} {hashtag|\\#|1}!');
  });

  test('multi-image: initializeUpload + PUT per image, then a multiImage post', async () => {
    let n = 0;
    mock = mockFetch([
      { match: (u) => u.includes('/rest/images?action=initializeUpload'), reply: () => json({ value: { uploadUrl: `https://upload/${++n}`, image: `urn:li:image:${n}` } }) },
      { match: (u) => u.startsWith('https://upload/'), reply: () => json({}, 201) },
      { match: (u) => u.endsWith('/rest/posts'), reply: () => json({}, 201, { 'x-restli-id': 'urn:li:share:9' }) },
    ]);
    const r = await A.linkedin.publish({ account: { external_id: 'abc', access_token: 't', meta: { urn: 'urn:li:person:abc' } }, media: media(2), caption: 'Hello #x', hashtags: '' });
    assert.equal(r.external_id, 'urn:li:share:9');
    assert.equal(r.url, 'https://www.linkedin.com/feed/update/urn:li:share:9');
    const post = JSON.parse(mock.calls.at(-1).body);
    assert.deepEqual(post.content.multiImage.images, [{ id: 'urn:li:image:1' }, { id: 'urn:li:image:2' }]);
    assert.equal(post.author, 'urn:li:person:abc');
    assert.equal(mock.calls.at(-1).headers['LinkedIn-Version'], '202609');
  });

  test('Pages: connects every Page the person can post to, as the organization', async () => {
    const { config } = await import('../../server/config.js');
    Object.assign(config.oauth.linkedin_page, { clientId: 'li', clientSecret: 'secret' });
    mock = mockFetch([
      { match: (u) => u.includes('/oauth/v2/accessToken'), reply: () => json({ access_token: 'lt', refresh_token: 'lr', expires_in: 3600 }) },
      { match: (u) => u.includes('/rest/organizationAcls'), reply: () => json({ elements: [
        { organization: 'urn:li:organization:11', role: 'ADMINISTRATOR' },
        { organization: 'urn:li:organization:22', role: 'ANALYST' },
        { organization: 'urn:li:organization:33', role: 'CONTENT_ADMINISTRATOR' },
      ] }) },
      { match: (u) => u.includes('/rest/organizations/'), reply: (u) => json({ localizedName: `Org ${u.split('/').pop()}`, vanityName: `org${u.split('/').pop()}` }) },
    ]);
    const accounts = await A.linkedin_page.exchange({ code: 'c', redirectUri: 'https://x/cb' });
    assert.deepEqual(accounts.map((a) => [a.external_id, a.name, a.meta.urn]), [['11', 'Org 11', 'urn:li:organization:11'], ['33', 'Org 33', 'urn:li:organization:33']]);
    assert.ok(A.linkedin_page.authUrl({ state: 's', redirectUri: 'https://x/cb' }).includes('w_organization_social'));

    mock.restore();
    mock = mockFetch([
      { match: (u) => u.includes('/oauth/v2/accessToken'), reply: () => json({ access_token: 'lt' }) },
      { match: (u) => u.includes('/rest/organizationAcls'), reply: () => json({ elements: [{ organization: 'urn:li:organization:22', role: 'ANALYST' }] }) },
    ]);
    await assert.rejects(A.linkedin_page.exchange({ code: 'c', redirectUri: 'https://x/cb' }), /aren't an admin of any LinkedIn Page/);
    Object.assign(config.oauth.linkedin_page, { clientId: '', clientSecret: '' });
  });
});

describe('X', () => {
  test('uploads images via v2 media upload, then tweets ≤280 chars with media_ids', async () => {
    let n = 0;
    mock = mockFetch([
      { match: (u) => u.endsWith('/2/media/upload'), reply: () => json({ data: { id: `m${++n}` } }) },
      { match: (u) => u.endsWith('/2/tweets'), reply: () => json({ data: { id: 'T1' } }) },
    ]);
    const r = await A.x.publish({ account: { access_token: 't', username: 'brewly' }, media: media(5), caption: 'a'.repeat(300), hashtags: '#x' });
    assert.equal(r.url, 'https://x.com/brewly/status/T1');
    const tweet = JSON.parse(mock.calls.at(-1).body);
    assert.deepEqual(tweet.media.media_ids, ['m1', 'm2', 'm3', 'm4']);
    assert.ok([...tweet.text].length <= 280);
  });

  test('chunked video upload: initialize, append, finalize, status', async () => {
    mock = mockFetch([
      { match: (u) => u.endsWith('/media/upload/initialize'), reply: () => json({ data: { id: 'V' } }) },
      { match: (u) => u.endsWith('/media/upload/V/append'), reply: () => json({}) },
      { match: (u) => u.endsWith('/media/upload/V/finalize'), reply: () => json({ data: { processing_info: { state: 'pending', check_after_secs: 0 } } }) },
      { match: (u) => u.includes('command=STATUS'), reply: () => json({ data: { processing_info: { state: 'succeeded' } } }) },
      { match: (u) => u.endsWith('/2/tweets'), reply: () => json({ data: { id: 'T2' } }) },
    ]);
    await A.x.publish({ account: { access_token: 't', username: 'b' }, media: video, caption: 'Vid', hashtags: '' });
    assert.deepEqual(JSON.parse(mock.calls.at(-1).body).media.media_ids, ['V']);
  });

  test('PKCE auth URL', async () => {
    const { config } = await import('../../server/config.js');
    config.oauth.x.clientId = 'cid';
    const u = new URL(A.x.authUrl({ state: 's', redirectUri: 'https://x/cb', challenge: 'ch' }));
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope'), /media\.write/);
  });
});

describe('Pinterest, YouTube, TikTok, Google Business, Threads', () => {
  test('Pinterest multi-image pin to the chosen board', async () => {
    mock = mockFetch([{ match: (u) => u.endsWith('/v5/pins'), reply: () => json({ id: 'PIN1' }) }]);
    const r = await A.pinterest.publish({ account: { access_token: 't', meta: { board_id: 'B1' } }, media: media(2), caption: 'Pin it', hashtags: '', options: { link: 'https://brewly.com' }, title: 'Coffee' });
    assert.equal(r.url, 'https://www.pinterest.com/pin/PIN1/');
    const body = JSON.parse(mock.calls[0].body);
    assert.equal(body.board_id, 'B1');
    assert.equal(body.media_source.source_type, 'multiple_image_urls');
    assert.equal(body.link, 'https://brewly.com');
    await assert.rejects(A.pinterest.publish({ account: { access_token: 't', meta: {} }, media: media(1), caption: '', hashtags: '' }), /board/);
  });

  test('YouTube resumable upload tags vertical short videos #Shorts', async () => {
    mock = mockFetch([
      { match: (u) => u.includes('uploadType=resumable'), reply: () => json({}, 200, { location: 'https://upload.youtube/session' }) },
      { match: (u) => u === 'https://upload.youtube/session', reply: () => json({ id: 'YT1' }) },
    ]);
    const r = await A.youtube.publish({ account: { access_token: 't' }, media: video, caption: 'Cold brew in 60s', hashtags: '#coffee', title: 'Cold brew' });
    assert.equal(r.url, 'https://www.youtube.com/shorts/YT1');
    const meta = JSON.parse(mock.calls[0].body);
    assert.match(meta.snippet.title, /#Shorts$/);
    assert.deepEqual(meta.snippet.tags, ['coffee']);
    assert.equal(mock.calls[0].headers['X-Upload-Content-Length'], '2048');
    await assert.rejects(A.youtube.publish({ account: { access_token: 't' }, media: media(1), caption: '', hashtags: '' }), /only accepts video/);
  });

  test('TikTok direct video post: creator info, init, chunk upload, status', async () => {
    mock = mockFetch([
      { match: (u) => u.includes('/creator_info/query/'), reply: () => json({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } }) },
      { match: (u) => u.includes('/video/init/'), reply: () => json({ data: { publish_id: 'PUB', upload_url: 'https://tt-upload/x' }, error: { code: 'ok' } }) },
      { match: (u) => u === 'https://tt-upload/x', reply: () => json({}) },
      { match: (u) => u.includes('/status/fetch/'), reply: () => json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [777] }, error: { code: 'ok' } }) },
    ]);
    const r = await A.tiktok.publish({ account: { access_token: 't', username: 'brewly' }, media: video, caption: 'Hi', hashtags: '' });
    assert.equal(r.url, 'https://www.tiktok.com/@brewly/video/777');
    assert.match(r.note, /privately/);
    const init = JSON.parse(mock.calls[1].body);
    assert.equal(init.post_info.privacy_level, 'SELF_ONLY');
    assert.equal(init.source_info.video_size, 2048);
    assert.equal(mock.calls[2].headers['content-range'], 'bytes 0-2047/2048');
  });

  test('Google Business local post with photo', async () => {
    mock = mockFetch([{ match: (u) => u.includes('/v4/accounts/1/locations/2/localPosts'), reply: () => json({ name: 'accounts/1/locations/2/localPosts/9', searchUrl: 'https://g.page/x' }) }]);
    const r = await A.google_business.publish({ account: { external_id: 'accounts/1/locations/2', access_token: 't' }, media: media(1), caption: 'Open late today', hashtags: '#ignored', options: {} });
    assert.equal(r.url, 'https://g.page/x');
    const body = JSON.parse(mock.calls[0].body);
    assert.equal(body.summary, 'Open late today');
    assert.equal(body.media[0].sourceUrl, 'https://prepostly.example.com/media/p/v1-1.png');
  });

  test('Threads text post', async () => {
    mock = mockFetch([
      { match: (u) => u.includes('/U1/threads') && !u.includes('publish'), reply: () => json({ id: 'C1' }) },
      { match: (u) => u.includes('/U1/threads_publish'), reply: () => json({ id: 'TH1' }) },
      { match: (u) => u.includes('/TH1?fields=permalink'), reply: () => json({ permalink: 'https://threads.net/t/1' }) },
    ]);
    const r = await A.threads.publish({ account: { external_id: 'U1', access_token: 't', username: 'b' }, media: [], caption: 'Just text', hashtags: '' });
    assert.equal(r.url, 'https://threads.net/t/1');
    assert.equal(new URLSearchParams(mock.calls[0].body).get('media_type'), 'TEXT');
  });
});

describe('Bluesky, Mastodon, Telegram', () => {
  test('Bluesky facets use UTF-8 byte offsets', async () => {
    const { bskyFacets } = await import('../../server/publishers/token.js');
    const f = bskyFacets('Café ☕ #coffee https://x.co');
    const tag = f.find((x) => x.features[0].tag);
    assert.equal(tag.features[0].tag, 'coffee');
    assert.equal(tag.index.byteStart, Buffer.byteLength('Café ☕ '));
    assert.equal(tag.index.byteEnd, Buffer.byteLength('Café ☕ #coffee'));
    assert.ok(f.some((x) => x.features[0].uri === 'https://x.co'));
  });

  test('Bluesky post: session, blob upload, createRecord with image embed', async () => {
    mock = mockFetch([
      { match: (u) => u.endsWith('createSession'), reply: () => json({ accessJwt: 'jwt', did: 'did:plc:1', handle: 'brewly.bsky.social' }) },
      { match: (u) => u.endsWith('uploadBlob'), reply: () => json({ blob: { $type: 'blob', ref: { $link: 'cid' }, mimeType: 'image/png', size: 70 } }) },
      { match: (u) => u.endsWith('createRecord'), reply: () => json({ uri: 'at://did:plc:1/app.bsky.feed.post/3abc' }) },
    ]);
    const r = await A.bluesky.publish({ account: { username: 'brewly.bsky.social', refresh_token: 'app-pass', meta: { identifier: 'brewly.bsky.social' } }, media: media(1), caption: 'Hello', hashtags: '#coffee' });
    assert.equal(r.url, 'https://bsky.app/profile/brewly.bsky.social/post/3abc');
    const rec = JSON.parse(mock.calls.at(-1).body).record;
    assert.equal(rec.embed.$type, 'app.bsky.embed.images');
    assert.equal(rec.text, 'Hello\n\n#coffee');
    assert.equal(rec.facets[0].features[0].tag, 'coffee');
  });

  test('Mastodon: media upload then status with media_ids[]', async () => {
    mock = mockFetch([
      { match: (u) => u.endsWith('/api/v2/media'), reply: () => json({ id: 'M9', url: 'https://m/x.png' }) },
      { match: (u) => u.endsWith('/api/v1/statuses'), reply: () => json({ id: 'S1', url: 'https://mastodon.social/@b/S1' }) },
    ]);
    const r = await A.mastodon.publish({ account: { access_token: 't', meta: { instance: 'https://mastodon.social' } }, media: media(1), caption: 'Toot', hashtags: '' });
    assert.equal(r.url, 'https://mastodon.social/@b/S1');
    assert.match(mock.calls[1].body, /media_ids%5B%5D=M9/);
  });

  test('Telegram media group for carousels', async () => {
    mock = mockFetch([{ match: (u) => u.endsWith('/sendMediaGroup'), reply: () => json({ ok: true, result: [{ message_id: 42 }] }) }]);
    const r = await A.telegram.publish({ account: { access_token: 'BOT', external_id: '-100', username: 'brewlychannel' }, media: media(3), caption: 'Album', hashtags: '' });
    assert.equal(r.url, 'https://t.me/brewlychannel/42');
    const items = JSON.parse(mock.calls[0].body.get('media'));
    assert.equal(items.length, 3);
    assert.equal(items[0].caption, 'Album');
    assert.equal(items[2].media, 'attach://f2');
  });
});
