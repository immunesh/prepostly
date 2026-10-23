import { one, json } from '../db.js';
import { HttpError } from '../auth.js';
import { config } from '../config.js';
import { accountWithTokens } from '../publishers/index.js';
import { businessDiscovery } from '../publishers/meta.js';
import { api } from '../publishers/common.js';
import { themePosts } from './content.js';

// Competitor analysis: fetch a competitor's recent public posts, then compute engagement,
// content themes, post-type mix, hashtag performance and posting-time patterns.

/** Normalized post: { id, caption, likes, comments, shares, media_type, timestamp, permalink, image } */
export async function fetchCompetitor(brand, comp) {
  if (comp.platform === 'instagram') {
    const row = one("SELECT * FROM social_accounts WHERE brand_id = ? AND platform = 'instagram' AND status = 'active' LIMIT 1", brand.id);
    if (!row) throw new HttpError(400, 'Competitor analysis needs your Instagram Business account linked through Facebook. Connect Instagram first.', 'ig_not_linked');
    const d = await businessDiscovery(accountWithTokens(row), comp.handle);
    if (!d) throw new HttpError(404, `@${comp.handle} was not found, or it is not a Business/Creator account.`);
    return {
      profile: { name: d.name || d.username, username: d.username, bio: d.biography, followers: d.followers_count, following: d.follows_count, media_count: d.media_count, avatar: d.profile_picture_url },
      posts: (d.media?.data || []).map((m) => ({ id: m.id, caption: m.caption || '', likes: m.like_count || 0, comments: m.comments_count || 0, shares: 0, media_type: m.media_product_type === 'REELS' ? 'REEL' : m.media_type === 'CAROUSEL_ALBUM' ? 'CAROUSEL' : m.media_type, timestamp: m.timestamp, permalink: m.permalink, image: m.thumbnail_url || m.media_url })),
    };
  }
  if (comp.platform === 'facebook') {
    const row = one("SELECT * FROM social_accounts WHERE brand_id = ? AND platform = 'facebook' AND status = 'active' LIMIT 1", brand.id);
    if (!row) throw new HttpError(400, 'Competitor analysis needs your Facebook Page linked. Connect Facebook first.', 'fb_not_linked');
    const acc = accountWithTokens(row);
    const v = config.oauth.facebook.graphVersion;
    const fields = 'name,username,about,followers_count,picture{url},posts.limit(50){id,message,created_time,permalink_url,full_picture,attachments{media_type},reactions.summary(true).limit(0),comments.summary(true).limit(0),shares}';
    const d = (await api('Facebook', `https://graph.facebook.com/${v}/${encodeURIComponent(comp.handle)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(acc.access_token)}`)).body;
    return {
      profile: { name: d.name, username: d.username || comp.handle, bio: d.about, followers: d.followers_count, avatar: d.picture?.data?.url },
      posts: (d.posts?.data || []).map((p) => ({ id: p.id, caption: p.message || '', likes: p.reactions?.summary?.total_count || 0, comments: p.comments?.summary?.total_count || 0, shares: p.shares?.count || 0, media_type: (p.attachments?.data?.[0]?.media_type || 'status').toUpperCase(), timestamp: p.created_time, permalink: p.permalink_url, image: p.full_picture })),
    };
  }
  // Manual: posts were imported by the user (CSV/JSON); profile may carry followers.
  return { profile: json(comp.profile, {}), posts: json(comp.posts, []) };
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const engagementOf = (p) => (p.likes || 0) + (p.comments || 0) + (p.shares || 0);

export async function analyze(profile, allPosts, { from, to } = {}) {
  const posts = allPosts.filter((p) => (!from || p.timestamp >= from) && (!to || p.timestamp <= to));
  const followers = Number(profile.followers || 0);
  const eng = posts.map(engagementOf);
  const summary = {
    followers,
    total_posts: posts.length,
    avg_likes: round(avg(posts.map((p) => p.likes || 0))),
    avg_comments: round(avg(posts.map((p) => p.comments || 0))),
    avg_engagement: round(avg(eng)),
    engagement_rate: followers ? round((avg(eng) / followers) * 100, 2) : null,
    posts_per_week: (() => {
      if (posts.length < 2) return posts.length;
      const ts = posts.map((p) => new Date(p.timestamp).getTime()).sort();
      const weeks = Math.max(1, (ts.at(-1) - ts[0]) / (7 * 864e5));
      return round(posts.length / weeks);
    })(),
    data_from: posts.map((p) => p.timestamp).sort()[0] || null,
  };

  const byType = {};
  for (const p of posts) {
    const t = p.media_type || 'OTHER';
    (byType[t] ||= { type: t, count: 0, engagement: 0 }).count++;
    byType[t].engagement += engagementOf(p);
  }
  const post_types = Object.values(byType).map((t) => ({ ...t, avg_engagement: round(t.engagement / t.count) })).sort((a, b) => b.count - a.count);

  const themesRaw = await themePosts(posts);
  const themes = themesRaw.map((t) => {
    const ps = t.indexes.map((i) => posts[i]).filter(Boolean);
    const types = {};
    for (const p of ps) types[p.media_type || 'OTHER'] = (types[p.media_type || 'OTHER'] || 0) + 1;
    return { theme: t.theme, count: ps.length, avg_engagement: round(avg(ps.map(engagementOf))), types, examples: ps.sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, 3).map((p) => ({ caption: p.caption.slice(0, 160), permalink: p.permalink, engagement: engagementOf(p) })) };
  }).filter((t) => t.count).sort((a, b) => b.count - a.count);

  const tagStats = new Map();
  for (const p of posts) {
    for (const tag of new Set((p.caption.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()))) {
      const s = tagStats.get(tag) || { tag, count: 0, engagement: 0 };
      s.count++;
      s.engagement += engagementOf(p);
      tagStats.set(tag, s);
    }
  }
  const hashtags = [...tagStats.values()].map((s) => ({ ...s, avg_engagement: round(s.engagement / s.count) })).sort((a, b) => b.count - a.count || b.avg_engagement - a.avg_engagement).slice(0, 30);
  const hashtagSets = hashtags.filter((h) => h.count >= 2).sort((a, b) => b.avg_engagement - a.avg_engagement).slice(0, 10).map((h) => h.tag);

  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const gridEng = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const p of posts) {
    const d = new Date(p.timestamp);
    grid[d.getUTCDay()][d.getUTCHours()]++;
    gridEng[d.getUTCDay()][d.getUTCHours()] += engagementOf(p);
  }
  let best = null;
  grid.forEach((row, d) => row.forEach((n, h) => {
    if (!n) return;
    const a = gridEng[d][h] / n;
    if (!best || a > best.avg_engagement) best = { weekday: d, hour: h, avg_engagement: round(a) };
  }));

  return {
    summary,
    post_types,
    themes,
    hashtags,
    hashtag_set: hashtagSets,
    posting_times: { grid, best_slot_utc: best },
    top_posts: [...posts].sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, 6).map((p) => ({ ...p, engagement: engagementOf(p) })),
    analyzed_at: new Date().toISOString(),
  };
}

/** Parse a manual CSV/JSON import: columns caption, likes, comments, shares, media_type, timestamp, permalink. */
export function parseImport(text) {
  const t = String(text || '').trim();
  if (!t) throw new HttpError(400, 'Paste CSV or JSON with the competitor posts.');
  let rows;
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      rows = Array.isArray(j) ? j : j.posts || [];
    } catch {
      throw new HttpError(400, 'That JSON could not be parsed.');
    }
  } else {
    const lines = parseCsv(t);
    const head = lines.shift().map((h) => h.trim().toLowerCase());
    rows = lines.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]])));
  }
  const posts = rows.map((r, i) => ({
    id: String(r.id || i),
    caption: String(r.caption || r.text || r.message || ''),
    likes: Number(r.likes || r.like_count || 0),
    comments: Number(r.comments || r.comments_count || 0),
    shares: Number(r.shares || 0),
    media_type: String(r.media_type || r.type || 'IMAGE').toUpperCase(),
    timestamp: new Date(r.timestamp || r.date || r.created_time || Date.now()).toISOString(),
    permalink: r.permalink || r.url || null,
  })).filter((p) => p.caption || p.likes);
  if (!posts.length) throw new HttpError(400, 'No posts found. Include at least caption and likes columns.');
  return posts;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
