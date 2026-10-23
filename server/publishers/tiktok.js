import fs from 'node:fs';
import { config } from '../config.js';
import { api, PublishError, sleep, publicUrl, requirePublicUrl, composeText } from './common.js';

// TikTok Content Posting API: direct video posts (FILE_UPLOAD) and photo carousels (PULL_FROM_URL).
// Apps that have not passed TikTok's audit can only post privately (SELF_ONLY).

const API = 'https://open.tiktokapis.com/v2';
const auth = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json; charset=UTF-8' });

async function call(token, path, body) {
  const r = (await api('TikTok', `${API}${path}`, { method: 'POST', headers: auth(token), body: JSON.stringify(body || {}) })).body;
  if (r.error && r.error.code !== 'ok') throw new PublishError(`TikTok: ${r.error.message || r.error.code}`, { relink: r.error.code === 'access_token_invalid' });
  return r.data;
}

export const tiktok = {
  id: 'tiktok',
  configured: () => Boolean(config.oauth.tiktok.clientId && config.oauth.tiktok.clientSecret),
  authUrl: ({ state, redirectUri }) => `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: config.oauth.tiktok.clientId, scope: 'user.info.basic,user.info.stats,video.publish,video.upload', response_type: 'code', redirect_uri: redirectUri, state })}`,
  async exchange({ code, redirectUri }) {
    const t = (await api('TikTok', `${API}/oauth/token/`, { method: 'POST', form: { client_key: config.oauth.tiktok.clientId, client_secret: config.oauth.tiktok.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri } })).body;
    if (t.error) throw new PublishError(`TikTok: ${t.error_description || t.error}`);
    const u = (await api('TikTok', `${API}/user/info/?fields=open_id,avatar_url,display_name,username,follower_count`, { headers: { authorization: `Bearer ${t.access_token}` } })).body.data.user;
    return [{ external_id: u.open_id, name: u.display_name, username: u.username || '', avatar: u.avatar_url || null, access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), meta: { followers: u.follower_count } }];
  },
  async refresh(account) {
    const t = (await api('TikTok', `${API}/oauth/token/`, { method: 'POST', form: { client_key: config.oauth.tiktok.clientId, client_secret: config.oauth.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: account.refresh_token } })).body;
    if (t.error) throw new PublishError('TikTok session expired. Reconnect the account.', { relink: true });
    return { access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() };
  },
  async publish({ account, media, caption, hashtags, options, title }) {
    const token = account.access_token;
    const creator = await call(token, '/post/publish/creator_info/query/');
    const levels = creator.privacy_level_options || ['SELF_ONLY'];
    const privacy = levels.includes(options?.privacy) ? options.privacy : levels.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : levels[0];
    const text = composeText(caption, hashtags, 2200);
    let publishId;
    if (media[0]?.kind === 'video') {
      const size = fs.statSync(media[0].file).size;
      const CHUNK = Math.min(size, 10 * 1024 * 1024);
      const chunks = Math.max(1, Math.floor(size / CHUNK));
      const init = await call(token, '/post/publish/video/init/', {
        post_info: { title: text, privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false, video_cover_timestamp_ms: 500 },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: CHUNK, total_chunk_count: chunks },
      });
      publishId = init.publish_id;
      const fd = fs.openSync(media[0].file, 'r');
      try {
        for (let i = 0; i < chunks; i++) {
          const start = i * CHUNK;
          const end = i === chunks - 1 ? size - 1 : start + CHUNK - 1;
          const buf = Buffer.alloc(end - start + 1);
          fs.readSync(fd, buf, 0, buf.length, start);
          await api('TikTok', init.upload_url, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}` }, body: buf, timeoutMs: 300000 });
        }
      } finally {
        fs.closeSync(fd);
      }
    } else if (media.length) {
      requirePublicUrl('TikTok');
      const init = await call(token, '/post/publish/content/init/', {
        post_info: { title: (options?.title || title || '').slice(0, 90), description: text.slice(0, 4000), privacy_level: privacy, disable_comment: false, auto_add_music: true },
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: media.slice(0, 35).map((m) => publicUrl(m.path)) },
        post_mode: 'DIRECT_POST', media_type: 'PHOTO',
      });
      publishId = init.publish_id;
    } else throw new PublishError('TikTok posts need a video or images.');

    for (let i = 0; i < 60; i++) {
      const s = await call(token, '/post/publish/status/fetch/', { publish_id: publishId });
      if (s.status === 'PUBLISH_COMPLETE') {
        const id = s.publicaly_available_post_id?.[0] || s.publicly_available_post_id?.[0];
        return { external_id: id ? String(id) : publishId, url: id && account.username ? `https://www.tiktok.com/@${account.username}/video/${id}` : null, note: privacy === 'SELF_ONLY' ? 'Posted privately: TikTok only allows audited apps to post publicly.' : undefined };
      }
      if (s.status === 'FAILED') throw new PublishError(`TikTok rejected the post: ${s.fail_reason || 'unknown reason'}`);
      await sleep(5000);
    }
    return { external_id: publishId, url: null, note: 'TikTok is still processing the post.' };
  },
};
