import { one } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../auth.js';
import { accountWithTokens } from '../publishers/index.js';
import { api } from '../publishers/common.js';
import { keywords } from './content.js';

// Ad Intelligence: competitor ads from the Meta Ad Library API. Ads that keep running are a
// strong signal that they are profitable, so longevity drives the "winners" ranking.

const FIELDS = 'id,page_id,page_name,ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,ad_creative_link_captions,ad_snapshot_url,publisher_platforms,languages';

function metaToken(brand) {
  const row = one("SELECT * FROM social_accounts WHERE brand_id = ? AND platform IN ('facebook','instagram') AND status = 'active' LIMIT 1", brand.id);
  if (!row) throw new HttpError(400, 'Ad Intelligence reads the Meta Ad Library with your Facebook connection. Connect a Facebook Page first.');
  return accountWithTokens(row).access_token;
}

export async function fetchAds(brand, tracker) {
  const token = metaToken(brand);
  const params = new URLSearchParams({ ad_reached_countries: JSON.stringify([tracker.country || 'US']), ad_active_status: 'ALL', ad_type: 'ALL', fields: FIELDS, limit: '100', access_token: token });
  if (tracker.page_id) params.set('search_page_ids', JSON.stringify([tracker.page_id]));
  else params.set('search_terms', tracker.query);
  const r = (await api('Meta Ad Library', `https://graph.facebook.com/${config.oauth.facebook.graphVersion}/ads_archive?${params}`)).body;
  return (r.data || []).map((a) => ({
    id: a.id,
    page_id: a.page_id,
    page_name: a.page_name,
    body: a.ad_creative_bodies?.[0] || '',
    title: a.ad_creative_link_titles?.[0] || '',
    description: a.ad_creative_link_descriptions?.[0] || '',
    caption: a.ad_creative_link_captions?.[0] || '',
    started: a.ad_delivery_start_time || a.ad_creation_time,
    stopped: a.ad_delivery_stop_time || null,
    platforms: a.publisher_platforms || [],
    snapshot: a.ad_snapshot_url,
  }));
}

const CTA_WORDS = ['shop now', 'learn more', 'sign up', 'get started', 'buy now', 'order now', 'download', 'book now', 'try free', 'subscribe', 'get offer'];

export function summarizeAds(ads, at = new Date()) {
  const withDays = ads.map((a) => {
    const end = a.stopped ? new Date(a.stopped) : at;
    const days = Math.max(1, Math.round((end - new Date(a.started)) / 864e5));
    return { ...a, active: !a.stopped || new Date(a.stopped) > at, days_running: days };
  });
  const winners = [...withDays].sort((a, b) => b.days_running - a.days_running).slice(0, 10);
  const platforms = {};
  const ctas = {};
  const hooks = {};
  for (const a of withDays) {
    for (const p of a.platforms) platforms[p] = (platforms[p] || 0) + 1;
    const text = `${a.body} ${a.title} ${a.caption}`.toLowerCase();
    for (const c of CTA_WORDS) if (text.includes(c)) ctas[c] = (ctas[c] || 0) + 1;
    const first = (a.body.split(/[.!?\n]/)[0] || '').trim();
    if (first) hooks[first] = (hooks[first] || 0) + 1;
    if (/%|off|sale|discount|free shipping|deal/i.test(text)) ctas['offer-led'] = (ctas['offer-led'] || 0) + 1;
  }
  return {
    total: withDays.length,
    active: withDays.filter((a) => a.active).length,
    long_runners: withDays.filter((a) => a.days_running >= 30).length,
    avg_days_running: withDays.length ? Math.round(withDays.reduce((s, a) => s + a.days_running, 0) / withDays.length) : 0,
    platforms,
    angles: Object.entries(ctas).sort((a, b) => b[1] - a[1]).map(([angle, count]) => ({ angle, count })),
    top_hooks: Object.entries(hooks).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hook, count]) => ({ hook, count })),
    keywords: keywords(withDays.map((a) => `${a.body} ${a.title}`).join(' '), 12),
    winners,
    ads: withDays,
  };
}
