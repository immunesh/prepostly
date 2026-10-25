// Background music for slide videos, synthesized on the server: original, royalty-free and
// different for every post (the post id seeds the key and the melody). Mono Float32 samples.

const MOODS = {
  // Chords are semitone offsets from the key root; one chord per bar of four beats.
  upbeat: { bpm: 112, chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], arp: true, kick: 'every', hats: true, pad: 0.12 },
  calm: { bpm: 72, chords: [[0, 4, 7, 11], [5, 9, 12, 16], [9, 12, 16, 19], [7, 11, 14, 17]], arp: true, kick: null, hats: false, pad: 0.16 },
  cinematic: { bpm: 84, chords: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]], arp: false, kick: 'half', hats: false, pad: 0.2 },
};
export const MUSIC_MOODS = Object.keys(MOODS);

function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** `seconds` of music in `mood` at `rate` Hz, peaking at about -6 dB with a fade in and out. */
export function composeMusic({ seconds, mood = 'upbeat', seed = '', rate = 24000 }) {
  const m = MOODS[mood];
  if (!m) throw new Error(`Unknown music mood "${mood}".`);
  const rand = rng(seed);
  const n = Math.max(1, Math.ceil(seconds * rate));
  const out = new Float32Array(n);
  const root = [57, 60, 62, 55, 58][Math.floor(rand() * 5)];
  const beat = 60 / m.bpm;
  const bar = beat * 4;
  const order = rand() < 0.5 ? [0, 1, 2, 3] : [0, 2, 3, 1];
  const pattern = [0, 1, 2, 1, 2, 3, 2, 1].map((i) => (rand() < 0.2 ? (i + 1) % 4 : i));
  // Each note is added once with its own envelope, so the cost stays small for any length.
  const note = (start, dur, freq, gain, { attack = 0.01, decay = dur, bright = 0.3 } = {}) => {
    const a = Math.floor(start * rate);
    const len = Math.min(n - a, Math.floor((dur + 0.4) * rate));
    for (let k = 0; k < len; k++) {
      const t = k / rate;
      const env = Math.min(1, t / attack) * (t < dur ? Math.exp(-t / decay) : Math.exp(-dur / decay) * Math.max(0, 1 - (t - dur) / 0.4));
      const ph = 2 * Math.PI * freq * t;
      out[a + k] += gain * env * (Math.sin(ph) + bright * Math.sin(2 * ph) + bright * 0.4 * Math.sin(3 * ph));
    }
  };
  for (let b = 0; b * bar < seconds; b++) {
    const chord = m.chords[order[b % 4]];
    const t0 = b * bar;
    for (const semi of chord) note(t0, bar, hz(root + semi), m.pad / chord.length, { attack: 0.35, decay: bar * 3, bright: 0.15 });
    note(t0, beat * 1.8, hz(root - 24 + chord[0]), 0.16, { decay: beat * 1.2, bright: 0.5 });
    note(t0 + beat * 2, beat * 1.8, hz(root - 24 + chord[0]), 0.13, { decay: beat * 1.2, bright: 0.5 });
    if (m.arp) {
      pattern.forEach((i, s) => {
        const semi = chord[i % chord.length] + (i >= chord.length ? 12 : 0);
        note(t0 + (s * beat) / 2, beat / 2, hz(root + 12 + semi), mood === 'calm' ? 0.05 : 0.065, { decay: beat / 3, bright: 0.2 });
      });
    }
    for (let q = 0; q < 4; q++) {
      const tb = t0 + q * beat;
      if (m.kick === 'every' || (m.kick === 'half' && q % 2 === 0)) {
        const a = Math.floor(tb * rate);
        for (let k = 0; k < Math.min(n - a, rate * 0.3); k++) {
          const t = k / rate;
          out[a + k] += 0.35 * Math.exp(-t / 0.09) * Math.sin(2 * Math.PI * (45 * t + (75 * 0.04) * (1 - Math.exp(-t / 0.04))));
        }
      }
      if (m.hats) {
        const a = Math.floor((tb + beat / 2) * rate);
        let prev = 0;
        for (let k = 0; k < Math.min(n - a, rate * 0.05); k++) {
          const w = rand() * 2 - 1;
          out[a + k] += 0.05 * Math.exp(-k / rate / 0.015) * (w - prev);
          prev = w;
        }
      }
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs((out[i] = Math.tanh(out[i]))));
  const fadeIn = rate * 0.6;
  const fadeOut = rate * Math.min(1.8, seconds / 3);
  const scale = peak ? 0.5 / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= scale * Math.min(1, i / fadeIn, (n - i) / fadeOut);
  return out;
}
