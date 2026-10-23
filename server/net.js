import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { HttpError } from './auth.js';

// Fetching user-supplied URLs (websites, stores, articles, images). Private and loopback
// addresses are refused so the server can't be used to reach internal services.

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivate(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Enter a URL.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new HttpError(400, 'Only http and https URLs are supported.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, `"${input}" is not a valid URL.`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http and https URLs are supported.');
  return u;
}

async function assertPublic(u) {
  if (config.allowPrivateFetch) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, `Could not resolve ${u.hostname}.`);
  if (addrs.some(isPrivate)) throw new HttpError(400, `${u.hostname} points to a private network address.`);
}

const UA = 'Mozilla/5.0 (compatible; PrepostlyBot/1.0)';

/**
 * Fetch a public URL with a timeout, a size cap and manual redirect checks.
 * Returns { url, status, headers, buffer }.
 */
export async function safeFetch(input, { maxBytes = 8 * 1024 * 1024, timeoutMs = 15000, accept = '*/*', headers = {} } = {}) {
  let u = input instanceof URL ? input : normalizeUrl(input);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(u);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept, ...headers } }).catch((e) => {
      throw new HttpError(502, `Could not reach ${u.hostname}: ${e.cause?.code || e.message}`);
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = new URL(res.headers.get('location'), u);
      continue;
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new HttpError(413, `${u.hostname} returned a file larger than ${Math.round(maxBytes / 1048576)} MB.`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body || []) {
      total += chunk.length;
      if (total > maxBytes) throw new HttpError(413, `${u.hostname} returned more than ${Math.round(maxBytes / 1048576)} MB.`);
      chunks.push(chunk);
    }
    return { url: u.toString(), status: res.status, headers: res.headers, buffer: Buffer.concat(chunks) };
  }
  throw new HttpError(502, 'Too many redirects.');
}

export async function fetchText(url, opts) {
  const r = await safeFetch(url, { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', ...opts });
  return { ...r, text: r.buffer.toString('utf8') };
}

export async function fetchJson(url, opts) {
  const r = await safeFetch(url, { accept: 'application/json', ...opts });
  if (r.status >= 400) throw new HttpError(502, `${new URL(r.url).hostname} returned ${r.status}.`);
  try {
    return JSON.parse(r.buffer.toString('utf8'));
  } catch {
    throw new HttpError(502, `${new URL(r.url).hostname} did not return JSON.`);
  }
}
