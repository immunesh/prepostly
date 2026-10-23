// Download the creative fonts as static TTF files into assets/fonts.
// The Google Fonts CSS API serves TrueType to clients that don't announce woff2 support.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const FAMILIES = {
  Poppins: [400, 600, 800],
  Inter: [400, 600, 800],
  Montserrat: [400, 700, 900],
  'Playfair Display': [400, 700, 900],
  Anton: [400],
  Lora: [400, 700],
  Oswald: [400, 700],
  Raleway: [400, 700, 900],
};

const dir = path.join(ROOT, 'assets', 'fonts');
fs.mkdirSync(dir, { recursive: true });

let fetched = 0;
for (const [family, weights] of Object.entries(FAMILIES)) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weights.join(';')}`;
  const css = await (await fetch(url, { headers: { 'user-agent': 'curl/8' } })).text();
  const faces = [...css.matchAll(/font-weight:\s*(\d+);[\s\S]*?src:\s*url\((https:[^)]+\.ttf)\)/g)];
  if (!faces.length) {
    console.warn(`No TTF found for ${family}`);
    continue;
  }
  for (const [, weight, src] of faces) {
    const file = path.join(dir, `${family.replace(/\s+/g, '')}-${weight}.ttf`);
    if (fs.existsSync(file)) continue;
    const buf = Buffer.from(await (await fetch(src)).arrayBuffer());
    fs.writeFileSync(file, buf);
    fetched++;
  }
  console.log(`✓ ${family}`);
}
console.log(`Fonts ready in ${path.relative(ROOT, dir)} (${fetched} downloaded).`);
