import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { HttpError } from '../auth.js';
import { logApiUsage, claudeCost } from '../usage.js';

// Claude access for copywriting, analysis and the Idea Lab chat. When no Anthropic
// credentials are configured, callers fall back to the built-in offline writer.

let client = null;
const anthropic = () => (client ||= new Anthropic());

export const llmAvailable = () => config.anthropicConfigured;
export const writerName = () => (llmAvailable() ? config.anthropicModel : 'offline');

// Server-side refusal fallbacks route a declined request to another model in the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const SUPPORTS_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5)/;

function withFallback(params) {
  return SUPPORTS_FALLBACK.test(params.model) ? { ...params, ...FALLBACK } : params;
}

/** Log a finished call's tokens and cost. Returns { input, output } for callers. */
function meter(feature, message, fields) {
  const u = message.usage || {};
  const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
  logApiUsage({ provider: 'anthropic', model: message.model, feature, ...usage, cost: claudeCost(message.model || '', usage), ...fields });
  return { input: usage.input, output: usage.output };
}

/**
 * One request that returns JSON matching `schema` (structured outputs).
 * `feature` names the call in the admin usage reports.
 */
export async function completeJson({ system, prompt, schema, feature = 'other', effort = 'low', maxTokens = 16000, images = [], signal }) {
  if (!llmAvailable()) throw new HttpError(503, 'No language model is configured.');
  const content = [
    ...images.map((img) => ({ type: 'image', source: img.url ? { type: 'url', url: img.url } : { type: 'base64', media_type: img.mime, data: img.data } })),
    { type: 'text', text: prompt },
  ];
  const params = withFallback({
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  const create = SUPPORTS_FALLBACK.test(params.model) ? anthropic().beta.messages : anthropic().messages;
  let response;
  try {
    response = await create.create(params, { signal });
  } catch (e) {
    throw describeApiError(e);
  }
  const usage = meter(feature, response);
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The model declined this request. Try rephrasing your prompt.');
  if (response.stop_reason === 'max_tokens') throw new HttpError(502, 'The model response was cut off. Try a shorter request.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { json: JSON.parse(text), usage, model: response.model };
}

/**
 * Stream a chat reply. Yields { type: 'text', text } deltas, then
 * { type: 'done', text, usage }.
 */
export async function* streamChat({ system, messages, feature = 'chat', meterFields, effort = 'low', maxTokens = 16000, signal }) {
  if (!llmAvailable()) throw new HttpError(503, 'No language model is configured.');
  const params = withFallback({ model: config.anthropicModel, max_tokens: maxTokens, system, output_config: { effort }, messages });
  const api = SUPPORTS_FALLBACK.test(params.model) ? anthropic().beta.messages : anthropic().messages;
  let stream;
  try {
    stream = api.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text };
    }
  } catch (e) {
    throw describeApiError(e);
  }
  const message = await stream.finalMessage();
  const usage = meter(feature, message, meterFields);
  if (message.stop_reason === 'refusal') {
    const text = "I can't help with that one. Try asking a different way.";
    yield { type: 'text', text };
    yield { type: 'done', text, usage };
    return;
  }
  yield { type: 'done', text: message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), usage };
}

function describeApiError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new HttpError(502, 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
  if (e instanceof Anthropic.RateLimitError) return new HttpError(503, 'The AI writer is busy (rate limited). Try again in a minute.');
  if (e instanceof Anthropic.BadRequestError) return new HttpError(502, `The AI request was rejected: ${e.message}`);
  if (e instanceof Anthropic.APIError) return new HttpError(502, `The AI service returned an error (${e.status}).`);
  if (e?.name === 'AbortError') return e;
  return new HttpError(502, `Could not reach the AI service: ${e.message}`);
}
