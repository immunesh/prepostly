import { fetchText, fetchJson, normalizeUrl } from '../net.js';
import { HttpError } from '../auth.js';
import { normHex, luminance } from './render.js';
import { keywords } from './content.js';

// Reads public web pages: a brand's website (→ brand kit), store catalogues (→ products)
// and articles (→ blog-to-carousel). Pure HTML/JSON parsing, no browser.

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
export const stripTags = (html) => decode(String(html || '').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4]) : null;
}
function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop') || '').toLowerCase();
    if (k === key.toLowerCase()) return attr(tag, 'content');
  }
  return null;
}
const abs = (u, base) => {
  try { return u ? new URL(u, base).toString() : null; } catch { return null; }
};

function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      const stack = Array.isArray(j) ? [...j] : [j];
      while (stack.length) {
        const n = stack.shift();
        if (!n || typeof n !== 'object') continue;
        out.push(n);
        if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
        if (n.itemListElement) stack.push(...[].concat(n.itemListElement).map((x) => x.item || x));
      }
    } catch { /* malformed JSON-LD is common; skip it */ }
  }
  return out;
}
const isType = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).toLowerCase() === t);

/** Colors used in a page's inline CSS and theme-color, most frequent first, minus greys. */
function pageColors(html) {
  const counts = new Map();
  const bump = (h, w = 1) => {
    const c = normHex(h, null);
    if (!c) return;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat < 28) return; // greys, black and white say little about a brand
    counts.set(c, (counts.get(c) || 0) + w);
  };
  const theme = metaContent(html, 'theme-color');
  if (theme) bump(theme, 50);
  const tile = metaContent(html, 'msapplication-TileColor');
  if (tile) bump(tile, 20);
  const css = (html.match(/<style[\s\S]*?<\/style>/gi) || []).join(' ') + ' ' + (html.match(/style="[^"]*"/gi) || []).join(' ');
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) bump(`#${m[1]}`);
  for (const m of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) bump(`#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  // Drop near-duplicates.
  const out = [];
  for (const c of sorted) {
    const near = out.some((o) => [1, 3, 5].every((i) => Math.abs(parseInt(o.slice(i, i + 2), 16) - parseInt(c.slice(i, i + 2), 16)) < 24));
    if (!near) out.push(c);
    if (out.length === 4) break;
  }
  return out;
}

/** Fetch a website and derive brand details. */
export async function brandFromWebsite(input) {
  const url = normalizeUrl(input);
  const { text: html, url: finalUrl, status } = await fetchText(url);
  if (status >= 400) throw new HttpError(502, `${url.hostname} returned ${status}.`);
  const ld = jsonLd(html);
  const org = ld.find((n) => isType(n, 'organization') || isType(n, 'store') || isType(n, 'localbusiness') || isType(n, 'onlinestore'));
  const site = ld.find((n) => isType(n, 'website'));
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const ogName = metaContent(html, 'og:site_name');
  const name = (org?.name || site?.name || ogName || title.split(/\s[|\-–—:]\s/)[0] || url.hostname.replace(/^www\./, '').split('.')[0]).trim();
  const description = (metaContent(html, 'description') || metaContent(html, 'og:description') || org?.description || '').trim();

  // Logo candidates: JSON-LD logo, <img> with "logo" in it, apple-touch-icon, og:image.
  const imgLogo = (html.match(/<img\b[^>]*>/gi) || []).find((t) => /logo/i.test(`${attr(t, 'class')} ${attr(t, 'id')} ${attr(t, 'alt')} ${attr(t, 'src')}`));
  const icon = (html.match(/<link\b[^>]*>/gi) || []).filter((t) => /icon/i.test(attr(t, 'rel') || '')).sort((a, b) => (/apple-touch/i.test(attr(b, 'rel')) ? 1 : 0) - (/apple-touch/i.test(attr(a, 'rel')) ? 1 : 0))[0];
  const logoLd = typeof org?.logo === 'string' ? org.logo : org?.logo?.url;
  const logo = abs(logoLd, finalUrl) || abs(imgLogo && (attr(imgLogo, 'src') || attr(imgLogo, 'data-src')), finalUrl) || abs(icon && attr(icon, 'href'), finalUrl);

  // Social handles from profile links.
  const socials = {};
  for (const m of html.matchAll(/href=["'](https?:\/\/(?:www\.)?(instagram\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com\/company|tiktok\.com\/@|youtube\.com\/@|pinterest\.com)\/?([A-Za-z0-9_.@-]+))/gi)) {
    const net = m[2].split('.')[0].replace('twitter', 'x');
    if (!socials[net] && !/sharer|share|intent|plugins|policy/i.test(m[3])) socials[net] = m[3].replace(/^@/, '');
  }

  const bodyText = stripTags(html).slice(0, 4000);
  const colors = pageColors(html);
  const industryWords = keywords(`${title} ${description} ${bodyText.slice(0, 1500)}`, 3);
  return {
    name,
    website: `${new URL(finalUrl).origin}`,
    description: description.slice(0, 600),
    industry: industryWords.slice(0, 2).join(', '),
    colors: colors.length ? colors : [],
    logo,
    handle: socials.instagram || socials.x || socials.tiktok || '',
    socials,
    store: detectStore(html),
  };
}

function detectStore(html) {
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html)) return 'shopify';
  if (/woocommerce|wp-content\/plugins\/woocommerce/i.test(html)) return 'woocommerce';
  if (/static\.wixstatic\.com|wix\.com/i.test(html)) return 'wix';
  if (/squarespace/i.test(html)) return 'squarespace';
  if (/ecwid/i.test(html)) return 'ecwid';
  return null;
}

const firstSentence = (s) => String(s || '').split(/(?<=[.!?])\s+/)[0];

/** Import products from a store URL. Returns { platform, products[] }. */
export async function importProducts(input, { limit = 50 } = {}) {
  const url = normalizeUrl(input);
  const origin = url.origin;

  // Shopify exposes /products.json on every storefront.
  try {
    const j = await fetchJson(`${origin}/products.json?limit=${Math.min(limit, 250)}`);
    if (Array.isArray(j.products)) {
      return {
        platform: 'shopify',
        products: j.products.slice(0, limit).map((p) => ({
          external_id: `shopify:${p.id}`,
          title: p.title,
          description: stripTags(p.body_html).slice(0, 2000),
          price: p.variants?.[0]?.price || '',
          compare_at_price: p.variants?.[0]?.compare_at_price || '',
          currency: '',
          url: `${origin}/products/${p.handle}`,
          images: (p.images || []).map((i) => i.src).slice(0, 6),
        })),
      };
    }
  } catch { /* not Shopify */ }

  // WooCommerce Store API.
  try {
    const j = await fetchJson(`${origin}/wp-json/wc/store/v1/products?per_page=${Math.min(limit, 100)}`);
    if (Array.isArray(j)) {
      return {
        platform: 'woocommerce',
        products: j.slice(0, limit).map((p) => {
          const minor = 10 ** (p.prices?.currency_minor_unit ?? 2);
          return {
            external_id: `woo:${p.id}`,
            title: decode(p.name),
            description: stripTags(p.short_description || p.description).slice(0, 2000),
            price: p.prices?.price ? String(Number(p.prices.price) / minor) : '',
            compare_at_price: p.prices?.regular_price && p.prices.regular_price !== p.prices.price ? String(Number(p.prices.regular_price) / minor) : '',
            currency: p.prices?.currency_code || '',
            url: p.permalink,
            images: (p.images || []).map((i) => i.src).slice(0, 6),
          };
        }),
      };
    }
  } catch { /* not WooCommerce */ }

  // Any store: schema.org Product on the page, or product links followed one level.
  const { text: html, url: finalUrl } = await fetchText(url);
  let products = jsonLd(html).filter((n) => isType(n, 'product')).map((n) => ldProduct(n, finalUrl));
  if (!products.length) {
    const links = [...new Set([...html.matchAll(/href=["']([^"']*\/(?:products?|p|item|shop)\/[^"'#?]+)["']/gi)].map((m) => abs(m[1], finalUrl)).filter(Boolean))].slice(0, Math.min(limit, 24));
    for (const link of links) {
      try {
        const page = await fetchText(link);
        const found = jsonLd(page.text).filter((n) => isType(n, 'product')).map((n) => ldProduct(n, page.url));
        products.push(...found);
      } catch { /* skip unreachable product pages */ }
    }
  }
  const seen = new Set();
  products = products.filter((p) => p.title && !seen.has(p.external_id) && seen.add(p.external_id)).slice(0, limit);
  if (!products.length) throw new HttpError(422, `No products found at ${url.hostname}. Shopify, WooCommerce and pages with schema.org Product data are supported.`);
  return { platform: detectStore(html) || 'website', products };
}

function ldProduct(n, base) {
  const offer = [].concat(n.offers || [])[0] || {};
  const inner = offer.offers ? [].concat(offer.offers)[0] : offer;
  const images = [].concat(n.image || []).map((i) => (typeof i === 'string' ? i : i?.url)).map((u) => abs(u, base)).filter(Boolean);
  const url = abs(n.url || inner.url, base) || base;
  return {
    external_id: `web:${n.sku || n.productID || url}`,
    title: decode(n.name || ''),
    description: stripTags(n.description || '').slice(0, 2000),
    price: String(inner.price ?? inner.lowPrice ?? ''),
    compare_at_price: '',
    currency: inner.priceCurrency || '',
    url,
    images: images.slice(0, 6),
  };
}

/** Product from a single product page URL (Ads Studio). */
export async function productFromUrl(input) {
  const url = normalizeUrl(input);
  if (/\/products\//.test(url.pathname)) {
    try {
      const j = await fetchJson(`${url.origin}${url.pathname.replace(/\/$/, '')}.json`);
      if (j.product) {
        const p = j.product;
        return { external_id: `shopify:${p.id}`, title: p.title, description: stripTags(p.body_html).slice(0, 2000), price: p.variants?.[0]?.price || '', compare_at_price: p.variants?.[0]?.compare_at_price || '', currency: '', url: url.toString(), images: (p.images || []).map((i) => i.src).slice(0, 6) };
      }
    } catch { /* fall through to page parsing */ }
  }
  const { text: html, url: finalUrl } = await fetchText(url);
  const p = jsonLd(html).find((n) => isType(n, 'product'));
  if (p) return ldProduct(p, finalUrl);
  const title = metaContent(html, 'og:title') || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  if (!title) throw new HttpError(422, 'Could not find a product on that page.');
  return {
    external_id: `web:${finalUrl}`,
    title,
    description: metaContent(html, 'og:description') || metaContent(html, 'description') || firstSentence(stripTags(html)),
    price: metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount') || '',
    compare_at_price: '',
    currency: metaContent(html, 'product:price:currency') || '',
    url: finalUrl,
    images: [abs(metaContent(html, 'og:image'), finalUrl)].filter(Boolean),
  };
}

/** Main content of an article: { title, text, sections[{ heading, text }] }. */
export async function extractArticle(input) {
  const { text: html, url } = await fetchText(normalizeUrl(input));
  const title = (metaContent(html, 'og:title') || decode((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '') || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).replace(/<[^>]+>/g, '').trim();
  const main = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
  const sections = [];
  const parts = main.split(/<h[23][^>]*>/i).slice(1);
  for (const part of parts) {
    const [h, ...rest] = part.split(/<\/h[23]>/i);
    const heading = stripTags(h).slice(0, 90);
    const para = stripTags(rest.join(' ')).split('\n').find((l) => l.length > 40) || '';
    if (heading) sections.push({ heading, text: firstSentence(para).slice(0, 220) });
  }
  const text = stripTags(main).slice(0, 20000);
  if (text.length < 200) throw new HttpError(422, `Could not find article text at ${new URL(url).hostname}.`);
  return { title, text, sections: sections.slice(0, 8), url };
}

/** Is this color dark enough to put white text on? (exported for tests) */
export const isDark = (hex) => luminance(hex) < 0.4;
