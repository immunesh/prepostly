import { POST_TYPES } from '../catalog.js';
import { llmAvailable, completeJson } from './llm.js';

// Copywriting for every post type. With Claude configured, copy comes from the model via
// structured outputs; otherwise a deterministic offline writer builds sensible copy from
// the prompt, brand and product data.

// ---------------------------------------------------------------- shared helpers
const STOP = new Set('a an the and or but for nor so yet of to in on at by with from about into over after before under between out up down off this that these those is are was were be been being am do does did have has had i me my we our you your he she it its they them their what which who whom how why when where all any both each few more most other some such no not only own same than too very can will just should now create make generate write post posts carousel video reel instagram facebook linkedin tiktok twitter social media please about regarding image images slide slides caption captions content brand new best top tips ideas idea'.split(' '));

export const titleCase = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());
const sentenceCase = (s) => {
  const t = String(s).trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};
const hashOf = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};
const pick = (arr, seed) => arr[hashOf(seed) % arr.length];

/** Lowercase a topic's first letter for use mid-sentence, unless it looks like a name or acronym. */
const midSentence = (t) => (/^[A-Z][a-z]/.test(t) && !/^[A-Z][a-z]+\s+[A-Z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);

/** The subject of a prompt, e.g. "Create a carousel about cold brew coffee tips" → "cold brew coffee tips". */
export function topicOf(prompt, fallback = 'your goals') {
  let t = String(prompt || '').split(/\n/)[0].trim();
  t = t.replace(/^(please\s+)?(create|make|generate|write|design|give me|i want|i need)\b[^:]*?\b(about|on|for|regarding|around|featuring|showing|promoting)\s+/i, '');
  t = t.replace(/^(a|an|the)\s+(post|carousel|video|reel|meme|quote|ad)\s+(about|on|for)\s+/i, '');
  t = t.replace(/[.!?]+$/, '').trim();
  if (t.length > 70) t = t.slice(0, 70).replace(/\s+\S*$/, '');
  return t || fallback;
}

export function keywords(text, n = 6) {
  const counts = new Map();
  for (const w of String(text || '').toLowerCase().match(/\p{L}[\p{L}\p{N}'-]{2,}/gu) || []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, n).map(([w]) => w);
}

/** Hashtags from text + brand defaults, deduplicated. */
export function makeHashtags(brand, text, n = 12) {
  const tags = [];
  const add = (t) => {
    const clean = String(t).replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (clean.length > 1 && !tags.some((x) => x.toLowerCase() === clean.toLowerCase())) tags.push(clean);
  };
  for (const t of String(brand.hashtags || '').split(/[\s,]+/)) if (t) add(t);
  const kws = keywords(text, 8);
  for (const k of kws) add(k);
  for (let i = 0; i + 1 < kws.length && i < 3; i++) add(kws[i] + kws[i + 1]);
  for (const k of keywords(`${brand.industry} ${brand.description}`, 3)) add(k);
  if (brand.name) add(brand.name.replace(/\s+/g, ''));
  for (const g of ['tips', 'inspiration', 'smallbusiness', 'community']) if (tags.length < n) add(g);
  return tags.slice(0, n).map((t) => `#${t}`);
}

/** Sentences or bullet items a user wrote into their prompt (used verbatim as points). */
function userPoints(prompt) {
  const lines = String(prompt || '').split(/\n+/).map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l.length > 3);
  if (lines.length >= 3) return lines.slice(1);
  const sentences = String(prompt || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 12);
  return sentences.length >= 3 ? sentences.slice(1) : [];
}

function splitPoint(p) {
  const m = p.match(/^(.{6,60}?)[:—–-]\s+(.+)$/);
  if (m) return { headline: sentenceCase(m[1]), body: sentenceCase(m[2]) };
  const words = p.split(' ');
  if (words.length <= 9) return { headline: sentenceCase(p), body: '' };
  return { headline: sentenceCase(words.slice(0, 6).join(' ').replace(/[,;:]$/, '')), body: sentenceCase(p) };
}

// ---------------------------------------------------------------- offline writer
const FRAMEWORKS = {
  tips: {
    cover: (t, n) => [n > 1 ? `${n} tips for ${t}` : `One tip for ${t}`, `Save this for later.`],
    points: [
      ['Start with the why', 'Know exactly why {t} matters to you. A clear reason keeps you going when motivation dips.'],
      ['Keep it simple', 'Pick one small, repeatable step for {t} and do it every day before you add more.'],
      ['Learn from the best', 'Study people who already do {t} well. Copy their process, not their results.'],
      ['Track your progress', 'What gets measured improves. Note one number for {t} each week and watch it move.'],
      ['Avoid the common trap', 'Most people overcomplicate {t}. Consistency beats intensity every time.'],
      ['Make it a habit', 'Tie {t} to something you already do daily so it happens on autopilot.'],
      ['Ask for feedback', 'Share your progress with {t} and ask one honest question. Outside eyes spot what you miss.'],
    ],
  },
  mistakes: {
    cover: (t, n) => [n > 1 ? `${n} mistakes to avoid with ${t}` : `The mistake to avoid with ${t}`, n >= 3 ? `Number ${Math.min(n, 3)} surprises everyone.` : 'Most people get this wrong.'],
    points: [
      ['Skipping the basics', 'Fundamentals feel boring, but they are what makes {t} work long-term.'],
      ['Doing too much at once', 'Spreading yourself thin slows {t} down. Focus on one thing until it sticks.'],
      ['Ignoring the data', 'Gut feeling is a start, not a strategy. Check what actually works for {t}.'],
      ['Copying without context', 'What works for others may not fit you. Adapt {t} to your situation.'],
      ['Giving up too early', 'Results with {t} compound. Most people quit right before it pays off.'],
      ['Not asking for help', 'Experts in {t} save you months of trial and error. Ask early.'],
    ],
  },
  guide: {
    cover: (t) => [`A simple guide to ${t}`, `Everything you need, nothing you don't.`],
    points: [
      ['Step 1: Get clear', 'Define what success with {t} looks like for you in one sentence.'],
      ['Step 2: Gather the essentials', 'List the few tools or resources {t} really needs. Skip the rest.'],
      ['Step 3: Start small', 'Run a tiny first version of {t} this week. Done beats perfect.'],
      ['Step 4: Review and adjust', 'Look at what worked, keep it, and change one thing.'],
      ['Step 5: Make it routine', 'Put {t} on your calendar so it keeps happening without willpower.'],
      ['Step 6: Share the results', 'Tell your audience how {t} went. Stories build trust.'],
    ],
  },
};

const HOOKS = [
  (t) => `Here's what nobody tells you about ${t} 👇`,
  (t) => `Want better results with ${t}? Start here.`,
  (t) => `${titleCase(t)}: the short version you can actually use.`,
  (t) => `Save this if ${t} is on your list this month 📌`,
  (t) => `We get asked about ${t} all the time. So here's our take.`,
];

const QUOTES = [
  { k: 'start begin launch new first', text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { k: 'quality excellence habit craft', text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Will Durant' },
  { k: 'success fail failure resilience', text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
  { k: 'creative creativity design art idea', text: 'Creativity is intelligence having fun.', author: 'Albert Einstein' },
  { k: 'simple simplicity minimal design', text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { k: 'customer service business client', text: 'There is only one boss. The customer.', author: 'Sam Walton' },
  { k: 'health fitness body wellness', text: 'Take care of your body. It is the only place you have to live.', author: 'Jim Rohn' },
  { k: 'food coffee cook eat kitchen', text: 'One cannot think well, love well, sleep well, if one has not dined well.', author: 'Virginia Woolf' },
  { k: 'learn learning education teach study', text: 'Live as if you were to die tomorrow. Learn as if you were to live forever.', author: 'Mahatma Gandhi' },
  { k: 'team together teamwork community', text: 'Alone we can do so little; together we can do so much.', author: 'Helen Keller' },
  { k: 'time plan productivity focus', text: 'The key is not to prioritize what is on your schedule, but to schedule your priorities.', author: 'Stephen Covey' },
  { k: 'dream goal future vision', text: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
  { k: 'change growth grow', text: 'Be the change that you wish to see in the world.', author: 'Mahatma Gandhi' },
  { k: 'work hard effort', text: 'Nothing will work unless you do.', author: 'Maya Angelou' },
  { k: 'innovation technology tech future', text: 'The best way to predict the future is to invent it.', author: 'Alan Kay' },
  { k: 'travel adventure explore', text: 'The world is a book and those who do not travel read only one page.', author: 'Augustine of Hippo' },
  { k: 'money finance invest saving', text: 'Do not save what is left after spending, but spend what is left after saving.', author: 'Warren Buffett' },
  { k: 'fashion style beauty', text: 'Fashion fades, only style remains the same.', author: 'Coco Chanel' },
];

const MEMES = [
  (t, a) => ({ top: `Me before ${t}`, bottom: `Me after ${t}: completely different person` }),
  (t, a) => ({ top: `Nobody:`, bottom: `${a || 'Me'}: let me tell you about ${t}` }),
  (t) => ({ top: `When someone says ${t} is easy`, bottom: `*laughs in experience*` }),
  (t) => ({ top: `Monday: I'll start ${t} tomorrow`, bottom: `Sunday: I'll start ${t} on Monday` }),
  (t) => ({ top: `${t}`, bottom: `It's not a phase, mom` }),
];

export const SPECIAL_DAYS = [
  ['01-01', "New Year's Day"], ['02-14', "Valentine's Day"], ['03-08', "International Women's Day"], ['03-20', 'International Day of Happiness'],
  ['04-22', 'Earth Day'], ['05-01', 'Labour Day'], ['06-05', 'World Environment Day'], ['06-21', 'International Yoga Day'],
  ['07-30', 'International Day of Friendship'], ['08-12', 'International Youth Day'], ['09-21', 'International Day of Peace'],
  ['10-01', 'International Coffee Day'], ['10-10', 'World Mental Health Day'], ['10-31', 'Halloween'], ['11-19', "International Men's Day"],
  ['11-28', 'Black Friday'], ['12-01', 'Cyber Monday'], ['12-25', 'Christmas Day'], ['12-31', "New Year's Eve"],
];

export function upcomingSpecialDays(from = new Date(), n = 6) {
  const y = from.getUTCFullYear();
  const list = [];
  for (const yr of [y, y + 1]) for (const [md, name] of SPECIAL_DAYS) {
    const d = new Date(`${yr}-${md}T00:00:00Z`);
    if (d >= new Date(from.toISOString().slice(0, 10))) list.push({ date: d.toISOString().slice(0, 10), name });
  }
  return list.slice(0, n);
}

function offlineCaption(brand, topic, lines, seed) {
  const hook = pick(HOOKS, seed)(topic);
  const body = lines.filter(Boolean).slice(0, 3).map((l) => `✅ ${l}`).join('\n');
  const handle = brand.handle ? `@${String(brand.handle).replace(/^@/, '')}` : brand.name;
  const cta = brand.cta || `Save this for later and follow ${handle} for more.`;
  return [hook, body, cta].filter(Boolean).join('\n\n');
}

function offlineWrite({ brand, type, prompt, slides: nSlides, product, article, specialDay, concept }) {
  const meta = POST_TYPES[type] || POST_TYPES.single_image;
  const topic = topicOf(prompt || product?.title || article?.title || specialDay || brand.description || brand.name);
  const seed = `${type}:${prompt}:${brand.id}`;
  const n = Math.max(1, Math.min(10, nSlides || meta.slides));
  const out = { title: titleCase(topic).slice(0, 80), slides: [], caption: '', hashtags: [] };
  const handle = brand.handle ? `@${String(brand.handle).replace(/^@/, '')}` : '';

  const multi = (count) => {
    const framework = FRAMEWORKS[pick(Object.keys(FRAMEWORKS), seed)];
    const own = article?.sections?.length ? article.sections.map((s) => ({ headline: s.heading, body: s.text })) : userPoints(prompt).map(splitPoint);
    const pointCount = Math.max(1, count - 2);
    const inline = midSentence(topic);
    const points = (own.length ? own : framework.points.map(([h, b]) => ({ headline: h, body: b.replaceAll('{t}', inline) }))).slice(0, pointCount);
    // A question or full sentence ("Why we roast in small batches") is already a headline.
    const asHeadline = /^(why|how|what|when|where|who|which|is|are|can|should|do|does)\b/i.test(topic) || topic.split(' ').length > 6;
    const [ch, cb] = article?.title ? [article.title, 'The key ideas, slide by slide.'] : asHeadline ? [topic, 'Here’s what you need to know.'] : framework.cover(inline, points.length);
    return [
      { kind: 'cover', kicker: brand.industry || brand.name || '', headline: sentenceCase(ch), body: cb, image_query: topic },
      ...points.map((p) => ({ kind: 'point', headline: p.headline, body: p.body, image_query: `${topic} ${p.headline}` })),
      { kind: 'cta', headline: 'Found this useful?', body: `Follow ${handle || brand.name} for more on ${topic}.`, cta: brand.cta ? brand.cta.slice(0, 28) : 'Save & share', image_query: topic },
    ].slice(0, Math.max(count, 3));
  };

  switch (type) {
    case 'carousel':
    case 'blog_to_carousel':
      out.slides = multi(n);
      break;
    case 'quote': {
      const kw = keywords(`${prompt} ${brand.industry} ${brand.description}`, 10);
      const scored = QUOTES.map((q) => ({ q, s: kw.filter((k) => q.k.includes(k)).length })).sort((a, b) => b.s - a.s);
      const q = scored[0].s ? scored[0].q : pick(QUOTES, seed);
      out.slides = [{ kind: 'quote', headline: q.text, author: q.author, image_query: topic }];
      out.title = `Quote: ${q.author}`;
      break;
    }
    case 'meme': {
      const m = pick(MEMES, seed)(topic, brand.audience ? titleCase(brand.audience.split(/[,.]/)[0]) : '');
      out.slides = [{ kind: 'meme', top: m.top, bottom: m.bottom, headline: m.top, body: m.bottom, image_query: topic }];
      break;
    }
    case 'special_day': {
      const day = specialDay || topic;
      out.slides = [{ kind: 'cover', kicker: brand.name || '', headline: `Happy ${day.replace(/^happy\s+/i, '')}!`, body: `Wishing you and yours a wonderful day from all of us${brand.name ? ` at ${brand.name}` : ''}.`, image_query: day }];
      out.title = day;
      break;
    }
    case 'ecom_product':
    case 'ad_creative': {
      const p = product || { title: topic, description: '', price: '' };
      const desc = String(p.description || '').split(/(?<=[.!?])\s+/)[0] || `Made for people who care about ${keywords(p.title, 2).join(' and ') || 'quality'}.`;
      const onSale = p.compare_at_price && p.price && parseFloat(p.compare_at_price) > parseFloat(p.price);
      const off = onSale ? Math.round((1 - parseFloat(p.price) / parseFloat(p.compare_at_price)) * 100) : 0;
      const c = concept || {};
      out.slides = [{
        kind: type === 'ad_creative' ? 'ad' : 'product',
        headline: c.headline || (type === 'ad_creative' ? `${p.title}: ${pick(['made to last', 'your new favorite', 'worth every penny', 'loved by thousands'], seed)}` : p.title),
        body: c.subheader || desc.slice(0, 120),
        price: c.price ?? (p.price ? formatPrice(p.price, p.currency) : ''),
        compareAt: onSale ? formatPrice(p.compare_at_price, p.currency) : '',
        badge: c.badge ?? (off ? `${off}% off` : type === 'ad_creative' ? 'New' : ''),
        cta: c.cta || (type === 'ad_creative' ? 'Shop now' : 'Tap to shop'),
        disclaimer: c.disclaimer || '',
        image_query: p.title,
      }];
      out.title = p.title;
      break;
    }
    case 'ecom_carousel': {
      const p = product || { title: topic, description: '' };
      const sentences = String(p.description || '').split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
      out.slides = [
        { kind: 'product', headline: p.title, body: sentences[0] || '', price: p.price ? formatPrice(p.price, p.currency) : '', cta: 'Swipe to see more' },
        ...sentences.slice(1, n - 1).map((s, i) => ({ kind: 'product', headline: pick(['Why you will love it', 'The details', 'Made to last', 'Perfect for every day'], seed + i), body: s })),
        { kind: 'cta', headline: 'Get yours today', body: brand.website ? `Shop at ${String(brand.website).replace(/^https?:\/\//, '')}` : 'Link in bio.', cta: 'Shop now' },
      ];
      out.title = p.title;
      break;
    }
    case 'video':
    case 'voiceover_video':
    case 'text_to_video':
    case 'ecom_video':
    case 'avatar_video': {
      const scenes = type === 'ecom_video' && product
        ? [
          { kind: 'product', headline: product.title, body: String(product.description || '').split(/(?<=[.!?])\s+/)[0] || '' },
          { kind: 'cover', headline: pick(['Designed for everyday life', 'Quality you can feel', 'Your new favorite'], seed), body: '' },
          { kind: 'product', headline: 'Now available', price: product.price ? formatPrice(product.price, product.currency) : '', body: '' },
          { kind: 'cta', headline: 'Shop now', body: brand.website ? String(brand.website).replace(/^https?:\/\//, '') : 'Link in bio', cta: 'Shop now' },
        ]
        : type === 'text_to_video' && userPoints(prompt).length
          ? [{ kind: 'cover', headline: titleCase(topic), body: '' }, ...userPoints(prompt).slice(0, n - 1).map((p) => ({ kind: 'cover', ...splitPoint(p) }))]
          : multi(n).map((s) => ({ ...s, kind: s.kind === 'point' ? 'cover' : s.kind }));
      out.slides = scenes.map((s) => ({ ...s, narration: [s.headline, s.body].filter(Boolean).join('. ').replace(/\.\./g, '.'), image_query: s.image_query || topic }));
      break;
    }
    default: {
      const own = userPoints(prompt);
      out.slides = [{ kind: 'cover', kicker: brand.industry || '', headline: sentenceCase(own.length ? topic : pick([`${titleCase(topic)}, made simple`, `Let's talk about ${topic}`, `Your guide to ${topic}`, `The truth about ${topic}`], seed)), body: own[0] || pick(['Small changes, big results.', 'Here is what actually works.', 'Read the caption for the details.'], seed), image_query: topic }];
    }
  }
  const lines = out.slides.filter((s) => s.kind === 'point').map((s) => s.headline);
  out.caption = offlineCaption(brand, topic, lines.length ? lines : [out.slides[0]?.body], seed);
  out.hashtags = makeHashtags(brand, `${prompt} ${topic} ${product?.title || ''}`);
  return out;
}

export function formatPrice(price, currency = '') {
  const v = parseFloat(price);
  if (Number.isNaN(v)) return String(price || '');
  const sym = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', AUD: 'A$', CAD: 'C$' }[String(currency).toUpperCase()] ?? (currency ? `${currency} ` : '$');
  return `${sym}${v % 1 ? v.toFixed(2) : v.toFixed(0)}`;
}

// ---------------------------------------------------------------- Claude writer
const SLIDE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Short, punchy on-image headline (max ~10 words).' },
    body: { type: 'string', description: 'Supporting on-image text (max ~30 words). Empty if not needed.' },
    kicker: { type: 'string', description: 'Tiny label above the headline (1-3 words). Empty if not needed.' },
    cta: { type: 'string', description: 'Button text (max 4 words) for CTA/ad slides, else empty.' },
    stat: { type: 'string', description: 'A big number for stat-style slides (e.g. "73%"), else empty.' },
    image_query: { type: 'string', description: '3-6 word stock-photo search query that illustrates this slide.' },
    narration: { type: 'string', description: 'Spoken voiceover line for video scenes (1-2 sentences). Empty for image posts.' },
  },
  required: ['headline', 'body', 'kicker', 'cta', 'stat', 'image_query', 'narration'],
  additionalProperties: false,
};
const POST_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Internal title for the content library (max 8 words).' },
    slides: { type: 'array', items: SLIDE_SCHEMA },
    caption: { type: 'string', description: 'Social caption: hook line, value, call to action. No hashtags.' },
    hashtags: { type: 'array', items: { type: 'string' }, description: '8-15 relevant hashtags including the # sign.' },
    quote_author: { type: 'string', description: 'Author for quote posts (real attribution only), else empty.' },
    meme_top: { type: 'string', description: 'Top meme text for meme posts, else empty.' },
    meme_bottom: { type: 'string', description: 'Bottom meme text for meme posts, else empty.' },
  },
  required: ['title', 'slides', 'caption', 'hashtags', 'quote_author', 'meme_top', 'meme_bottom'],
  additionalProperties: false,
};

function brandBrief(brand) {
  return [
    `Brand: ${brand.name}`,
    brand.industry && `Industry: ${brand.industry}`,
    brand.description && `About: ${brand.description}`,
    brand.audience && `Audience: ${brand.audience}`,
    brand.website && `Website: ${brand.website}`,
    brand.handle && `Handle: @${String(brand.handle).replace(/^@/, '')}`,
    brand.cta && `Preferred call to action: ${brand.cta}`,
    brand.hashtags && `Always include these hashtags: ${brand.hashtags}`,
  ].filter(Boolean).join('\n');
}

const TYPE_GUIDE = {
  single_image: 'One slide. A scroll-stopping headline and one supporting line.',
  carousel: 'Slide 1 is a hook/cover. Middle slides each deliver one concrete, specific point. The last slide is a call to action with a cta.',
  blog_to_carousel: 'Summarize the article: slide 1 is the hook, middle slides are its key ideas in order, the last slide is a call to action.',
  quote: 'One slide whose headline is a real, correctly attributed quote that fits the brand; put the author in quote_author. Never invent quotes.',
  meme: 'One relatable, brand-safe meme for the audience. Fill meme_top and meme_bottom (short!). Headline = meme_top, body = meme_bottom.',
  special_day: 'One slide greeting the audience for the occasion, warm and on-brand.',
  ecom_product: 'One product showcase slide: benefit-led headline, short body, cta like "Shop now". Use only facts from the product data.',
  ecom_carousel: 'Product carousel: cover with the product, then slides on benefits/features/use cases, last slide a cta. Use only the product data.',
  ad_creative: 'One static ad: headline, short sub-header body, cta. Put an offer/badge in kicker if the data supports one. Only use real facts.',
  video: 'Short-form video scenes (each 2-4 seconds). Scene 1 hooks in under 2 seconds. Give each scene a narration line. Last scene is a cta.',
  voiceover_video: 'Narrated video scenes. Each scene: short on-screen headline plus a natural spoken narration sentence. Last scene is a cta.',
  text_to_video: 'Turn the user text into video scenes in order, each with a short on-screen headline and narration taken from the text.',
  ecom_video: 'Product promo video scenes: hook, benefits, price/offer, cta. Narration for each. Only real product facts.',
  avatar_video: 'One scene whose narration is a 20-30 second first-person UGC-style script about the product.',
};

/**
 * Write copy for a post.
 * Returns { title, slides[{kind, headline, body, ...}], caption, hashtags[], writer }.
 */
export async function writePost({ brand, type, prompt, language = 'English', tone, slides, product, article, specialDay, concept }) {
  const meta = POST_TYPES[type] || POST_TYPES.single_image;
  const n = Math.max(1, Math.min(10, slides || meta.slides));
  if (!llmAvailable()) return { ...offlineWrite({ brand, type, prompt, slides: n, product, article, specialDay, concept }), writer: 'offline' };

  const system = `You are a senior social media strategist and copywriter writing on-brand posts. Write in ${language}. Tone: ${tone || brand.tone || 'Friendly'}. On-image text must be short and readable at a glance. Captions use line breaks, 1-3 tasteful emoji at most, and end with a call to action. Never invent facts, prices, statistics or testimonials that are not in the brief; leave stat empty unless the brief supplies a real number.`;
  const parts = [
    brandBrief(brand),
    `Post type: ${meta.label}. ${TYPE_GUIDE[type] || ''}`,
    `Number of slides/scenes: exactly ${n}.`,
    prompt && `Request: ${prompt}`,
    specialDay && `Occasion: ${specialDay}`,
    product && `Product data:\n${JSON.stringify({ title: product.title, description: String(product.description || '').slice(0, 1500), price: product.price, compare_at_price: product.compare_at_price, currency: product.currency, url: product.url })}`,
    concept && `Ad concept to follow: ${JSON.stringify(concept)}`,
    article && `Article "${article.title}":\n${article.text.slice(0, 12000)}`,
  ].filter(Boolean).join('\n\n');
  const { json } = await completeJson({ system, prompt: parts, schema: POST_SCHEMA, feature: 'write_post', effort: 'low' });
  return { ...normalize(json, type, n, brand, product), writer: 'claude' };
}

function normalize(j, type, n, brand, product) {
  const slides = (j.slides || []).slice(0, n);
  const last = slides.length - 1;
  const out = slides.map((s, i) => {
    const base = { headline: s.headline, body: s.body, kicker: s.kicker, cta: s.cta, stat: s.stat, image_query: s.image_query, narration: s.narration };
    if (type === 'quote') return { ...base, kind: 'quote', author: j.quote_author };
    if (type === 'meme') return { ...base, kind: 'meme', top: j.meme_top || s.headline, bottom: j.meme_bottom || s.body };
    if (type === 'ecom_product' || type === 'ecom_carousel' || type === 'ecom_video') {
      if (i === last && slides.length > 1) return { ...base, kind: 'cta' };
      return { ...base, kind: 'product', price: i === 0 && product?.price ? formatPrice(product.price, product.currency) : '' };
    }
    if (type === 'ad_creative') {
      const onSale = product?.compare_at_price && parseFloat(product.compare_at_price) > parseFloat(product.price);
      return { ...base, kind: 'ad', badge: s.kicker || '', kicker: '', price: product?.price ? formatPrice(product.price, product.currency) : '', compareAt: onSale ? formatPrice(product.compare_at_price, product.currency) : '' };
    }
    if (s.stat) return { ...base, kind: 'stat' };
    if (slides.length > 1 && i === last) return { ...base, kind: 'cta' };
    if (i === 0) return { ...base, kind: 'cover' };
    return { ...base, kind: POST_TYPES[type]?.media === 'video' ? 'cover' : 'point' };
  });
  let hashtags = (j.hashtags || []).map((h) => `#${String(h).replace(/^#+/, '').replace(/\s+/g, '')}`).filter((h) => h.length > 2);
  for (const t of String(brand.hashtags || '').split(/[\s,]+/).filter(Boolean)) {
    const tag = `#${t.replace(/^#/, '')}`;
    if (!hashtags.some((h) => h.toLowerCase() === tag.toLowerCase())) hashtags.unshift(tag);
  }
  hashtags = hashtags.slice(0, 20);
  return { title: j.title, slides: out, caption: j.caption, hashtags };
}

// ---------------------------------------------------------------- smaller helpers
export async function boostPrompt(brand, prompt, type) {
  if (!llmAvailable()) {
    const t = topicOf(prompt);
    return `${sentenceCase(prompt.trim())}${/[.!?]$/.test(prompt.trim()) ? '' : '.'} Speak to ${brand.audience || 'our audience'} in a ${String(brand.tone || 'friendly').toLowerCase()} voice, lead with a strong hook about ${t}, give specific, practical value, and end with a clear call to action${brand.cta ? ` (${brand.cta})` : ''}.`;
  }
  const { json } = await completeJson({
    feature: 'boost_prompt',
    system: 'You rewrite short content requests into vivid, specific creative briefs for a social media post generator. Keep the user intent; add angle, audience, hook and specifics. Max 70 words.',
    prompt: `${brandBrief(brand)}\nPost type: ${POST_TYPES[type]?.label || type}\nOriginal request: ${prompt}`,
    schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
  });
  return json.prompt;
}

export async function rewriteCaption(brand, { caption, title, instruction, language = 'English' }) {
  if (!llmAvailable()) {
    const topic = topicOf(title || caption);
    const lines = String(caption).split('\n').filter((l) => l.trim());
    const middle = lines.slice(1, -1);
    const hook = pick(HOOKS, `${caption}:${instruction}:${Date.now()}`)(topic);
    const short = /short|concise|brief/i.test(instruction || '');
    return [hook, ...(short ? middle.slice(0, 1) : middle), lines.at(-1)].filter(Boolean).join('\n\n');
  }
  const { json } = await completeJson({
    feature: 'rewrite_caption',
    system: `You rewrite social media captions. Write in ${language}. Keep facts, keep it on-brand, no hashtags.`,
    prompt: `${brandBrief(brand)}\nInstruction: ${instruction || 'Make it more engaging with a stronger hook.'}\n\nCaption:\n${caption}`,
    schema: { type: 'object', properties: { caption: { type: 'string' } }, required: ['caption'], additionalProperties: false },
  });
  return json.caption;
}

const CONCEPT_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Creative direction name, e.g. "Problem → solution".' },
          visual_direction: { type: 'string' },
          headline: { type: 'string' }, subheader: { type: 'string' }, badge: { type: 'string' }, offer: { type: 'string' },
          cta: { type: 'string' }, disclaimer: { type: 'string' }, accent: { type: 'string' },
        },
        required: ['name', 'visual_direction', 'headline', 'subheader', 'badge', 'offer', 'cta', 'disclaimer', 'accent'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
};

/** Ad concepts for a product (Ads Studio). */
export async function adConcepts(brand, product, count = 4) {
  if (!llmAvailable()) {
    const onSale = product.compare_at_price && parseFloat(product.compare_at_price) > parseFloat(product.price);
    const off = onSale ? Math.round((1 - parseFloat(product.price) / parseFloat(product.compare_at_price)) * 100) : 0;
    const benefit = String(product.description || '').split(/(?<=[.!?])\s+/)[0] || `The ${product.title} you have been waiting for.`;
    const all = [
      { name: 'Benefit-led', visual_direction: 'Product hero on brand gradient', headline: `${product.title}`, subheader: benefit.slice(0, 90), badge: off ? `${off}% off` : '', offer: '', cta: 'Shop now', disclaimer: '', accent: '' },
      { name: 'Offer-first', visual_direction: 'Bold price callout', headline: off ? `Save ${off}% today` : 'Treat yourself today', subheader: `${product.title}, now ${formatPrice(product.price, product.currency)}`, badge: off ? 'Sale' : 'New', offer: off ? `${off}% off` : '', cta: 'Claim offer', disclaimer: off ? 'While stocks last.' : '', accent: '' },
      { name: 'Problem → solution', visual_direction: 'Minimal layout, product as the answer', headline: `Tired of settling for less?`, subheader: `Meet ${product.title}.`, badge: '', offer: '', cta: 'Learn more', disclaimer: '', accent: '' },
      { name: 'Social proof', visual_direction: 'Editorial style with quote marks', headline: `Why everyone is talking about ${product.title}`, subheader: benefit.slice(0, 90), badge: 'Bestseller', offer: '', cta: 'See why', disclaimer: '', accent: '' },
      { name: 'Urgency', visual_direction: 'High-contrast neon', headline: 'Selling fast', subheader: `Get ${product.title} before it is gone.`, badge: 'Limited', offer: '', cta: 'Buy now', disclaimer: '', accent: '' },
    ];
    return all.slice(0, count);
  }
  const { json } = await completeJson({
    feature: 'ad_concepts',
    system: 'You are a performance-marketing creative strategist. Produce distinct static-ad concepts. Use only facts in the product data; leave badge, offer and disclaimer empty when the data does not support them. Headlines max 8 words, CTAs max 3 words.',
    prompt: `${brandBrief(brand)}\nProduct data: ${JSON.stringify({ title: product.title, description: String(product.description || '').slice(0, 1500), price: product.price, compare_at_price: product.compare_at_price, currency: product.currency })}\nReturn exactly ${count} concepts.`,
    schema: CONCEPT_SCHEMA,
  });
  return json.concepts.slice(0, count);
}

/** A list of post topics for autopilot. */
export async function planTopics(brand, { direction, count, products = [] }) {
  if (!llmAvailable()) {
    const seeds = String(direction || '').split(/[,;\n]+|\band\b/).map((x) => x.trim()).filter((x) => x.length > 2);
    const about = brand.industry || keywords(brand.description, 2).join(' ') || brand.name;
    const angles = ['Beginner tips for', 'Behind the scenes:', 'Common myths about', 'How to choose the right', 'Customer story:', 'A quick win with', 'Your questions about', 'What’s new in', 'Mistakes to avoid with', 'Our favorite things about'];
    return Array.from({ length: count }, (_, i) => {
      const p = products.length ? products[i % products.length] : null;
      if (p && i % 2 === 0) return `Spotlight on ${p.title}`;
      // Alternate the user's own directions with fresh angles on the brand's subject.
      if (seeds.length && i % 2 === 0) return sentenceCase(seeds[(i / 2) % seeds.length]);
      return `${angles[i % angles.length]} ${about}`;
    });
  }
  const { json } = await completeJson({
    feature: 'plan_topics',
    system: 'You plan social media content calendars. Topics must be varied, specific and on-brand. Each topic is one sentence a copywriter can turn into a post.',
    prompt: `${brandBrief(brand)}\nContent direction: ${direction || 'mix of education, product and community'}\n${products.length ? `Products: ${products.slice(0, 20).map((p) => p.title).join('; ')}\n` : ''}Return exactly ${count} topics.`,
    schema: { type: 'object', properties: { topics: { type: 'array', items: { type: 'string' } } }, required: ['topics'], additionalProperties: false },
  });
  return json.topics.slice(0, count);
}

/** Theme a set of posts for competitor analysis. Returns [{ theme, indexes[] }]. */
export async function themePosts(posts) {
  if (!posts.length) return [];
  if (!llmAvailable()) {
    const groups = new Map();
    posts.forEach((p, i) => {
      const k = keywords(p.caption, 1)[0] || (p.media_type || 'other').toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const top = sorted.slice(0, 7).map(([k, idx]) => ({ theme: titleCase(k), indexes: idx }));
    const rest = sorted.slice(7).flatMap(([, idx]) => idx);
    if (rest.length) top.push({ theme: 'Other', indexes: rest });
    return top;
  }
  const { json } = await completeJson({
    feature: 'competitor_themes',
    system: 'Group social media posts into 4-8 content themes (e.g. "Product launches", "Customer stories", "Tips & education"). Every post index must appear in exactly one theme.',
    prompt: posts.map((p, i) => `[${i}] (${p.media_type}) ${String(p.caption || '').slice(0, 300).replace(/\s+/g, ' ')}`).join('\n'),
    schema: { type: 'object', properties: { themes: { type: 'array', items: { type: 'object', properties: { theme: { type: 'string' }, indexes: { type: 'array', items: { type: 'integer' } } }, required: ['theme', 'indexes'], additionalProperties: false } } }, required: ['themes'], additionalProperties: false },
  });
  return json.themes;
}
