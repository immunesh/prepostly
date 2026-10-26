import { AsyncLocalStorage } from 'node:async_hooks';
import { run, uuid } from './db.js';
import { config } from './config.js';

// Records what each paid API call cost, for the admin dashboard. Requests and background jobs
// carry a meter (the paying account, the brand, and the credit charge the work belongs to);
// the Claude, HeyGen and OpenAI wrappers read it when they log a call.

const store = new AsyncLocalStorage();

/** Express middleware: a fresh meter per request, so nothing leaks between keep-alive requests. */
export const meterRequests = (_req, _res, next) => store.run({}, next);

/** Add fields to the current request's meter (called once its brand is known). */
export function setMeter(fields) {
  const m = store.getStore();
  if (m) Object.assign(m, fields);
}

/** Run fn with a meter of its own (background jobs), on top of the current fields. */
export const withMeter = (fields, fn) => store.run({ ...store.getStore(), ...fields }, fn);

export const currentMeter = () => store.getStore() || {};

// ---------------------------------------------------------------- prices
// Anthropic list prices in USD per million tokens [input, output], as of October 2026.
// Cache reads bill at 10% of input and cache writes at 125%. The longest matching prefix wins.
export const CLAUDE_PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-mythos-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};
// Haiku 5.5 prompts over 100K tokens bill at the long-context rate.
const HAIKU_LONG = { from: 100_000, price: [0.5, 2.5] };
// OpenAI gpt-image-1 USD per million tokens, and a fallback when a response reports no usage.
export const OPENAI_IMAGE_PRICES = { text_input: 5, image_input: 10, image_output: 40 };
const IMAGE_FALLBACK_USD = 0.25;
// Cloudflare Workers AI list prices for FLUX.1 [schnell]: USD per 512x512 tile and per diffusion step.
export const CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const FLUX_SCHNELL = { tile: 0.0000528, step: 0.0001056 };

export function claudePrice(model = '') {
  const key = Object.keys(CLAUDE_PRICES).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  // Unknown models are priced like the configured writer, or Opus when that is unknown too.
  return key ? CLAUDE_PRICES[key] : model === config.anthropicModel ? CLAUDE_PRICES['claude-opus-5-5'] : claudePrice(config.anthropicModel);
}

export function claudeCost(model, u) {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const [i, o] = model.startsWith('claude-haiku-5-5') && prompt > HAIKU_LONG.from ? HAIKU_LONG.price : claudePrice(model);
  return (u.input * i + u.cacheWrite * i * 1.25 + u.cacheRead * i * 0.1 + u.output * o) / 1e6;
}

export const heygenCost = (seconds) => (seconds / 60) * config.heygenUsdPerMinute;

export function openaiImageCost(usage) {
  if (config.openaiImageUsd != null && Number.isFinite(config.openaiImageUsd)) return config.openaiImageUsd;
  if (!usage) return IMAGE_FALLBACK_USD;
  const d = usage.input_tokens_details || {};
  const text = d.text_tokens ?? usage.input_tokens ?? 0;
  const p = OPENAI_IMAGE_PRICES;
  return (text * p.text_input + (d.image_tokens || 0) * p.image_input + (usage.output_tokens || 0) * p.image_output) / 1e6;
}

/** List price of one 1024x1024 FLUX.1 [schnell] image (the daily free allocation is not subtracted). */
export function cloudflareImageCost(steps = 4) {
  if (config.cloudflareImageUsd != null && Number.isFinite(config.cloudflareImageUsd)) return config.cloudflareImageUsd;
  return 4 * FLUX_SCHNELL.tile + steps * FLUX_SCHNELL.step;
}

/** Prices the admin dashboard shows next to its cost reports. */
export function priceList() {
  return {
    claude: Object.entries(CLAUDE_PRICES).map(([model, [input, output]]) => ({ model, input, output })),
    writer: config.anthropicModel,
    heygen_per_minute: config.heygenUsdPerMinute,
    openai_image: config.openaiImageUsd ?? null,
    openai_image_model: config.openaiImageModel,
    openai_image_tokens: OPENAI_IMAGE_PRICES,
    cloudflare_image_model: CLOUDFLARE_IMAGE_MODEL,
    cloudflare_image: cloudflareImageCost(),
  };
}

// ---------------------------------------------------------------- logging
/** Record one paid API call. Never throws: a failed log must not fail the user's request. */
export function logApiUsage({ provider, model = '', feature, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, units = 0, cost = 0, ...fields }) {
  const m = { ...currentMeter(), ...fields };
  try {
    run(
      `INSERT INTO api_usage (id, user_id, brand_id, provider, model, feature, job, ref, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, units, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(), m.userId || null, m.brandId || null, provider, model, feature, m.job || null, m.ref || null, input, output, cacheRead, cacheWrite, units, cost,
    );
  } catch (e) {
    console.error('[usage] could not record API usage:', e.message);
  }
}
