// One-off: renders public/icons/pineapple.svg into the committed PNG icon
// set. Not part of the test chain — run it again only if the SVG changes:
//   node scripts/render-icons.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(__dirname, '..', 'public', 'icons');
const svg = readFileSync(path.join(iconsDir, 'pineapple.svg'), 'utf8');
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
}

// [file, canvas px, scale of the mark inside the canvas]
// Maskable icons need the mark inside the ~80% safe zone, so it shrinks and
// the dark background bleeds to every edge.
const TARGETS = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['apple-touch-icon.png', 180, 1],
  ['maskable-512.png', 512, 0.72],
];

const page = await browser.newPage();
for (const [file, size, scale] of TARGETS) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * scale);
  const pad = Math.round((size - inner) / 2);
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      #canvas { width: ${size}px; height: ${size}px; background: #10131c;
                display: flex; align-items: center; justify-content: center; }
      img { width: ${inner}px; height: ${inner}px; display: block; margin: ${pad}px; }
    </style>
    <div id="canvas"><img src="${svgUrl}"></div>`);
  await page.waitForTimeout(150);
  await page.locator('#canvas').screenshot({ path: path.join(iconsDir, file) });
  console.log(`rendered ${file}`);
}

await browser.close();
