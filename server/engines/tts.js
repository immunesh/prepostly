import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { VOICES } from '../catalog.js';

// On-device voiceover with Kokoro-82M (ONNX, CPU). The model (~90 MB) downloads on first
// use. Kokoro is an optional dependency: when it is missing or VOICEOVER=off, videos are
// rendered without narration.

export const SAMPLE_RATE = 24000;
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let loading = null;
let queue = Promise.resolve();
export const ttsStatus = { state: config.voiceoverEnabled ? 'idle' : 'disabled', error: null };

async function load() {
  if (!config.voiceoverEnabled) throw new Error('Voiceover is disabled (VOICEOVER=off).');
  if (!loading) {
    ttsStatus.state = 'loading';
    loading = (async () => {
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(config.dataDir, 'models');
      const { KokoroTTS } = await import('kokoro-js');
      const tts = await KokoroTTS.from_pretrained(REPO, { dtype: 'q8', device: 'cpu' });
      ttsStatus.state = 'ready';
      return tts;
    })().catch((e) => {
      loading = null;
      ttsStatus.state = 'error';
      ttsStatus.error = e.message;
      throw e;
    });
  }
  return loading;
}

/** Synthesize text to a Float32Array at 24 kHz (one inference at a time). */
export async function synthesize(text, voice = 'af_heart') {
  const v = VOICES[voice] ? voice : 'af_heart';
  const tts = await load();
  const job = queue.then(() => tts.generate(String(text).slice(0, 1200), { voice: v }));
  queue = job.catch(() => {});
  return (await job).audio;
}

/** Write mono 16-bit PCM WAV. */
export function writeWav(file, samples, rate = SAMPLE_RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
