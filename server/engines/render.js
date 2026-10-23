import fs from 'node:fs';
import path from 'node:path';
import { renderAsync } from '@resvg/resvg-js';
import { ROOT } from '../config.js';
import { FORMATS } from '../catalog.js';

// Composes post creatives as SVG and rasterizes them with resvg. Each slide is laid out
// from a template (visual style) and a kind (what the slide says).

const FONT_DIR = path.join(ROOT, 'assets', 'fonts');
const fontFiles = fs.existsSync(FONT_DIR) ? fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => path.join(FONT_DIR, f)) : [];

// Static font files register each weight as its own family ("Poppins ExtraBold"), so map
// (family, weight) → registered family name from the files' name tables.
function ttfFamilyName(file) {
  const d = fs.readFileSync(file);
  const tables = d.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const rec = 12 + 16 * i;
    if (d.toString('latin1', rec, rec + 4) !== 'name') continue;
    const off = d.readUInt32BE(rec + 8);
    const count = d.readUInt16BE(off + 2);
    const strings = off + d.readUInt16BE(off + 4);
    for (let j = 0; j < count; j++) {
      const r = off + 6 + 12 * j;
      if (d.readUInt16BE(r) === 3 && d.readUInt16BE(r + 6) === 1) {
        const len = d.readUInt16BE(r + 8);
        const start = strings + d.readUInt16BE(r + 10);
        return d.subarray(start, start + len).swap16().toString('utf16le');
      }
    }
  }
  return null;
}
const FAMILIES = {};
for (const file of fontFiles) {
  const m = path.basename(file).match(/^(.+)-(\d+)\.ttf$/);
  const name = m && ttfFamilyName(file);
  if (name) (FAMILIES[m[1]] ||= []).push({ weight: Number(m[2]), name });
}
/** CSS font-family list for a font at a weight, using the closest bundled static weight. */
export function family(font, weight = 400) {
  const opts = FAMILIES[String(font).replace(/\s+/g, '')];
  if (!opts) return `'${font}', ${FALLBACK}`;
  const best = opts.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a));
  return `'${best.name}', '${font}', ${FALLBACK}`;
}

