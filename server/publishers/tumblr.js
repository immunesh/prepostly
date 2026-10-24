import { config } from '../config.js';
import { api, PublishError, fileBlob } from './common.js';

// Tumblr API v2: OAuth 2.0 and Neue Post Format (NPF) posts with media uploaded in the same multipart request.

const API = 'https://api.tumblr.com/v2';
const auth = (t) => ({ authorization: `Bearer ${t}` });
const expiresAt = (t) => new Date(Date.now() + (t.expires_in || 2520) * 1000).toISOString();

async function tumblrToken(form) {
  return (await api('Tumblr', `${API}/oauth2/token`, { method: 'POST', form: { client_id: config.oauth.tumblr.clientId, client_secret: config.oauth.tumblr.clientSecret, ...form } })).body;
}

export const tumblr = {
  id: 'tumblr',
  configured: () => Boolean(config.oauth.tumblr.clientId && config.oauth.tumblr.clientSecret),
  authUrl: ({ state, redirectUri }) => `https://www.tumblr.com/oauth2/authorize?${new URLSearchParams({ client_id: config.oauth.tumblr.clientId, response_type: 'code', scope: 'basic write offline_access', state, redirect_uri: redirectUri })}`,
  async exchange({ code, redirectUri }) {
    const t = await tumblrToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const blogs = (await api('Tumblr', `${API}/user/info`, { headers: auth(t.access_token) })).body.response?.user?.blogs || [];
    if (!blogs.length) throw new PublishError('This Tumblr account has no blogs.');
    // Each blog (primary and side blogs) becomes its own channel.
    return blogs.map((b) => ({
      external_id: b.uuid, name: b.title || b.name, username: b.name, avatar: b.avatar?.[0]?.url || `${API}/blog/${b.name}/avatar/128`,
      access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: expiresAt(t), meta: { followers: b.followers },
    }));
  },
  async refresh(account) {
    if (!account.refresh_token) throw new PublishError('Tumblr session expired. Reconnect the account.', { relink: true });
    const t = await tumblrToken({ grant_type: 'refresh_token', refresh_token: account.refresh_token });
    return { access_token: t.access_token, refresh_token: t.refresh_token || account.refresh_token, token_expires_at: expiresAt(t) };
  },
  async publish({ account, media, caption, hashtags }) {
    const files = media.slice(0, 10);
    const content = files.map((m, i) => (m.kind === 'video'
      ? { type: 'video', media: { type: m.mime, identifier: `f${i}`, width: m.w, height: m.h } }
      : { type: 'image', media: [{ type: m.mime, identifier: `f${i}`, width: m.w, height: m.h }] }));
    for (const p of String(caption || '').trim().split(/\n\s*\n/).filter(Boolean)) content.push({ type: 'text', text: p });
    if (!content.length) throw new PublishError('Tumblr posts need text or media.');
    // Hashtags become Tumblr tags rather than text.
    const tags = String(hashtags || '').split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean).join(',');
    const fd = new FormData();
    fd.set('json', JSON.stringify({ content, tags, state: 'published' }));
    files.forEach((m, i) => fd.set(`f${i}`, fileBlob(m.file, m.mime), m.kind === 'video' ? 'video.mp4' : `image${i + 1}.png`));
    const r = (await api('Tumblr', `${API}/blog/${account.external_id}/posts`, { method: 'POST', headers: auth(account.access_token), form: fd, timeoutMs: 600000 })).body.response;
    const id = r.id_string || String(r.id);
    return { external_id: id, url: `https://www.tumblr.com/${account.username}/${id}` };
  },
  async followers({ account }) {
    return (await api('Tumblr', `${API}/blog/${account.external_id}/followers?limit=1`, { headers: auth(account.access_token) })).body.response?.total_users ?? null;
  },
};
