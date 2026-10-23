import { Router } from 'express';
import { one, all, json } from '../db.js';
import { baseUrl } from '../config.js';
import { HttpError, userFromApiKey } from '../auth.js';
import { POST_TYPES, FORMATS, TEMPLATES } from '../catalog.js';
import { createPost, getPost, onPostUpdate } from '../generate.js';
import { publicAccount } from '../publishers/index.js';

// Model Context Protocol server (Streamable HTTP, JSON responses) so Claude or ChatGPT can
// create and schedule posts. Authenticate with a Prepostly API key as a Bearer token.

export const router = Router();
const PROTOCOL = '2025-06-18';

const TOOLS = [
  { name: 'brand_info', description: 'Get the brand this API key belongs to: name, description, colors, tone and connected channels.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_post_types', description: 'List the post types, formats and visual templates Prepostly can generate.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'create_post',
    description: 'Generate a social media post (image, carousel, video, meme, quote, ad…) in the brand style. Waits until rendering finishes and returns media URLs, caption and hashtags.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.keys(POST_TYPES).filter((t) => t !== 'avatar_video') },
        prompt: { type: 'string', description: 'What the post is about.' },
        format: { type: 'string', enum: Object.keys(FORMATS) },
        template: { type: 'string', enum: ['auto', ...Object.keys(TEMPLATES)] },
        slides: { type: 'integer', minimum: 1, maximum: 10 },
        language: { type: 'string' },
      },
      required: ['type', 'prompt'],
      additionalProperties: false,
    },
  },
  { name: 'get_post', description: 'Get a post by id, including status, media URLs and caption.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'list_posts', description: 'List the most recent posts in the content library.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } },
];

function postSummary(p, base) {
  return { id: p.id, status: p.status, type: p.type, format: p.format, title: p.title, caption: p.caption, hashtags: p.hashtags, error: p.error, media: p.media.filter((m) => m.kind !== 'frame').map((m) => ({ kind: m.kind, url: `${base}${m.url}` })), edit_url: `${base}/app/posts/${p.id}` };
}

function waitForPost(id, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const done = (p) => {
      if (p.id !== id || p.status === 'generating') return;
      clearTimeout(timer);
      off();
      resolve(p);
    };
    const off = onPostUpdate(done);
    const timer = setTimeout(() => { off(); resolve(getPost(id)); }, timeoutMs);
    const now = getPost(id);
    if (now.status !== 'generating') done(now);
  });
}

async function callTool(name, args, ctx) {
  const { brand, user, base } = ctx;
  switch (name) {
    case 'brand_info':
      return { name: brand.name, website: brand.website, industry: brand.industry, description: brand.description, tone: brand.tone, colors: json(brand.colors, []), channels: all('SELECT * FROM social_accounts WHERE brand_id = ?', brand.id).map(publicAccount) };
    case 'list_post_types':
      return { post_types: Object.fromEntries(Object.entries(POST_TYPES).map(([k, v]) => [k, v.description])), formats: Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, `${v.label}: ${v.uses.join(', ')}`])), templates: Object.keys(TEMPLATES) };
    case 'create_post': {
      const post = createPost({ brand, user, input: args });
      return postSummary(await waitForPost(post.id), base);
    }
    case 'get_post': {
      const p = getPost(args.id);
      if (!p || p.brand_id !== brand.id) throw new HttpError(404, 'Post not found.');
      return postSummary(p, base);
    }
    case 'list_posts':
      return all('SELECT id FROM posts WHERE brand_id = ? ORDER BY created_at DESC LIMIT ?', brand.id, args.limit || 10).map((r) => postSummary(getPost(r.id), base));
    default:
      throw new HttpError(400, `Unknown tool "${name}".`);
  }
}

router.get('/mcp', (_req, res) => res.status(405).set('allow', 'POST').json({ error: 'Use POST with JSON-RPC messages.' }));

router.post('/mcp', async (req, res) => {
  const auth = userFromApiKey(req);
  if (!auth) return res.status(401).set('www-authenticate', 'Bearer').json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Send a Prepostly API key as a Bearer token.' } });
  const brand = one('SELECT * FROM brands WHERE id = ?', auth.brandId);
  const ctx = { brand, user: auth.user, base: baseUrl(req) };
  const handle = async (msg) => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (msg.id === undefined) return null; // notification
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'prepostly', version: '1.0.0' }, instructions: `Creates on-brand social posts for ${brand.name}. Use create_post, then share the returned media URLs or edit_url.` });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        try {
          const result = await callTool(msg.params?.name, msg.params?.arguments || {}, ctx);
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };
  const body = req.body;
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = await handle(body);
  if (!out) return res.status(202).end();
  res.set('mcp-protocol-version', PROTOCOL).json(out);
});
