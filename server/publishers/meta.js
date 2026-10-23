import { config } from '../config.js';
import { api, PublishError, sleep, publicUrl, publicJpeg, requirePublicUrl, composeText, fileBlob } from './common.js';

// Facebook Pages and Instagram (Business/Creator) share one Meta app and the Graph API.
// Threads uses its own OAuth app and graph.threads.net.

const G = () => `https://graph.facebook.com/${config.oauth.facebook.graphVersion}`;
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights', 'business_management', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'];

async function exchangeCode({ code, redirectUri }) {
  const { clientId, clientSecret } = config.oauth.facebook;
  const short = (await api('Facebook', `${G()}/oauth/access_token?${new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code })}`)).body;
  const long = (await api('Facebook', `${G()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: clientId, client_secret: clientSecret, fb_exchange_token: short.access_token })}`)).body;
  const pages = (await api('Facebook', `${G()}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,picture{url},followers_count,instagram_business_account{id,username,name,profile_picture_url,followers_count}', limit: '100', access_token: long.access_token })}`)).body;
  // Meta's data deletion and deauthorize callbacks identify the person by this app-scoped id.
  const me = (await api('Facebook', `${G()}/me?${new URLSearchParams({ fields: 'id', access_token: long.access_token })}`)).body;
  return (pages.data || []).map((p) => ({ ...p, fb_user_id: me.id }));
}

function authUrl({ state, redirectUri }) {
  return `https://www.facebook.com/${config.oauth.facebook.graphVersion}/dialog/oauth?${new URLSearchParams({ client_id: config.oauth.facebook.clientId, redirect_uri: redirectUri, state, scope: SCOPES.join(','), response_type: 'code' })}`;
}

