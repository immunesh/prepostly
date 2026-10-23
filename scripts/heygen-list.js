// List the avatars and voices on your HeyGen account, to pick HEYGEN_AVATAR_ID and HEYGEN_VOICE_ID.
import { config } from '../server/config.js';

if (!config.heygenKey) {
  console.error('Set HEYGEN_API_KEY in .env first.');
  process.exit(1);
}
const get = async (p) => {
  const r = await fetch(`https://api.heygen.com${p}`, { headers: { 'x-api-key': config.heygenKey, accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HeyGen ${p}: ${j.error?.message || j.message || r.status}`);
  return j.data || {};
};
const lang = (process.argv[2] || '').toLowerCase();

const { avatars = [] } = await get('/v2/avatars');
console.log(`\nAvatars (${avatars.length}) — HEYGEN_AVATAR_ID`);
for (const a of avatars) console.log(`  ${a.avatar_id.padEnd(40)} ${a.avatar_name || ''}${a.gender ? ` (${a.gender})` : ''}`);

const { voices = [] } = await get('/v2/voices');
const shown = lang ? voices.filter((v) => String(v.language || '').toLowerCase().startsWith(lang)) : voices;
console.log(`\nVoices (${shown.length}${lang ? ` in ${process.argv[2]}` : ''}) — HEYGEN_VOICE_ID`);
for (const v of shown) console.log(`  ${v.voice_id.padEnd(40)} ${v.name || ''} · ${v.language || '?'}${v.gender ? ` · ${v.gender}` : ''}`);
if (!lang) console.log('\nTip: `npm run heygen -- English` shows only voices in one language.');
