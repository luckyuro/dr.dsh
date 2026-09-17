/** Regenerate the shipped PNGs from the reviewed SVGs; normal builds need no image tooling. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(`assets/brand/${name}`, root), 'utf8');
const app = read('app-icon.svg');
if (!app.includes('rx="112"') || !app.includes('translate(96 96) scale(5)')) {
  throw new Error('The app-icon.svg geometry changed; update the full-bleed export before regenerating icons.');
}
// Launchers supply their own shape. The smaller mark keeps the tail inside the central 80% circle.
const fullBleed = app
  .replace('rx="112"', 'rx="0"')
  .replace('translate(96 96) scale(5)', 'translate(112 112) scale(4.5)');

for (const [name, svg, width, height] of [
  ['favicon-16.png', app, 16, 16],
  ['favicon-32.png', app, 32, 32],
  ['apple-touch-icon.png', fullBleed, 180, 180],
  ['icon-192.png', app, 192, 192],
  ['icon-512.png', app, 512, 512],
  ['icon-maskable-512.png', fullBleed, 512, 512],
  ['logo.png', read('logo.svg'), 720, 192],
  ['logo-dark.png', read('logo-dark.svg'), 720, 192],
]) {
  let png;
  try {
    png = execFileSync('rsvg-convert', ['--width', String(width), '--height', String(height)], {
      input: svg,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error('Cannot render brand assets. Install librsvg (rsvg-convert), then run pnpm run brand:generate again.', { cause });
  }
  const destination = new URL(`apps/pwa/static/${name}`, root);
  writeFileSync(destination, png);
  console.log(`${fileURLToPath(destination)} (${width} × ${height})`);
}
