// Thin fetch wrapper for the Prepostly API. The active brand travels in X-Brand-Id.

let brandId = null;
export const setBrandId = (id) => { brandId = id; };

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  const h = { ...headers };
  if (brandId) h['x-brand-id'] = brandId;
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers: h, body: payload, credentials: 'same-origin', signal });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code);
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

/** Upload a File to the brand's library. */
export function upload(file) {
  return api('/api/uploads', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': file.name } });
}

/** Stream Server-Sent Events from a POST endpoint. onEvent(name, data). */
export async function streamPost(path, body, onEvent, signal) {
  const res = await api(path, { method: 'POST', body, raw: true, signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Request failed', data.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}

// ---------------------------------------------------------------- formatting
export const fmtDate = (iso, opts = {}) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts }) : '');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const fmtNum = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString());
export const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
/** Value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const PLATFORM_ICON = { facebook: '📘', instagram: '📸', threads: '🧵', linkedin: '💼', linkedin_page: '🏢', x: '𝕏', pinterest: '📌', youtube: '▶️', tiktok: '🎵', google_business: '🏪', bluesky: '🦋', mastodon: '🐘', telegram: '✈️', sandbox: '🧪' };
export const TYPE_ICON = { single_image: '🖼️', carousel: '🎠', quote: '💬', meme: '😂', special_day: '🎉', blog_to_carousel: '📰', ecom_product: '🛍️', ecom_carousel: '🛒', ad_creative: '📣', video: '🎬', voiceover_video: '🎙️', text_to_video: '📝', ecom_video: '📦', avatar_video: '🧑‍💼' };
export const STATUS_BADGE = { scheduled: 'info', published: 'ok', failed: 'err', partial: 'warn', in_review: 'brand', rejected: 'err', draft: '', publishing: 'info', discarded: '', ready: 'ok', generating: 'info' };
export const STATUS_LABEL = { scheduled: 'Scheduled', published: 'Published', failed: 'Failed', partial: 'Partly published', in_review: 'In review', rejected: 'Rejected', draft: 'Draft', publishing: 'Publishing', discarded: 'Discarded', ready: 'Ready', generating: 'Generating' };
