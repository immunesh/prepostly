import fs from 'node:fs';
import { config } from '../config.js';
import { api, PublishError, sleep, publicUrl, requirePublicUrl, composeText } from './common.js';

// Pinterest API v5: pins from image URLs, multi-image pins, and video pins via media upload.

const API = 'https://api.pinterest.com/v5';
const basic = () => `Basic ${Buffer.from(`${config.oauth.pinterest.clientId}:${config.oauth.pinterest.clientSecret}`).toString('base64')}`;
const auth = (t) => ({ authorization: `Bearer ${t}` });

async function uploadVideo(token, file) {
  const reg = (await api('Pinterest', `${API}/media`, { method: 'POST', headers: auth(token), json: { media_type: 'video' } })).body;
  const fd = new FormData();
  for (const [k, v] of Object.entries(reg.upload_parameters || {})) fd.set(k, v);
  fd.set('file', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), 'video.mp4');
  await api('Pinterest', reg.upload_url, { method: 'POST', form: fd, timeoutMs: 600000, raw: true });
  for (let i = 0; i < 60; i++) {
    const s = (await api('Pinterest', `${API}/media/${reg.media_id}`, { headers: auth(token) })).body;
    if (s.status === 'succeeded') return reg.media_id;
    if (s.status === 'failed') throw new PublishError('Pinterest could not process the video.');
    await sleep(4000);
  }
  throw new PublishError('Pinterest took too long to process the video.', { retryable: true });
}

export const pinterest = {
  id: 'pinterest',
  configured: () => Boolean(config.oauth.pinterest.clientId && config.oauth.pinterest.clientSecret),
  authUrl: ({ state, redirectUri }) => `https://www.pinterest.com/oauth/?${new URLSearchParams({ client_id: config.oauth.pinterest.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read', state })}`,
  async exchange({ code, redirectUri }) {
    const t = (await api('Pinterest', `${API}/oauth/token`, { method: 'POST', headers: { authorization: basic() }, form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri } })).body;
    const me = (await api('Pinterest', `${API}/user_account`, { headers: auth(t.access_token) })).body;
    const boards = (await api('Pinterest', `${API}/boards?page_size=100`, { headers: auth(t.access_token) })).body.items || [];
    return [{
      external_id: me.username, name: me.business_name || me.username, username: me.username, avatar: me.profile_image || null,
      access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + (t.expires_in || 2592000) * 1000).toISOString(),
      meta: { boards: boards.map((b) => ({ id: b.id, name: b.name })), board_id: boards[0]?.id || null, followers: me.follower_count },
    }];
  },
  async refresh(account) {
    const t = (await api('Pinterest', `${API}/oauth/token`, { method: 'POST', headers: { authorization: basic() }, form: { grant_type: 'refresh_token', refresh_token: account.refresh_token } })).body;
    return { access_token: t.access_token, refresh_token: t.refresh_token || account.refresh_token, token_expires_at: new Date(Date.now() + (t.expires_in || 2592000) * 1000).toISOString() };
  },
  async publish({ account, media, caption, hashtags, options, title, cover }) {
    const board = options?.board_id || account.meta?.board_id;
    if (!board) throw new PublishError('Choose a Pinterest board (create one on Pinterest first).');
    if (!media.length) throw new PublishError('Pins need an image or video.');
    const body = { board_id: board, title: (options?.title || title || '').slice(0, 100), description: composeText(caption, hashtags, 800), link: options?.link || undefined };
    if (media[0].kind === 'video') {
      requirePublicUrl('Pinterest');
      body.media_source = { source_type: 'video_id', media_id: await uploadVideo(account.access_token, media[0].file), cover_image_url: publicUrl(cover) };
    } else {
      requirePublicUrl('Pinterest');
      body.media_source = media.length === 1
        ? { source_type: 'image_url', url: publicUrl(media[0].path) }
        : { source_type: 'multiple_image_urls', items: media.slice(0, 5).map((m) => ({ url: publicUrl(m.path) })) };
    }
    const r = (await api('Pinterest', `${API}/pins`, { method: 'POST', headers: auth(account.access_token), json: body })).body;
    return { external_id: r.id, url: `https://www.pinterest.com/pin/${r.id}/` };
  },
};
