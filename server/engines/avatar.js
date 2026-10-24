import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { safeFetch } from '../net.js';
import { logApiUsage, heygenCost } from '../usage.js';

// UGC avatar videos through HeyGen: send the script with an avatar and a voice, poll until
// the render finishes, then download the MP4 (and its thumbnail) into the post's media folder.

const API = 'https://api.heygen.com';

export const avatarAvailable = () => Boolean(config.heygenKey);

async function heygen(pathname, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'x-api-key': config.heygenKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  }).catch((e) => { throw new Error(`Could not reach HeyGen: ${e.cause?.code || e.message}`); });
  const j = await r.json().catch(() => ({}));
  const err = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : '');
  if (r.status === 401 || r.status === 403) throw new Error('HeyGen rejected the API key. Check HEYGEN_API_KEY.');
  if (!r.ok) throw new Error(`HeyGen: ${err || `request failed (${r.status})`}`);
  return j.data ?? {};
}

/** Avatar and voice to use: the configured IDs, else the first avatar and a voice in the post's language. */
export async function pickPresenter(language = 'English') {
  let avatar = config.heygenAvatarId ? { avatar_id: config.heygenAvatarId } : null;
  if (!avatar) {
    avatar = (await heygen('/v2/avatars')).avatars?.[0];
    if (!avatar) throw new Error('Your HeyGen account has no avatars. Set HEYGEN_AVATAR_ID.');
  }
  if (config.heygenVoiceId) return { avatar_id: avatar.avatar_id, voice_id: config.heygenVoiceId };
  const voices = (await heygen('/v2/voices')).voices || [];
  const lang = voices.filter((v) => String(v.language || '').toLowerCase().startsWith(language.toLowerCase()));
  const pool = lang.length ? lang : voices;
  const voice = pool.find((v) => avatar.gender && String(v.gender).toLowerCase() === String(avatar.gender).toLowerCase()) || pool[0];
  if (!voice) throw new Error('Your HeyGen account has no voices. Set HEYGEN_VOICE_ID.');
  return { avatar_id: avatar.avatar_id, voice_id: voice.voice_id };
}

/** Start a render. Returns HeyGen's video id. */
export async function startAvatarVideo({ script, w, h, background, language }) {
  const text = String(script || '').trim();
  if (!text) throw new Error('The avatar video has no script.');
  const { avatar_id, voice_id } = await pickPresenter(language);
  const data = await heygen('/v2/video/generate', {
    method: 'POST',
    body: {
      video_inputs: [{
        character: { type: 'avatar', avatar_id, avatar_style: 'normal' },
        voice: { type: 'text', input_text: text.slice(0, 5000), voice_id },
        ...(background ? { background: { type: 'color', value: background } } : {}),
      }],
      dimension: { width: w, height: h },
    },
  });
  if (!data.video_id) throw new Error('HeyGen did not return a video id.');
  return data.video_id;
}

/** Poll until the render finishes. Returns { video_url, thumbnail_url, duration }. */
export async function waitForAvatarVideo(videoId, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const d = await heygen(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`);
    if (d.status === 'completed' && d.video_url) return d;
    if (d.status === 'failed') throw new Error(`HeyGen could not render the video: ${d.error?.message || d.error?.detail || d.error || 'unknown error'}`);
    await new Promise((r) => setTimeout(r, config.heygenPollMs));
  }
  throw new Error('HeyGen took more than 30 minutes. Retry the post later.');
}

/**
 * Render (or resume) the avatar video for a post into `dir` as avatar-src.mp4.
 * The HeyGen job id is saved first, so a restart mid-render resumes instead of paying twice.
 * Returns { video, thumb, duration }: absolute file paths (thumb may be null) and seconds.
 */
export async function renderAvatarVideo({ dir, script, w, h, background, language }) {
  const job = path.join(dir, 'avatar.json');
  let videoId = fs.existsSync(job) ? JSON.parse(fs.readFileSync(job, 'utf8')).video_id : null;
  if (!videoId) {
    videoId = await startAvatarVideo({ script, w, h, background, language });
    fs.writeFileSync(job, JSON.stringify({ video_id: videoId }));
  }
  let d;
  try {
    d = await waitForAvatarVideo(videoId);
  } catch (e) {
    if (/could not render/.test(e.message)) fs.rmSync(job, { force: true });
    throw e;
  }
  const video = path.join(dir, 'avatar-src.mp4');
  fs.writeFileSync(video, (await safeFetch(d.video_url, { accept: 'video/*', maxBytes: 500 * 1024 * 1024, timeoutMs: 5 * 60 * 1000 })).buffer);
  fs.rmSync(job, { force: true });
  // HeyGen bills by rendered minutes; logged once the video is safely downloaded.
  const seconds = Number(d.duration) || 0;
  logApiUsage({ provider: 'heygen', model: 'avatar_video', feature: 'avatar_video', units: seconds, cost: heygenCost(seconds) });
  let thumb = null;
  if (d.thumbnail_url) {
    const t = await safeFetch(d.thumbnail_url, { accept: 'image/*', maxBytes: 15 * 1024 * 1024 }).catch(() => null);
    if (t?.status === 200) fs.writeFileSync((thumb = path.join(dir, 'avatar-thumb.jpg')), t.buffer);
  }
  return { video, thumb, duration: Number(d.duration) || null };
}
