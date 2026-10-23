import fs from 'node:fs';
import { config } from '../config.js';
import { api, PublishError, composeText } from './common.js';

// LinkedIn REST API (versioned): Images/Videos upload APIs + Posts API.
// Personal profiles use the "Share on LinkedIn" product. Company Pages need the Community
// Management API, which LinkedIn approves separately, so they have their own app credentials
// (the same app works if it has both products).

const REST = 'https://api.linkedin.com/rest';
const headers = (token) => ({ authorization: `Bearer ${token}`, 'LinkedIn-Version': config.oauth.linkedin.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' });

/** LinkedIn "little text" commentary: escape reserved characters, keep hashtags as hashtags. */
export function linkedinCommentary(text) {
  return String(text).replace(/#([\p{L}\p{N}_]+)|([\\|{}@[\]()<>*_~#])/gu, (_, tag, ch) => (tag ? `{hashtag|\\#|${tag}}` : `\\${ch}`));
}

async function uploadImage(token, owner, file) {
  const init = (await api('LinkedIn', `${REST}/images?action=initializeUpload`, { method: 'POST', headers: headers(token), json: { initializeUploadRequest: { owner } } })).body.value;
  await api('LinkedIn', init.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: fs.readFileSync(file), timeoutMs: 120000 });
  return init.image;
}

async function uploadVideo(token, owner, file) {
  const size = fs.statSync(file).size;
  const init = (await api('LinkedIn', `${REST}/videos?action=initializeUpload`, { method: 'POST', headers: headers(token), json: { initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } } })).body.value;
  const fd = fs.openSync(file, 'r');
  const etags = [];
  try {
    for (const part of init.uploadInstructions) {
      const len = part.lastByte - part.firstByte + 1;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, part.firstByte);
      const r = await api('LinkedIn', part.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf, timeoutMs: 300000 });
      etags.push(r.headers.get('etag'));
    }
  } finally {
    fs.closeSync(fd);
  }
  await api('LinkedIn', `${REST}/videos?action=finalizeUpload`, { method: 'POST', headers: headers(token), json: { finalizeUploadRequest: { video: init.video, uploadToken: init.uploadToken || '', uploadedPartIds: etags } } });
  return init.video;
}

const AUTH = 'https://www.linkedin.com/oauth/v2';
const expiry = (t) => new Date(Date.now() + (t.expires_in || 5184000) * 1000).toISOString();

function authUrl(id, scope, { state, redirectUri }) {
  return `${AUTH}/authorization?${new URLSearchParams({ response_type: 'code', client_id: config.oauth[id].clientId, redirect_uri: redirectUri, state, scope })}`;
}

async function requestToken(id, form) {
  const { clientId, clientSecret } = config.oauth[id];
  return (await api('LinkedIn', `${AUTH}/accessToken`, { method: 'POST', form: { ...form, client_id: clientId, client_secret: clientSecret } })).body;
}

async function refresh(id, account) {
  if (!account.refresh_token) throw new PublishError('LinkedIn session expired. Reconnect the account.', { relink: true });
  const t = await requestToken(id, { grant_type: 'refresh_token', refresh_token: account.refresh_token });
  return { access_token: t.access_token, refresh_token: t.refresh_token || account.refresh_token, token_expires_at: expiry(t) };
}

async function publish({ account, media, caption, hashtags, options }) {
  const token = account.access_token;
  const author = account.meta?.urn || `urn:li:person:${account.external_id}`;
  const body = {
    author,
    commentary: linkedinCommentary(composeText(caption, hashtags, 3000)),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (media.length && media[0].kind === 'video') {
    body.content = { media: { id: await uploadVideo(token, author, media[0].file), title: options?.title || '' } };
  } else if (media.length === 1) {
    body.content = { media: { id: await uploadImage(token, author, media[0].file) } };
  } else if (media.length > 1) {
    const images = [];
    for (const m of media.slice(0, 20)) images.push({ id: await uploadImage(token, author, m.file) });
    body.content = { multiImage: { images } };
  }
  const r = await api('LinkedIn', `${REST}/posts`, { method: 'POST', headers: headers(token), json: body });
  const urn = r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id');
  return { external_id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
}

export const linkedin = {
  id: 'linkedin',
  configured: () => Boolean(config.oauth.linkedin.clientId && config.oauth.linkedin.clientSecret),
  authUrl: (args) => authUrl('linkedin', 'openid profile w_member_social', args),
  async exchange({ code, redirectUri }) {
    const t = await requestToken('linkedin', { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const me = (await api('LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } })).body;
    return [{ external_id: me.sub, name: me.name, username: me.email || '', avatar: me.picture || null, access_token: t.access_token, refresh_token: t.refresh_token || null, token_expires_at: expiry(t), meta: { urn: `urn:li:person:${me.sub}` } }];
  },
  refresh: (account) => refresh('linkedin', account),
  publish,
};

// Page roles that can post: Super admin and Content admin.
const POSTING_ROLES = ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR'];

export const linkedin_page = {
  id: 'linkedin_page',
  configured: () => Boolean(config.oauth.linkedin_page.clientId && config.oauth.linkedin_page.clientSecret),
  authUrl: (args) => authUrl('linkedin_page', 'rw_organization_admin w_organization_social', args),
  /** One account per Page the member can post to. */
  async exchange({ code, redirectUri }) {
    const t = await requestToken('linkedin_page', { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const acls = (await api('LinkedIn', `${REST}/organizationAcls?q=roleAssignee&state=APPROVED&count=100`, { headers: headers(t.access_token) })).body.elements || [];
    const ids = [...new Set(acls.filter((a) => POSTING_ROLES.includes(a.role)).map((a) => String(a.organization).split(':').pop()))];
    if (!ids.length) throw new PublishError("You aren't an admin of any LinkedIn Page. Ask a Page admin to make you a Super admin or Content admin, then connect again.");
    const accounts = [];
    for (const id of ids) {
      const org = (await api('LinkedIn', `${REST}/organizations/${id}`, { headers: headers(t.access_token) })).body;
      accounts.push({ external_id: id, name: org.localizedName || `LinkedIn Page ${id}`, username: org.vanityName || '', avatar: null, access_token: t.access_token, refresh_token: t.refresh_token || null, token_expires_at: expiry(t), meta: { urn: `urn:li:organization:${id}` } });
    }
    return accounts;
  },
  refresh: (account) => refresh('linkedin_page', account),
  publish,
};
