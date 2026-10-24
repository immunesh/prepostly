import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { api, PublishError, sleep, composeText, fileBlob, asJpeg, publicUrl, requirePublicUrl } from './common.js';

// Channels connected with a token or app password instead of OAuth.

// ---------------------------------------------------------------- Bluesky (AT Protocol)
const BSKY = 'https://bsky.social/xrpc';

async function bskySession(identifier, password) {
  return (await api('Bluesky', `${BSKY}/com.atproto.server.createSession`, { method: 'POST', json: { identifier, password } })).body;
}

/** Rich-text facets for #hashtags and links (byte offsets in UTF-8). */
export function bskyFacets(text) {
  const facets = [];
  const enc = new TextEncoder();
  const byteIndex = (i) => enc.encode(text.slice(0, i)).length;
  for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_]+)/gu)) {
    const start = m.index + m[1].length;
    facets.push({ index: { byteStart: byteIndex(start), byteEnd: byteIndex(start + m[2].length) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2].slice(1) }] });
  }
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    facets.push({ index: { byteStart: byteIndex(m.index), byteEnd: byteIndex(m.index + m[0].length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  return facets;
}

export const bluesky = {
  id: 'bluesky',
  configured: () => true,
  async connect({ identifier, password }) {
    if (!identifier || !password) throw new PublishError('Enter your Bluesky handle and an app password (Settings → Privacy and security → App passwords).');
    const s = await bskySession(identifier.replace(/^@/, ''), password);
    const profile = (await api('Bluesky', `${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(s.did)}`, { headers: { authorization: `Bearer ${s.accessJwt}` } }).catch(() => ({ body: {} }))).body;
    return [{ external_id: s.did, name: profile.displayName || s.handle, username: s.handle, avatar: profile.avatar || null, access_token: s.accessJwt, refresh_token: password, meta: { identifier: identifier.replace(/^@/, ''), followers: profile.followersCount } }];
  },
  async publish({ account, media, caption, hashtags }) {
    const s = await bskySession(account.meta?.identifier || account.username, account.refresh_token);
    const authH = { authorization: `Bearer ${s.accessJwt}` };
    const text = composeText(caption, hashtags, 300);
    const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), facets: bskyFacets(text) };
    const images = media.filter((m) => m.kind === 'image').slice(0, 4);
    if (media[0]?.kind === 'video') throw new PublishError('Bluesky video posting is not supported yet; publish an image post instead.');
    if (images.length) {
      const embedded = [];
      for (const m of images) {
        let file = m.file;
        let mime = 'image/png';
        // Bluesky caps image blobs at ~1 MB.
        for (const q of [3, 6, 10]) {
          if (fs.statSync(file).size <= 950_000) break;
          file = await asJpeg(m.file, q);
          mime = 'image/jpeg';
        }
        const blob = (await api('Bluesky', `${BSKY}/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { ...authH, 'content-type': mime }, body: fs.readFileSync(file) })).body.blob;
        embedded.push({ alt: caption.split('\n')[0].slice(0, 300), image: blob, aspectRatio: { width: m.w, height: m.h } });
      }
      record.embed = { $type: 'app.bsky.embed.images', images: embedded };
    }
    const r = (await api('Bluesky', `${BSKY}/com.atproto.repo.createRecord`, { method: 'POST', headers: authH, json: { repo: s.did, collection: 'app.bsky.feed.post', record } })).body;
    const rkey = r.uri.split('/').pop();
    return { external_id: r.uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
  },
  async followers({ account }) {
    return (await api('Bluesky', `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(account.external_id)}`)).body.followersCount ?? null;
  },
};

// ---------------------------------------------------------------- Mastodon
const instanceOf = (s) => {
  let u = String(s || '').trim();
  if (!u) throw new PublishError('Enter your Mastodon instance URL.');
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return new URL(u).origin;
};

export const mastodon = {
  id: 'mastodon',
  configured: () => true,
  async connect({ instance, token }) {
    const origin = instanceOf(instance);
    if (!token) throw new PublishError('Enter an access token (Preferences → Development → New application, scopes write:statuses write:media read:accounts).');
    const me = (await api('Mastodon', `${origin}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${token}` } })).body;
    return [{ external_id: me.id, name: me.display_name || me.username, username: me.acct, avatar: me.avatar || null, access_token: token, meta: { instance: origin, followers: me.followers_count } }];
  },
  async publish({ account, media, caption, hashtags }) {
    const origin = account.meta.instance;
    const authH = { authorization: `Bearer ${account.access_token}` };
    const ids = [];
    for (const m of media.slice(0, 4)) {
      const fd = new FormData();
      fd.set('file', fileBlob(m.file, m.mime), m.kind === 'video' ? 'video.mp4' : 'image.png');
      fd.set('description', caption.split('\n')[0].slice(0, 1500));
      let att = (await api('Mastodon', `${origin}/api/v2/media`, { method: 'POST', headers: authH, form: fd, timeoutMs: 300000 })).body;
      for (let i = 0; !att.url && i < 60; i++) {
        await sleep(2000);
        att = (await api('Mastodon', `${origin}/api/v1/media/${att.id}`, { headers: authH })).body;
      }
      ids.push(att.id);
    }
    const form = { status: composeText(caption, hashtags, 500), visibility: 'public' };
    const body = new URLSearchParams(form);
    for (const id of ids) body.append('media_ids[]', id);
    const r = (await api('Mastodon', `${origin}/api/v1/statuses`, { method: 'POST', headers: { ...authH, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })).body;
    return { external_id: r.id, url: r.url };
  },
  async metrics({ account, externalId }) {
    const r = (await api('Mastodon', `${account.meta.instance}/api/v1/statuses/${externalId}`, { headers: { authorization: `Bearer ${account.access_token}` } })).body;
    return { likes: r.favourites_count || 0, comments: r.replies_count || 0, shares: r.reblogs_count || 0 };
  },
  async followers({ account }) {
    return (await api('Mastodon', `${account.meta.instance}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${account.access_token}` } })).body.followers_count ?? null;
  },
};

// ---------------------------------------------------------------- Telegram channel
const TG = (token) => `https://api.telegram.org/bot${token}`;

export const telegram = {
  id: 'telegram',
  configured: () => true,
  async connect({ botToken, chatId }) {
    if (!botToken || !chatId) throw new PublishError('Enter the bot token from @BotFather and your channel (add the bot as a channel admin first).');
    await api('Telegram', `${TG(botToken)}/getMe`);
    const chat = (await api('Telegram', `${TG(botToken)}/getChat?chat_id=${encodeURIComponent(chatId)}`)).body.result;
    const count = (await api('Telegram', `${TG(botToken)}/getChatMemberCount?chat_id=${encodeURIComponent(chatId)}`).catch(() => ({ body: {} }))).body.result;
    return [{ external_id: String(chat.id), name: chat.title || chat.username, username: chat.username || '', avatar: null, access_token: botToken, meta: { followers: count } }];
  },
  async publish({ account, media, caption, hashtags }) {
    const base = TG(account.access_token);
    const chat = account.external_id;
    const text = composeText(caption, hashtags, media.length ? 1024 : 4096);
    let msg;
    if (!media.length) msg = (await api('Telegram', `${base}/sendMessage`, { method: 'POST', json: { chat_id: chat, text } })).body.result;
    else if (media.length === 1) {
      const fd = new FormData();
      fd.set('chat_id', chat);
      fd.set('caption', text);
      const field = media[0].kind === 'video' ? 'video' : 'photo';
      fd.set(field, fileBlob(media[0].file, media[0].mime), field === 'video' ? 'video.mp4' : 'image.png');
      msg = (await api('Telegram', `${base}/${field === 'video' ? 'sendVideo' : 'sendPhoto'}`, { method: 'POST', form: fd, timeoutMs: 300000 })).body.result;
    } else {
      const fd = new FormData();
      fd.set('chat_id', chat);
      const items = media.slice(0, 10).map((m, i) => ({ type: 'photo', media: `attach://f${i}`, ...(i === 0 ? { caption: text } : {}) }));
      fd.set('media', JSON.stringify(items));
      media.slice(0, 10).forEach((m, i) => fd.set(`f${i}`, fileBlob(m.file, m.mime), `f${i}.png`));
      msg = (await api('Telegram', `${base}/sendMediaGroup`, { method: 'POST', form: fd, timeoutMs: 300000 })).body.result[0];
    }
    return { external_id: String(msg.message_id), url: account.username ? `https://t.me/${account.username}/${msg.message_id}` : null };
  },
  async followers({ account }) {
    return (await api('Telegram', `${TG(account.access_token)}/getChatMemberCount?chat_id=${encodeURIComponent(account.external_id)}`)).body.result ?? null;
  },
};

// ---------------------------------------------------------------- Discord (channel webhook)
// Only Discord's own webhook URLs are accepted, so the server never fetches an arbitrary address.
const DISCORD_HOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const DISCORD_FILE_LIMIT = 10 * 1024 * 1024;

export const discord = {
  id: 'discord',
  configured: () => true,
  async connect({ webhookUrl }) {
    const url = String(webhookUrl || '').trim().replace(/\?.*$/, '');
    if (!DISCORD_HOOK.test(url)) throw new PublishError('Paste a Discord webhook URL (Channel settings → Integrations → Webhooks → Copy Webhook URL).');
    const hook = (await api('Discord', url)).body;
    return [{ external_id: hook.id, name: hook.name || 'Discord channel', username: '', avatar: hook.avatar ? `https://cdn.discordapp.com/avatars/${hook.id}/${hook.avatar}.png` : null, access_token: url, meta: { guild_id: hook.guild_id, channel_id: hook.channel_id } }];
  },
  async publish({ account, media, caption, hashtags }) {
    const files = media.slice(0, 10);
    const big = files.find((m) => m.size > DISCORD_FILE_LIMIT);
    if (big) throw new PublishError(`Discord webhooks accept files up to 10 MB; this ${big.kind} is ${Math.ceil(big.size / 1048576)} MB.`);
    const fd = new FormData();
    fd.set('payload_json', JSON.stringify({ content: composeText(caption, hashtags, 2000), attachments: files.map((m, i) => ({ id: i, filename: m.kind === 'video' ? 'video.mp4' : `image${i + 1}.png` })) }));
    files.forEach((m, i) => fd.set(`files[${i}]`, fileBlob(m.file, m.mime), m.kind === 'video' ? 'video.mp4' : `image${i + 1}.png`));
    const msg = (await api('Discord', `${account.access_token}?wait=true`, { method: 'POST', form: fd, timeoutMs: 300000 })).body;
    const { guild_id: guild, channel_id: channel } = account.meta || {};
    return { external_id: msg.id, url: guild && channel ? `https://discord.com/channels/${guild}/${channel}/${msg.id}` : null };
  },
};

// ---------------------------------------------------------------- Slack (incoming webhook)
// Incoming webhooks can't upload files, so images go in as image blocks that Slack fetches from PUBLIC_URL.
const SLACK_HOOK = /^https:\/\/hooks\.slack\.com\/(?:services|triggers|workflows)\/[\w/-]+$/;

export const slack = {
  id: 'slack',
  configured: () => true,
  async connect({ webhookUrl, name }) {
    const url = String(webhookUrl || '').trim();
    if (!SLACK_HOOK.test(url)) throw new PublishError('Paste a Slack incoming webhook URL (api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook).');
    // An empty message is rejected with "no_text" by a live webhook and with 403/404 by a revoked one, so nothing gets posted.
    try {
      await api('Slack', url, { method: 'POST', json: {} });
    } catch (e) {
      if (!(e.status === 400 && /no_text|missing_text/.test(e.message))) throw new PublishError(`Slack did not accept that webhook (${e.message.replace(/^Slack: /, '')}).`);
    }
    const label = String(name || '').trim().slice(0, 60) || 'Slack channel';
    return [{ external_id: `hook-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`, name: label, username: label.replace(/^#/, ''), avatar: null, access_token: url, meta: {} }];
  },
  async publish({ account, media, caption, hashtags }) {
    const text = composeText(caption, hashtags, 3000);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    const images = media.filter((m) => m.kind === 'image').slice(0, 10);
    if (images.length) requirePublicUrl('Slack');
    for (const m of images) blocks.push({ type: 'image', image_url: publicUrl(m.path), alt_text: caption.split('\n')[0].slice(0, 200) || 'Image' });
    await api('Slack', account.access_token, { method: 'POST', json: { text, blocks } });
    // Webhooks reply with a bare "ok": there is no message id or link to keep.
    return { external_id: null, url: null };
  },
};

// ---------------------------------------------------------------- Sandbox
// A local test channel: "publishing" copies the media and caption into data/outbox so the
// whole flow (scheduling, approvals, retries, calendar) can be tried without real accounts.
export const sandbox = {
  id: 'sandbox',
  configured: () => true,
  async connect({ name }) {
    const label = String(name || 'Test channel').trim().slice(0, 60);
    return [{ external_id: `sandbox-${Date.now().toString(36)}`, name: label, username: label.toLowerCase().replace(/\W+/g, ''), avatar: null, access_token: null, meta: {} }];
  },
  async publish({ account, media, caption, hashtags, targetId }) {
    const mode = account.meta?.fail;
    if (mode === 'always') throw new PublishError('Sandbox channel is set to fail.');
    if (mode === 'transient') {
      const tries = (sandbox.attempts.get(targetId) || 0) + 1;
      sandbox.attempts.set(targetId, tries);
      if (tries < 2) throw new PublishError('Sandbox transient error.', { retryable: true });
    }
    const dir = path.join(config.dataDir, 'outbox', targetId);
    fs.mkdirSync(dir, { recursive: true });
    const files = media.map((m, i) => {
      const name = `${i + 1}${path.extname(m.file)}`;
      fs.copyFileSync(m.file, path.join(dir, name));
      return `/outbox/${targetId}/${name}`;
    });
    fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ channel: account.name, text: composeText(caption, hashtags), media: files, published_at: new Date().toISOString() }, null, 2));
    return { external_id: targetId, url: `/outbox/${targetId}/post.json` };
  },
  attempts: new Map(),
};
