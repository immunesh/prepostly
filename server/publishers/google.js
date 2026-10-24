import fs from 'node:fs';
import { config } from '../config.js';
import { api, PublishError, publicUrl, requirePublicUrl, composeText } from './common.js';

// YouTube Data API v3 (resumable uploads → Shorts) and Google Business Profile local posts.

const TOKEN = 'https://oauth2.googleapis.com/token';
const auth = (t) => ({ authorization: `Bearer ${t}` });

function googleAuthUrl(scopes) {
  return ({ state, redirectUri }) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: config.oauth.youtube.clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })}`;
}
async function googleToken(form) {
  return (await api('Google', TOKEN, { method: 'POST', form: { client_id: config.oauth.youtube.clientId, client_secret: config.oauth.youtube.clientSecret, ...form } })).body;
}
async function googleRefresh(account) {
  if (!account.refresh_token) throw new PublishError('Google session expired. Reconnect the account.', { relink: true });
  const t = await googleToken({ grant_type: 'refresh_token', refresh_token: account.refresh_token });
  return { access_token: t.access_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() };
}
const configured = () => Boolean(config.oauth.youtube.clientId && config.oauth.youtube.clientSecret);

export const youtube = {
  id: 'youtube',
  configured,
  authUrl: googleAuthUrl(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']),
  async exchange({ code, redirectUri }) {
    const t = await googleToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const ch = (await api('YouTube', 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: auth(t.access_token) })).body.items?.[0];
    if (!ch) throw new PublishError('This Google account has no YouTube channel.');
    return [{ external_id: ch.id, name: ch.snippet.title, username: ch.snippet.customUrl || '', avatar: ch.snippet.thumbnails?.default?.url || null, access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), meta: { followers: Number(ch.statistics?.subscriberCount || 0) } }];
  },
  refresh: googleRefresh,
  async publish({ account, media, caption, hashtags, options, title }) {
    const video = media.find((m) => m.kind === 'video');
    if (!video) throw new PublishError('YouTube only accepts video posts.');
    const tags = String(hashtags || '').split(/\s+/).filter(Boolean).map((t) => t.replace(/^#/, '')).slice(0, 15);
    const vertical = video.h > video.w && (video.duration || 0) <= 180;
    const meta = {
      snippet: { title: `${(options?.title || title || caption.split('\n')[0] || 'New video').slice(0, vertical ? 90 : 100)}${vertical ? ' #Shorts' : ''}`.slice(0, 100), description: composeText(caption, hashtags, 5000), tags, categoryId: '22' },
      status: { privacyStatus: options?.privacy || 'public', selfDeclaredMadeForKids: false },
    };
    const size = fs.statSync(video.file).size;
    const init = await api('YouTube', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', headers: { ...auth(account.access_token), 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' }, json: meta });
    const location = init.headers.get('location');
    if (!location) throw new PublishError('YouTube did not return an upload URL.', { retryable: true });
    const r = (await api('YouTube', location, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(video.file), timeoutMs: 900000 })).body;
    return { external_id: r.id, url: vertical ? `https://www.youtube.com/shorts/${r.id}` : `https://www.youtube.com/watch?v=${r.id}` };
  },
  async metrics({ account, externalId }) {
    const s = (await api('YouTube', `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${externalId}`, { headers: auth(account.access_token) })).body.items?.[0]?.statistics || {};
    return { likes: Number(s.likeCount || 0), comments: Number(s.commentCount || 0), impressions: Number(s.viewCount || 0) };
  },
  async followers({ account }) {
    const ch = (await api('YouTube', 'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: auth(account.access_token) })).body.items?.[0];
    return ch ? Number(ch.statistics.subscriberCount || 0) : null;
  },
};

export const google_business = {
  id: 'google_business',
  configured,
  authUrl: googleAuthUrl(['https://www.googleapis.com/auth/business.manage']),
  async exchange({ code, redirectUri }) {
    const t = await googleToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const accounts = (await api('Google Business', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: auth(t.access_token) })).body.accounts || [];
    const out = [];
    for (const acc of accounts) {
      const locs = (await api('Google Business', `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`, { headers: auth(t.access_token) })).body.locations || [];
      for (const l of locs) {
        out.push({ external_id: `${acc.name}/${l.name}`, name: l.title, username: l.storefrontAddress?.locality || '', avatar: null, access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() });
      }
    }
    if (!out.length) throw new PublishError('No Google Business Profile locations found for this account.');
    return out;
  },
  refresh: googleRefresh,
  async publish({ account, media, caption, options, post }) {
    const image = media.find((m) => m.kind === 'image');
    const body = { languageCode: (post?.language || 'en').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'en', summary: composeText(caption, '', 1500), topicType: 'STANDARD' };
    if (image) {
      requirePublicUrl('Google Business Profile');
      body.media = [{ mediaFormat: 'PHOTO', sourceUrl: publicUrl(image.path) }];
    }
    if (options?.link) body.callToAction = { actionType: 'LEARN_MORE', url: options.link };
    const r = (await api('Google Business', `https://mybusiness.googleapis.com/v4/${account.external_id}/localPosts`, { method: 'POST', headers: auth(account.access_token), json: body })).body;
    return { external_id: r.name, url: r.searchUrl || null };
  },
};

// Blogger API v3. It can't upload images, so posts embed slides by their PUBLIC_URL.
const BLOGGER = 'https://www.googleapis.com/blogger/v3';
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Caption as HTML paragraphs with clickable links. */
export function bloggerHtml(caption) {
  return String(caption || '').trim().split(/\n\s*\n/).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export const blogger = {
  id: 'blogger',
  configured,
  authUrl: googleAuthUrl(['https://www.googleapis.com/auth/blogger']),
  async exchange({ code, redirectUri }) {
    const t = await googleToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const blogs = (await api('Blogger', `${BLOGGER}/users/self/blogs`, { headers: auth(t.access_token) })).body.items || [];
    if (!blogs.length) throw new PublishError('This Google account has no Blogger blogs. Create one at blogger.com first.');
    return blogs.map((b) => ({ external_id: b.id, name: b.name, username: new URL(b.url).hostname, avatar: null, access_token: t.access_token, refresh_token: t.refresh_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), meta: { url: b.url } }));
  },
  refresh: googleRefresh,
  async publish({ account, media, caption, hashtags, options, title }) {
    const images = media.filter((m) => m.kind === 'image');
    if (images.length) requirePublicUrl('Blogger');
    const alt = escapeHtml(caption.split('\n')[0].slice(0, 200));
    const content = [...images.map((m) => `<p><img src="${publicUrl(m.path)}" alt="${alt}" width="${m.w || ''}" height="${m.h || ''}" style="max-width:100%;height:auto"></p>`), bloggerHtml(caption)].join('\n');
    // Blogger caps a post's labels at 200 characters in total.
    const labels = [];
    for (const tag of String(hashtags || '').split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean)) {
      if ([...labels, tag].join(',').length > 200) break;
      labels.push(tag);
    }
    const body = { kind: 'blogger#post', title: (options?.title || title || caption.split('\n')[0] || 'New post').slice(0, 200), content, labels };
    const r = (await api('Blogger', `${BLOGGER}/blogs/${account.external_id}/posts/`, { method: 'POST', headers: auth(account.access_token), json: body })).body;
    return { external_id: r.id, url: r.url };
  },
  async metrics({ account, externalId }) {
    const r = (await api('Blogger', `${BLOGGER}/blogs/${account.external_id}/posts/${externalId}?fields=replies`, { headers: auth(account.access_token) })).body;
    return { comments: Number(r.replies?.totalItems || 0) };
  },
};