// Average glyph width as a fraction of font size, used to wrap text without a layout engine.
const WIDTH = { Poppins: 0.6, Inter: 0.56, Montserrat: 0.62, 'Playfair Display': 0.52, Anton: 0.44, Lora: 0.52, Oswald: 0.45, Raleway: 0.58 };
const FALLBACK = "'Helvetica Neue', Arial, sans-serif";

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- color helpers
const hexRe = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function normHex(h, d = '#6d28d9') {
  if (!h || !hexRe.test(h.trim())) return d;
  let x = h.trim().replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return `#${x.toLowerCase()}`;
}
const rgb = (h) => {
  const x = normHex(h).slice(1);
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
export function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrastOn = (bg) => (luminance(bg) > 0.42 ? '#111111' : '#ffffff');
const mix = (a, b, t) => {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
};

/** Derive a working palette from the brand's colors. */
export function paletteFor(brand) {
  let colors = [];
  try { colors = (typeof brand.colors === 'string' ? JSON.parse(brand.colors) : brand.colors) || []; } catch { colors = []; }
  colors = colors.map((c) => normHex(c, null)).filter(Boolean);
  const primary = colors[0] || '#6d28d9';
  const secondary = colors[1] || mix(primary, luminance(primary) > 0.4 ? '#000000' : '#ec4899', 0.55);
  const accent = colors[2] || (luminance(primary) > 0.5 ? '#111827' : '#facc15');
  const dark = [primary, secondary, accent].sort((a, b) => luminance(a) - luminance(b))[0];
  return { primary, secondary, accent, dark: luminance(dark) < 0.08 ? dark : mix(dark, '#000000', 0.7), light: '#fbfaf7' };
}

// ---------------------------------------------------------------- text layout
export function wrap(text, maxWidth, size, factor) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  const fits = (s) => s.length * size * factor <= maxWidth;
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (fits(candidate) || !line) line = candidate;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest font size (stepping down) at which text fits in maxLines. */
export function fit(text, { maxWidth, maxLines, max, min, font = 'Poppins', upper = false }) {
  const factor = (WIDTH[font] || 0.58) * (upper ? 1.12 : 1);
  for (let size = max; size >= min; size -= 2) {
    const lines = wrap(text, maxWidth, size, factor);
    if (lines.length <= maxLines && lines.every((l) => l.length * size * factor <= maxWidth * 1.04)) return { size, lines };
  }
  const lines = wrap(text, maxWidth, min, factor);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return { size: min, lines };
}

const caseOf = (s, mode) => (mode === 'upper' ? String(s).toUpperCase() : mode === 'title' ? String(s).replace(/\b\w/g, (c) => c.toUpperCase()) : String(s));

function textBlock({ lines, x, y, size, font, weight = 700, fill, anchor = 'start', lineHeight = 1.12, extra = '' }) {
  const fam = family(font, weight);
  return lines
    .map((l, i) => `<text x="${x}" y="${(y + i * size * lineHeight).toFixed(1)}" font-family="${esc(fam)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ${extra}>${esc(l)}</text>`)
    .join('');
}

// Deterministic pseudo-random numbers so a slide re-renders identically.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft color glows. Radial gradients look like blurred circles at a fraction of the cost of feGaussianBlur.
function blobs(W, H, colors, seed, opacity = 0.35) {
  const r = rng(seed);
  let defs = '';
  let out = '';
  for (let i = 0; i < 4; i++) {
    const cx = r() * W;
    const cy = r() * H;
    const rad = (0.3 + r() * 0.4) * Math.max(W, H);
    const id = `blob${String(seed).replace(/\W/g, '').slice(-8)}${i}`;
    defs += `<radialGradient id="${id}"><stop offset="0" stop-color="${colors[i % colors.length]}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${colors[i % colors.length]}" stop-opacity="0"/></radialGradient>`;
    out += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="url(#${id})"/>`;
  }
  return `<defs>${defs}</defs>${out}`;
}

function image(href, x, y, w, h, fitMode = 'slice', align = 'xMidYMid') {
  return `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${align} ${fitMode}"/>`;
}

// ---------------------------------------------------------------- slide composition
/**
 * Build the SVG for one slide.
 * slide: { kind, headline, body, kicker, cta, stat, image, price, compareAt, badge, disclaimer, author, top, bottom, caption }
 * assets: { image: dataUri|null, logo: dataUri|null }
 */
export function slideSvg({ brand, slide, index = 0, total = 1, format = 'square', template = 'bold', assets = {}, watermark = false, seed = 'x' }) {
  const f = FORMATS[format] || FORMATS.square;
  const W = f.w;
  const H = f.h;
  const P = paletteFor(brand);
  const pad = Math.round(Math.min(W, H) * 0.08);
  const head = brand.font_heading || 'Poppins';
  const bodyFont = brand.font_body || 'Inter';
  const tcase = brand.text_case || 'default';
  const unit = Math.min(W, H) / 1080;
  const portrait = H / W > 1.2;
  const landscape = W / H > 1.2;
  const kind = slide.kind || 'cover';
  const hasImage = Boolean(assets.image);
  const id = (s) => `${s}${index}`;

  let bg = '';
  let fg = '#ffffff';
  let muted = 'rgba(255,255,255,0.82)';
  let accent = P.accent;
  let textArea = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  let headFont = head;
  let headWeight = 800;

  // ---- background by template
  const effTemplate = kind === 'meme' ? 'meme' : template === 'photo' && !hasImage ? 'bold' : template === 'split' && !hasImage ? 'minimal' : template;
  if (effTemplate === 'bold' || effTemplate === 'meme') {
    bg = `<rect width="${W}" height="${H}" fill="url(#${id('g')})"/>${blobs(W, H, [P.secondary, P.accent, P.primary], seed + index, 0.28)}`;
    fg = contrastOn(mix(P.primary, P.secondary, 0.5));
    muted = fg === '#ffffff' ? 'rgba(255,255,255,0.86)' : 'rgba(17,17,17,0.78)';
    if (luminance(accent) > 0.5 === (fg === '#111111')) accent = fg === '#ffffff' ? '#ffffff' : P.dark;
  } else if (effTemplate === 'minimal') {
    bg = `<rect width="${W}" height="${H}" fill="${P.light}"/><rect x="0" y="0" width="${Math.round(18 * unit)}" height="${H}" fill="${P.primary}"/><circle cx="${W - pad}" cy="${pad}" r="${Math.round(120 * unit)}" fill="${P.secondary}" opacity="0.12"/>`;
    fg = '#141414';
    muted = '#4b5563';
    accent = luminance(P.primary) > 0.6 ? P.dark : P.primary;
  } else if (effTemplate === 'photo') {
    bg = `${image(assets.image, 0, 0, W, H)}<rect width="${W}" height="${H}" fill="url(#${id('shade')})"/>`;
    textArea = { x: pad, y: H * 0.42, w: W - pad * 2, h: H * 0.58 - pad };
    fg = '#ffffff';
    muted = 'rgba(255,255,255,0.9)';
    accent = luminance(P.accent) > 0.35 ? P.accent : '#ffffff';
  } else if (effTemplate === 'split') {
    if (landscape) {
      bg = `<rect width="${W}" height="${H}" fill="${P.primary}"/>${image(assets.image, 0, 0, W / 2, H)}`;
      textArea = { x: W / 2 + pad, y: pad, w: W / 2 - pad * 2, h: H - pad * 2 };
    } else {
      const ih = Math.round(H * 0.5);
      bg = `<rect width="${W}" height="${H}" fill="${P.primary}"/>${image(assets.image, 0, 0, W, ih)}`;
      textArea = { x: pad, y: ih + pad * 0.7, w: W - pad * 2, h: H - ih - pad * 1.5 };
    }
    fg = contrastOn(P.primary);
    muted = fg === '#ffffff' ? 'rgba(255,255,255,0.85)' : 'rgba(17,17,17,0.75)';
    accent = fg === '#ffffff' ? (luminance(P.accent) > 0.4 ? P.accent : '#ffffff') : P.dark;
  } else if (effTemplate === 'editorial') {
    bg = `<rect width="${W}" height="${H}" fill="#f6f1e9"/><line x1="${pad}" y1="${pad * 1.5}" x2="${W - pad}" y2="${pad * 1.5}" stroke="#141414" stroke-width="${2 * unit}"/><line x1="${pad}" y1="${H - pad * 1.6}" x2="${W - pad}" y2="${H - pad * 1.6}" stroke="#141414" stroke-width="${2 * unit}"/>`;
    textArea = { x: pad, y: pad * 2, w: W - pad * 2, h: H - pad * 4 };
    fg = '#141414';
    muted = '#3f3f46';
    accent = luminance(P.primary) > 0.6 ? P.dark : P.primary;
    headFont = 'Playfair Display';
    headWeight = 900;
  } else if (effTemplate === 'neon') {
    bg = `<rect width="${W}" height="${H}" fill="#0b0b12"/>${blobs(W, H, [P.primary, P.secondary], seed + index, 0.22)}<rect x="${pad / 4}" y="${pad / 4}" width="${W - pad / 2}" height="${H - pad / 2}" rx="${24 * unit}" fill="none" stroke="${luminance(P.accent) > 0.2 ? P.accent : P.secondary}" stroke-width="${3 * unit}" opacity="0.8"/>`;
    fg = '#ffffff';
    muted = 'rgba(255,255,255,0.8)';
    accent = luminance(P.accent) > 0.2 ? P.accent : '#a78bfa';
  }

  const defs = `<defs>
    <linearGradient id="${id('g')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P.primary}"/><stop offset="1" stop-color="${P.secondary}"/></linearGradient>
    <linearGradient id="${id('shade')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0.2" stop-color="#000" stop-opacity="0.05"/><stop offset="0.55" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.88"/></linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${Math.round(8 * unit)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="${id('card')}"><rect x="${pad}" y="${pad * 1.2}" width="${W - pad * 2}" height="${H * (portrait ? 0.5 : 0.52)}" rx="${28 * unit}"/></clipPath>
  </defs>`;

  const glow = effTemplate === 'neon' ? 'filter="url(#glow)"' : '';
  let body = '';
  const T = textArea;
  const headMax = Math.round((portrait ? 104 : landscape ? 92 : 96) * unit);

  const pill = (label, x, y, anchor = 'start') => {
    const size = Math.round(34 * unit);
    const w = label.length * size * 0.6 + size * 1.6;
    const bx = anchor === 'middle' ? x - w / 2 : x;
    const pfg = contrastOn(accent);
    return `<rect x="${bx}" y="${y}" width="${w}" height="${size * 2}" rx="${size}" fill="${accent}"/><text x="${bx + w / 2}" y="${y + size * 1.35}" font-family="${esc(family(bodyFont, 700))}" font-size="${size}" font-weight="700" fill="${pfg}" text-anchor="middle">${esc(label)}</text>`;
  };

  if (kind === 'meme') {
    const memeImg = hasImage ? image(assets.image, 0, 0, W, H) : '';
    const stroke = `stroke="#000" stroke-width="${Math.round(6 * unit)}" paint-order="stroke" stroke-linejoin="round"`;
    const top = fit(String(slide.top || slide.headline || '').toUpperCase(), { maxWidth: W - pad * 2, maxLines: 3, max: Math.round(92 * unit), min: Math.round(48 * unit), font: 'Anton', upper: true });
    const bottom = fit(String(slide.bottom || slide.body || '').toUpperCase(), { maxWidth: W - pad * 2, maxLines: 3, max: Math.round(92 * unit), min: Math.round(48 * unit), font: 'Anton', upper: true });
    body = `${memeImg}
      ${textBlock({ lines: top.lines, x: W / 2, y: pad + top.size, size: top.size, font: 'Anton', weight: 400, fill: '#fff', anchor: 'middle', lineHeight: 1.05, extra: stroke })}
      ${textBlock({ lines: bottom.lines, x: W / 2, y: H - pad - (bottom.lines.length - 1) * bottom.size * 1.05, size: bottom.size, font: 'Anton', weight: 400, fill: '#fff', anchor: 'middle', lineHeight: 1.05, extra: stroke })}`;
  } else if (kind === 'quote') {
    const q = fit(`“${slide.headline || ''}”`, { maxWidth: T.w, maxLines: portrait ? 8 : 6, max: Math.round(78 * unit), min: Math.round(38 * unit), font: 'Playfair Display' });
    const blockH = q.lines.length * q.size * 1.25;
    const y0 = T.y + (T.h - blockH) / 2 + q.size * 0.5;
    body = `<text x="${T.x}" y="${y0 - q.size * 0.6}" font-family="${esc(family('Playfair Display', 400))}" font-size="${Math.round(220 * unit)}" fill="${accent}" opacity="0.35">“</text>
      ${textBlock({ lines: q.lines, x: T.x, y: y0, size: q.size, font: 'Playfair Display', weight: 700, fill: fg, lineHeight: 1.25, extra: glow })}
      ${slide.author ? textBlock({ lines: [`— ${slide.author}`], x: T.x, y: y0 + blockH + 30 * unit, size: Math.round(36 * unit), font: bodyFont, weight: 600, fill: muted }) : ''}`;
  } else if (kind === 'product' || kind === 'ad') {
    const cardH = H * (portrait ? 0.5 : 0.52);
    const prodImg = hasImage ? `<rect x="${pad}" y="${pad * 1.2}" width="${W - pad * 2}" height="${cardH}" rx="${28 * unit}" fill="#ffffff"/><g clip-path="url(#${id('card')})">${image(assets.image, pad, pad * 1.2, W - pad * 2, cardH, kind === 'product' ? 'meet' : 'slice')}</g>` : '';
    const ty = hasImage ? pad * 1.2 + cardH + pad * 0.8 : T.y + T.h * 0.2;
    const hl = fit(caseOf(slide.headline, tcase), { maxWidth: W - pad * 2, maxLines: 2, max: Math.round(76 * unit), min: Math.round(40 * unit), font: headFont });
    let y = ty + hl.size;
    body = prodImg + textBlock({ lines: hl.lines, x: pad, y, size: hl.size, font: headFont, weight: headWeight, fill: fg, extra: glow });
    y += (hl.lines.length - 1) * hl.size * 1.12 + 20 * unit;
    if (slide.body) {
      const sb = fit(slide.body, { maxWidth: W - pad * 2, maxLines: 2, max: Math.round(36 * unit), min: Math.round(26 * unit), font: bodyFont });
      body += textBlock({ lines: sb.lines, x: pad, y: y + sb.size, size: sb.size, font: bodyFont, weight: 400, fill: muted, lineHeight: 1.3 });
      y += sb.lines.length * sb.size * 1.3 + 20 * unit;
    }
    if (slide.price) {
      const ps = Math.round(56 * unit);
      body += `<text x="${pad}" y="${y + ps}" font-family="${esc(family(head, 800))}" font-size="${ps}" font-weight="800" fill="${fg}">${esc(slide.price)}</text>`;
      if (slide.compareAt) body += `<text x="${pad + slide.price.length * ps * 0.62 + 24 * unit}" y="${y + ps}" font-family="${esc(family(bodyFont, 400))}" font-size="${Math.round(36 * unit)}" fill="${muted}" text-decoration="line-through">${esc(slide.compareAt)}</text>`;
      y += ps + 24 * unit;
    }
    if (slide.cta) body += pill(slide.cta, pad, Math.min(y + 8 * unit, H - pad * 1.9));
    if (slide.badge) {
      const r = Math.round(92 * unit);
      const bx = W - pad - r * 0.6;
      const by = pad * 1.2 + r * 0.4;
      const bt = fit(String(slide.badge).toUpperCase(), { maxWidth: r * 1.6, maxLines: 2, max: Math.round(34 * unit), min: Math.round(18 * unit), font: head, upper: true });
      body += `<circle cx="${bx}" cy="${by}" r="${r}" fill="${accent}"/>${textBlock({ lines: bt.lines, x: bx, y: by - ((bt.lines.length - 1) * bt.size) / 2 + bt.size * 0.35, size: bt.size, font: head, weight: 800, fill: contrastOn(accent), anchor: 'middle', lineHeight: 1 })}`;
    }
    if (slide.disclaimer) body += textBlock({ lines: [slide.disclaimer], x: pad, y: H - pad * 1.25, size: Math.round(20 * unit), font: bodyFont, weight: 400, fill: muted });
  } else if (kind === 'stat') {
    const st = fit(slide.stat || '', { maxWidth: T.w, maxLines: 1, max: Math.round(260 * unit), min: Math.round(90 * unit), font: head });
    const hl = fit(caseOf(slide.headline, tcase), { maxWidth: T.w, maxLines: 3, max: Math.round(64 * unit), min: Math.round(36 * unit), font: headFont });
    const y0 = T.y + T.h * 0.35;
    body = textBlock({ lines: st.lines, x: T.x, y: y0, size: st.size, font: head, weight: 900, fill: accent, extra: glow }) +
      textBlock({ lines: hl.lines, x: T.x, y: y0 + hl.size * 1.6, size: hl.size, font: headFont, weight: headWeight, fill: fg });
    if (slide.body) {
      const sb = fit(slide.body, { maxWidth: T.w, maxLines: 3, max: Math.round(34 * unit), min: Math.round(24 * unit), font: bodyFont });
      body += textBlock({ lines: sb.lines, x: T.x, y: y0 + hl.size * 1.6 + hl.lines.length * hl.size * 1.12 + sb.size, size: sb.size, font: bodyFont, weight: 400, fill: muted, lineHeight: 1.35 });
    }
  } else {
    // cover / point / cta / scene
    const isPoint = kind === 'point';
    const isCta = kind === 'cta';
    const kickerSize = Math.round(30 * unit);
    const hl = fit(caseOf(slide.headline, tcase), { maxWidth: T.w, maxLines: isPoint ? 3 : 4, max: isPoint ? Math.round(80 * unit) : headMax, min: Math.round(40 * unit), font: headFont, upper: tcase === 'upper' });
    const sb = slide.body ? fit(slide.body, { maxWidth: T.w, maxLines: isPoint ? (portrait ? 7 : 5) : 3, max: Math.round(40 * unit), min: Math.round(26 * unit), font: bodyFont }) : null;
    const numH = isPoint ? Math.round(150 * unit) : 0;
    const kick = slide.kicker && !isPoint ? kickerSize * 2 : 0;
    const blockH = numH + kick + hl.lines.length * hl.size * 1.12 + (sb ? sb.lines.length * sb.size * 1.4 + 30 * unit : 0) + (isCta && slide.cta ? 120 * unit : 0);
    const centered = effTemplate === 'photo' ? T.y + T.h - blockH : effTemplate === 'split' ? T.y : T.y + Math.max(0, (T.h - blockH) / 2);
    let y = centered;
    if (isPoint) {
      body += `<text x="${T.x}" y="${y + numH * 0.85}" font-family="${esc(family(head, 900))}" font-size="${numH}" font-weight="900" fill="${accent}" opacity="0.9" ${glow}>${String(index).padStart(2, '0')}</text>`;
      y += numH + 10 * unit;
    }
    if (kick) {
      body += `<text x="${T.x}" y="${y + kickerSize}" font-family="${esc(family(bodyFont, 700))}" font-size="${kickerSize}" font-weight="700" letter-spacing="${4 * unit}" fill="${accent}">${esc(String(slide.kicker).toUpperCase())}</text>`;
      y += kick;
    }
    y += hl.size * 0.95;
    body += textBlock({ lines: hl.lines, x: T.x, y, size: hl.size, font: headFont, weight: headWeight, fill: fg, extra: glow });
    y += (hl.lines.length - 1) * hl.size * 1.12;
    if (sb) {
      y += 30 * unit + sb.size;
      body += textBlock({ lines: sb.lines, x: T.x, y, size: sb.size, font: bodyFont, weight: 400, fill: muted, lineHeight: 1.4 });
      y += (sb.lines.length - 1) * sb.size * 1.4;
    }
    if (isCta && slide.cta) body += pill(slide.cta, T.x, y + 40 * unit);
    if (kind === 'cover' && total > 1) body += `<text x="${W - pad}" y="${H - pad * 0.55}" font-family="${esc(family(bodyFont, 700))}" font-size="${Math.round(28 * unit)}" font-weight="700" fill="${muted}" text-anchor="end">Swipe →</text>`;
  }

  // Video subtitle band.
  if (slide.caption) {
    const cs = fit(slide.caption, { maxWidth: W - pad * 2.4, maxLines: 2, max: Math.round(44 * unit), min: Math.round(30 * unit), font: bodyFont });
    const bandH = cs.lines.length * cs.size * 1.3 + cs.size;
    const by = H - pad * (portrait ? 3.2 : 1.6) - bandH;
    body += `<rect x="${pad * 0.7}" y="${by}" width="${W - pad * 1.4}" height="${bandH}" rx="${18 * unit}" fill="#000" opacity="0.62"/>${textBlock({ lines: cs.lines, x: W / 2, y: by + cs.size * 1.15, size: cs.size, font: bodyFont, weight: 700, fill: '#fff', anchor: 'middle', lineHeight: 1.3 })}`;
  }

  // Footer: logo, handle, carousel dots, watermark.
  let footer = '';
  const fy = H - pad * 0.55;
  const footFg = effTemplate === 'photo' || effTemplate === 'neon' ? 'rgba(255,255,255,0.9)' : kind === 'meme' ? '#ffffff' : muted;
  let fx = pad;
  if (assets.logo && kind !== 'meme') {
    const ls = Math.round(56 * unit);
    footer += image(assets.logo, fx, fy - ls * 0.78, ls * 2.4, ls, 'meet', 'xMinYMid');
    fx += ls * 2.6;
  }
  const handle = brand.handle ? `@${String(brand.handle).replace(/^@/, '')}` : brand.website ? String(brand.website).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : '';
  if (handle && kind !== 'meme' && !(kind === 'cover' && total > 1 && !assets.logo && false)) footer += `<text x="${fx}" y="${fy}" font-family="${esc(family(bodyFont, 600))}" font-size="${Math.round(26 * unit)}" font-weight="600" fill="${footFg}">${esc(handle)}</text>`;
  if (total > 1 && kind !== 'cover') {
    const dot = 10 * unit;
    const start = W - pad - total * dot * 2.4;
    for (let i = 0; i < total; i++) footer += `<circle cx="${start + i * dot * 2.4}" cy="${fy - dot}" r="${dot * (i === index ? 1 : 0.6)}" fill="${footFg}" opacity="${i === index ? 1 : 0.5}"/>`;
  }
  if (watermark) footer += `<text x="${W / 2}" y="${Math.round(pad * 0.5)}" font-family="${esc(family('Inter', 600))}" font-size="${Math.round(22 * unit)}" font-weight="600" fill="${footFg}" opacity="0.7" text-anchor="middle">Made with Prepostly</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${bg}${body}${footer}</svg>`;
}

/** Rasterize SVG to PNG on the libuv thread pool (keeps the event loop free). */
export async function svgToPng(svg, width) {
  const image = await renderAsync(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    // Scanning system fonts costs ~1s per render, so use the bundled set when present.
    font: { fontFiles, loadSystemFonts: !fontFiles.length, defaultFontFamily: 'Inter' },
    imageRendering: 0,
  });
  return image.asPng();
}

/** The trial watermark alone on a transparent w×h canvas, for overlaying on videos. */
export function watermarkPng(w, h) {
  const size = Math.round(w / 34);
  return svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${w / 2}" y="${Math.round(h * 0.04 + size)}" font-family="${esc(family('Inter', 600))}" font-size="${size}" font-weight="600" fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-opacity="0.35" stroke-width="${Math.max(1, size / 18)}" text-anchor="middle">Made with Prepostly</text></svg>`);
}

export async function renderSlide(opts) {
  const svg = slideSvg(opts);
  return { svg, png: await svgToPng(svg) };
}
