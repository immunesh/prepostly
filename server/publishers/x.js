import fs from 'node:fs';
import { config } from '../config.js';
import { api, PublishError, sleep, composeText, fileBlob, asJpeg } from './common.js';

// X API v2: OAuth 2.0 with PKCE, v2 media upload, POST /2/tweets.

const API = 'https://api.x.com/2';
const basic = () => `Basic ${Buffer.from(`${config.oauth.x.clientId}:${config.oauth.x.clientSecret}`).toString('base64')}`;
const auth = (t) => ({ authorization: `Bearer ${t}` });

async function uploadImage(token, file) {
  const jpg = fs.statSync(file).size > 4_500_000 ? await asJpeg(file) : file;
  const fd = new FormData();
  fd.set('media', fileBlob(jpg, jpg.endsWith('.jpg') ? 'image/jpeg' : 'image/png'), 'image');
  fd.set('media_category', 'tweet_image');
  return (await api('X', `${API}/media/upload`, { method: 'POST', headers: auth(token), form: fd, timeoutMs: 120000 })).body.data.id;
}

async function uploadVideo(token, file) {
  const size = fs.statSync(file).size;
  const init = (await api('X', `${API}/media/upload/initialize`, { method: 'POST', headers: auth(token), json: { media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' } })).body.data;
  const id = init.id;
  const CHUNK = 4 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    for (let i = 0, off = 0; off < size; i++, off += CHUNK) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const form = new FormData();
      form.set('segment_index', String(i));
      form.set('media', new Blob([buf], { type: 'application/octet-stream' }), 'chunk');
      await api('X', `${API}/media/upload/${id}/append`, { method: 'POST', headers: auth(token), form, timeoutMs: 300000 });
    }
  } finally {
    fs.closeSync(fd);
  }
  let info = (await api('X', `${API}/media/upload/${id}/finalize`, { method: 'POST', headers: auth(token) })).body.data?.processing_info;
  for (let i = 0; info && ['pending', 'in_progress'].includes(info.state) && i < 60; i++) {
    await sleep((info.check_after_secs || 3) * 1000);
    info = (await api('X', `${API}/media/upload?command=STATUS&media_id=${id}`, { headers: auth(token) })).body.data?.processing_info;
  }
  if (info?.state === 'failed') throw new PublishError(`X could not process the video: ${info.error?.message || 'unknown error'}`);
  return id;
}

export const x = {
  id: 'x',
  pkce: true,
  configured: () => Boolean(config.oauth.x.clientId),
  authUrl: ({ state, redirectUri, challenge }) => `https://x.com/i/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: config.oauth.x.clientId, redirect_uri: redirectUri, scope: 'tweet.read tweet.write users.read media.write offline.access', state, code_challenge: challenge, code_challenge_method: 'S256' })}`,
  async exchange({ code, redirectUri, verifier }) {
    const t = (await api('X', `${API}/oauth2/token`, { method: 'POST', headers: config.oauth.x.clientSecret ? { authorization: basic() } : {}, form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: config.oauth.x.clientId } })).body;
    const me = (await api('X', `${API}/users/me?user.fields=profile_image_url,public_metrics`, { headers: auth(t.access_token) })).body.data;
    return [{ external_id: me.id, name: me.name, username: me.username, avatar: me.profile_image_url || null, access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + (t.expires_in || 7200) * 1000).toISOString(), meta: { followers: me.public_metrics?.followers_count } }];
  },
  async refresh(account) {
    const t = (await api('X', `${API}/oauth2/token`, { method: 'POST', headers: config.oauth.x.clientSecret ? { authorization: basic() } : {}, form: { grant_type: 'refresh_token', refresh_token: account.refresh_token, client_id: config.oauth.x.clientId } })).body;
    return { access_token: t.access_token, refresh_token: t.refresh_token || account.refresh_token, token_expires_at: new Date(Date.now() + (t.expires_in || 7200) * 1000).toISOString() };
  },
  async publish({ account, media, caption, hashtags }) {
    const token = account.access_token;
    const ids = [];
    if (media.length && media[0].kind === 'video') ids.push(await uploadVideo(token, media[0].file));
    else for (const m of media.slice(0, 4)) ids.push(await uploadImage(token, m.file));
    const body = { text: composeText(caption, hashtags, 280) };
    if (ids.length) body.media = { media_ids: ids };
    const r = (await api('X', `${API}/tweets`, { method: 'POST', headers: auth(token), json: body })).body.data;
    return { external_id: r.id, url: `https://x.com/${account.username}/status/${r.id}` };
  },
  async metrics({ account, externalId }) {
    const d = (await api('X', `${API}/tweets/${externalId}?tweet.fields=public_metrics`, { headers: auth(account.access_token) })).body.data;
    const m = d?.public_metrics || {};
    return { likes: m.like_count || 0, comments: m.reply_count || 0, shares: (m.retweet_count || 0) + (m.quote_count || 0), impressions: m.impression_count || 0 };
  },
  async followers({ account }) {
    return (await api('X', `${API}/users/me?user.fields=public_metrics`, { headers: auth(account.access_token) })).body.data?.public_metrics?.followers_count ?? null;
  },
};
