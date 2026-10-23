import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

// Turns rendered scene frames into an MP4: slow Ken Burns zoom on each scene, crossfades
// between scenes, an optional narration track, H.264/AAC with faststart for social upload.

export const FPS = 30;
export const XFADE = 0.4;

/** Start time (seconds) of each scene once crossfades overlap them. */
export function sceneStarts(durations, transition = XFADE) {
  const starts = [];
  let t = 0;
  durations.forEach((d, i) => {
    starts.push(t);
    t += d - (i < durations.length - 1 ? transition : 0);
  });
  return { starts, total: t };
}

export function runFfmpeg(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Video rendering timed out.')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

/**
 * scenes: [{ image: '/abs/frame.png', duration: seconds }]
 * Writes `out` (mp4). audio: optional path to a WAV narration track aligned to sceneStarts.
 */
export async function composeVideo({ scenes, w, h, out, audio = null, transition = XFADE }) {
  if (!scenes.length) throw new Error('A video needs at least one scene.');
  const args = [];
  for (const s of scenes) args.push('-loop', '1', '-framerate', String(FPS), '-t', s.duration.toFixed(3), '-i', s.image);
  const audioIndex = scenes.length;
  if (audio) args.push('-i', audio);
  else args.push('-f', 'lavfi', '-t', '1', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  const filters = [];
  scenes.forEach((s, i) => {
    const frames = Math.round(s.duration * FPS);
    // Alternate zoom-in and zoom-out so consecutive scenes don't feel identical.
    const zoom = i % 2 === 0 ? `min(1+0.06*on/${frames},1.06)` : `max(1.06-0.06*on/${frames},1)`;
    filters.push(`[${i}:v]scale=${w * 2}:${h * 2},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${FPS},setsar=1,format=yuv420p[v${i}]`);
  });
  let last = 'v0';
  let offset = 0;
  for (let i = 1; i < scenes.length; i++) {
    offset += scenes[i - 1].duration - transition;
    const label = `x${i}`;
    filters.push(`[${last}][v${i}]xfade=transition=${['fade', 'slideleft', 'smoothup', 'circleopen'][i % 4]}:duration=${transition}:offset=${offset.toFixed(3)}[${label}]`);
    last = label;
  }
  const { total } = sceneStarts(scenes.map((s) => s.duration), transition);
  filters.push(`[${audioIndex}:a]aresample=44100,apad,atrim=0:${total.toFixed(3)}[a]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${last}]`, '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-t', total.toFixed(3), '-movflags', '+faststart', out,
  );
  await runFfmpeg(args);
  return { duration: total };
}

/**
 * Fit an existing clip (e.g. a HeyGen render) to w×h, optionally overlaying a full-frame
 * transparent PNG (the trial watermark), and re-encode for social upload.
 */
export async function fitVideo({ src, out, w, h, overlay = null }) {
  const fit = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;
  const args = ['-i', src];
  if (overlay) args.push('-i', overlay);
  args.push(
    '-filter_complex', overlay ? `${fit}[b];[b][1:v]overlay=0:0,format=yuv420p[v]` : `${fit},format=yuv420p[v]`,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', out,
  );
  await runFfmpeg(args);
}

/** Read duration (seconds) of a media file using ffmpeg's probe output. */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
  });
}

/** Extract a still from a video (used for uploaded clips' thumbnails). */
export async function extractFrame(video, out, at = 0.5) {
  await runFfmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', out]);
}