// ---------------------------------------------------------------- Facebook
export const facebook = {
  id: 'facebook',
  configured: () => Boolean(config.oauth.facebook.clientId && config.oauth.facebook.clientSecret),
  authUrl,
  async exchange(args) {
    const pages = await exchangeCode(args);
    if (!pages.length) throw new PublishError('No Facebook Pages were shared. Grant access to at least one Page.');
    // Page tokens derived from a long-lived user token do not expire.
    return pages.map((p) => ({ external_id: p.id, name: p.name, username: '', avatar: p.picture?.data?.url || null, access_token: p.access_token, meta: { followers: p.followers_count, fb_user_id: p.fb_user_id } }));
  },
  async publish({ account, media, caption, hashtags, options }) {
    const page = account.external_id;
    const token = account.access_token;
    const message = composeText(caption, hashtags, 63000);
    const link = options?.link;
    if (!media.length) {
      const r = (await api('Facebook', `${G()}/${page}/feed`, { method: 'POST', form: { message, link, access_token: token } })).body;
      return { external_id: r.id, url: `https://www.facebook.com/${r.id}` };
    }
    if (media[0].kind === 'video') {
      const fd = new FormData();
      fd.set('access_token', token);
      fd.set('description', message);
      if (options?.title) fd.set('title', options.title);
      fd.set('source', fileBlob(media[0].file, 'video/mp4'), 'video.mp4');
      const r = (await api('Facebook', `https://graph-video.facebook.com/${config.oauth.facebook.graphVersion}/${page}/videos`, { method: 'POST', form: fd, timeoutMs: 600000 })).body;
      return { external_id: r.id, url: `https://www.facebook.com/${page}/videos/${r.id}` };
    }
    const uploadPhoto = async (m, published, caption) => {
      const fd = new FormData();
      fd.set('access_token', token);
      fd.set('published', String(published));
      if (caption) fd.set('caption', caption);
      fd.set('source', fileBlob(m.file, m.mime), 'image.png');
      return (await api('Facebook', `${G()}/${page}/photos`, { method: 'POST', form: fd, timeoutMs: 120000 })).body;
    };
    if (media.length === 1) {
      const r = await uploadPhoto(media[0], true, message);
      const id = r.post_id || r.id;
      return { external_id: id, url: `https://www.facebook.com/${id}` };
    }
    const ids = [];
    for (const m of media) ids.push((await uploadPhoto(m, false)).id);
    const form = { message, access_token: token };
    ids.forEach((id, i) => { form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const r = (await api('Facebook', `${G()}/${page}/feed`, { method: 'POST', form })).body;
    return { external_id: r.id, url: `https://www.facebook.com/${r.id}` };
  },
  async metrics({ account, externalId }) {
    const r = (await api('Facebook', `${G()}/${externalId}?${new URLSearchParams({ fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0),shares', access_token: account.access_token })}`)).body;
    return { likes: r.likes?.summary?.total_count || 0, comments: r.comments?.summary?.total_count || 0, shares: r.shares?.count || 0 };
  },
  async followers({ account }) {
    return (await api('Facebook', `${G()}/${account.external_id}?fields=followers_count&access_token=${encodeURIComponent(account.access_token)}`)).body.followers_count ?? null;
  },
};

// ---------------------------------------------------------------- Instagram
async function waitForContainer(id, token, label = 'Instagram', base = G()) {
  for (let i = 0; i < 60; i++) {
    const r = (await api(label, `${base}/${id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`)).body;
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') throw new PublishError(`${label} could not process the media: ${r.status || r.status_code}`);
    await sleep(i < 5 ? 2000 : 5000);
  }
  throw new PublishError(`${label} took too long to process the video.`, { retryable: true });
}

export const instagram = {
  id: 'instagram',
  configured: facebook.configured,
  authUrl,
  async exchange(args) {
    const pages = await exchangeCode(args);
    const accounts = pages.filter((p) => p.instagram_business_account).map((p) => {
      const ig = p.instagram_business_account;
      return { external_id: ig.id, name: ig.name || ig.username, username: ig.username, avatar: ig.profile_picture_url || null, access_token: p.access_token, meta: { page_id: p.id, followers: ig.followers_count, fb_user_id: p.fb_user_id } };
    });
    if (!accounts.length) throw new PublishError('No Instagram Business or Creator account is connected to the Facebook Pages you shared. Link one in Instagram settings first.');
    return accounts;
  },
  async publish({ account, media, caption, hashtags, options, cover }) {
    requirePublicUrl('Instagram');
    const ig = account.external_id;
    const token = account.access_token;
    const text = composeText(caption, hashtags, 2200);
    const create = (params) => api('Instagram', `${G()}/${ig}/media`, { method: 'POST', form: { ...params, access_token: token } }).then((r) => r.body.id);
    if (!media.length) throw new PublishError('Instagram posts need an image or video.');
    const story = options?.ig_story === true;
    let container;
    if (media[0].kind === 'video') {
      container = await create({ media_type: story ? 'STORIES' : 'REELS', video_url: publicUrl(media[0].path), caption: story ? undefined : text, cover_url: cover ? publicUrl(cover) : undefined, share_to_feed: story ? undefined : 'true' });
      await waitForContainer(container, token);
    } else if (media.length === 1 || story) {
      container = await create({ image_url: await publicJpeg(media[0]), caption: story ? undefined : text, media_type: story ? 'STORIES' : undefined, location_id: options?.location_id, collaborators: options?.collaborators?.length ? JSON.stringify(options.collaborators) : undefined });
      await waitForContainer(container, token);
    } else {
      const children = [];
      for (const m of media.slice(0, 10)) children.push(await create({ image_url: await publicJpeg(m), is_carousel_item: 'true' }));
      for (const c of children) await waitForContainer(c, token);
      container = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: text, location_id: options?.location_id, collaborators: options?.collaborators?.length ? JSON.stringify(options.collaborators) : undefined });
      await waitForContainer(container, token);
    }
    const published = (await api('Instagram', `${G()}/${ig}/media_publish`, { method: 'POST', form: { creation_id: container, access_token: token } })).body;
    const link = (await api('Instagram', `${G()}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({ body: {} }))).body.permalink;
    return { external_id: published.id, url: link || `https://www.instagram.com/${account.username}/` };
  },
  async metrics({ account, externalId }) {
    const r = (await api('Instagram', `${G()}/${externalId}?fields=like_count,comments_count&access_token=${encodeURIComponent(account.access_token)}`)).body;
    return { likes: r.like_count || 0, comments: r.comments_count || 0 };
  },
  async followers({ account }) {
    return (await api('Instagram', `${G()}/${account.external_id}?fields=followers_count&access_token=${encodeURIComponent(account.access_token)}`)).body.followers_count ?? null;
  },
};

/** Instagram Graph business_discovery: public profile and recent media of another business account. */
export async function businessDiscovery(account, username, limit = 50) {
  const fields = `business_discovery.username(${username}){username,name,biography,followers_count,follows_count,media_count,profile_picture_url,media.limit(${limit}){id,caption,like_count,comments_count,media_type,media_product_type,timestamp,permalink,media_url,thumbnail_url}}`;
  const r = (await api('Instagram', `${G()}/${account.external_id}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(account.access_token)}`)).body;
  return r.business_discovery;
}

// ---------------------------------------------------------------- Threads
const T = 'https://graph.threads.net/v1.0';
export const threads = {
  id: 'threads',
  configured: () => Boolean(config.oauth.threads.clientId && config.oauth.threads.clientSecret),
  authUrl: ({ state, redirectUri }) => `https://threads.net/oauth/authorize?${new URLSearchParams({ client_id: config.oauth.threads.clientId, redirect_uri: redirectUri, scope: 'threads_basic,threads_content_publish,threads_manage_insights', response_type: 'code', state })}`,
  async exchange({ code, redirectUri }) {
    const { clientId, clientSecret } = config.oauth.threads;
    const short = (await api('Threads', 'https://graph.threads.net/oauth/access_token', { method: 'POST', form: { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code } })).body;
    const long = (await api('Threads', `https://graph.threads.net/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: clientSecret, access_token: short.access_token })}`)).body;
    const me = (await api('Threads', `${T}/me?fields=id,username,name,threads_profile_picture_url&access_token=${encodeURIComponent(long.access_token)}`)).body;
    return [{ external_id: me.id, name: me.name || me.username, username: me.username, avatar: me.threads_profile_picture_url || null, access_token: long.access_token, token_expires_at: new Date(Date.now() + (long.expires_in || 5184000) * 1000).toISOString() }];
  },
  async refresh(account) {
    const r = (await api('Threads', `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(account.access_token)}`)).body;
    return { access_token: r.access_token, token_expires_at: new Date(Date.now() + (r.expires_in || 5184000) * 1000).toISOString() };
  },
  async publish({ account, media, caption, hashtags }) {
    const token = account.access_token;
    const text = composeText(caption, hashtags, 500);
    const create = (params) => api('Threads', `${T}/${account.external_id}/threads`, { method: 'POST', form: { ...params, access_token: token } }).then((r) => r.body.id);
    let container;
    if (!media.length) container = await create({ media_type: 'TEXT', text });
    else {
      requirePublicUrl('Threads');
      if (media[0].kind === 'video') container = await create({ media_type: 'VIDEO', video_url: publicUrl(media[0].path), text });
      else if (media.length === 1) container = await create({ media_type: 'IMAGE', image_url: publicUrl(media[0].path), text });
      else {
        const children = [];
        for (const m of media.slice(0, 20)) children.push(await create({ media_type: 'IMAGE', image_url: publicUrl(m.path), is_carousel_item: 'true' }));
        container = await create({ media_type: 'CAROUSEL', children: children.join(','), text });
      }
      await waitForContainer(container, token, 'Threads', T);
    }
    const r = (await api('Threads', `${T}/${account.external_id}/threads_publish`, { method: 'POST', form: { creation_id: container, access_token: token } })).body;
    const link = (await api('Threads', `${T}/${r.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({ body: {} }))).body.permalink;
    return { external_id: r.id, url: link || `https://www.threads.net/@${account.username}` };
  },
};
