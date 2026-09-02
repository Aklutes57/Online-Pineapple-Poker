// The action bar must never cost the table anything it did not reserve.
//
// The bar is a fixed strip the page grid sets aside; its contents live in a
// panel anchored to the strip's bottom edge. If that panel is taller than the
// strip it is drawn OVER the felt — and on a phone the felt right above the
// bar is your own nameplate and your own cards. This harness measures, at
// every size a phone can be, that the resting bar fits its strip and covers
// neither, and that the table is exactly the same size with the bet tray open
// as without it.
//
// Kept out of `npm test` (it needs Chromium); run it with `npm run bar`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-probe-')), 'test.db');
const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { signUpInPage } = await import('./helpers/account.js');
const SHOT = process.env.PP_SHOT_DIR || '/tmp';

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  .catch(() => chromium.launch());
const mk = async (w, h) => (await browser.newContext({ viewport: { width: w, height: h } })).newPage();

const anna = await mk(1280, 800);
await anna.goto(base);
await signUpInPage(anna, base, 'Anna');
await anna.reload();
await anna.click('#start-btn');
await anna.fill('#c-nickname', 'Anna');
await anna.selectOption('#c-variant', 'holdem');
await anna.click('#c-create');
await anna.waitForURL('**/games/**');
const url = anna.url();
await anna.click('.empty-seat-btn');
await anna.click('#j-request');
await anna.waitForSelector('.seat.me .nameplate');
const ben = await mk(1280, 800);
await ben.goto(base);
await signUpInPage(ben, base, 'Ben');
await ben.goto(url);
await ben.click('.empty-seat-btn');
await ben.fill('#j-nickname', 'Ben');
await ben.click('#j-request');
await anna.waitForSelector('#seat-requests button[data-approve="yes"]', { timeout: 10000 });
await anna.locator('#seat-requests button[data-approve="yes"]').first().click();
await ben.waitForSelector('.seat.me .nameplate');
await anna.click('#start-game-btn');
await anna.waitForSelector('.cards-fan.mine .card');

const actor = async () => {
  for (let i = 0; i < 60; i++) {
    for (const p of [anna, ben]) {
      if (await p.locator('[data-act="open-tray"]').isVisible().catch(() => false)) return p;
    }
    await anna.waitForTimeout(150);
  }
  return null;
};
const p = await actor();

const probe = () => p.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const b = e.getBoundingClientRect();
    return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
  const inner = r('.ab-inner');
  const plate = r('.seat.me .nameplate');
  const fan = r('.seat.me .cards-fan');
  const over = (x) => (x && inner ? Math.max(0, Math.round(x.b - inner.t)) : 0);
  const btns = [...document.querySelectorAll('#action-bar .ab-btn')].map((e) => Math.round(e.getBoundingClientRect().top));
  return {
    barH: r('#action-bar')?.h, innerH: inner?.h,
    rows: new Set(btns).size,
    plateCovered: Math.min(over(plate), plate?.h ?? 0),
    cardsCovered: Math.min(over(fan), fan?.h ?? 0),
    trayH: r('.bet-tray')?.h ?? 0,
  };
});

const feltBox = () => p.evaluate(() =>
  JSON.stringify(document.getElementById('table').getBoundingClientRect()));

let bad = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${name}${extra ? ` ${extra}` : ''}`);
  if (!cond) bad++;
};

for (const [w, h] of [[390, 844], [360, 800], [430, 932], [320, 568], [844, 390], [1280, 800]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(450);
  const row = await probe();
  const felt = await feltBox();
  // Two pixels of grace: the panel's border sits on the strip's edge.
  check(`${w}x${h}: the resting bar fits the strip it reserved`,
    row.innerH <= row.barH + 2, `(${row.innerH} in ${row.barH}, ${row.rows} row(s))`);
  check(`${w}x${h}: it covers none of your nameplate`, row.plateCovered === 0,
    row.plateCovered ? `(${row.plateCovered}px)` : '');
  check(`${w}x${h}: it covers none of your cards`, row.cardsCovered === 0,
    row.cardsCovered ? `(${row.cardsCovered}px)` : '');

  await p.click('[data-act="open-tray"]');
  await p.waitForSelector('#tray-slider');
  await p.waitForTimeout(250);
  const tray = await probe();
  check(`${w}x${h}: opening the tray does not move the table`,
    (await feltBox()) === felt);
  check(`${w}x${h}: the tray is wider than it is tall`, w > tray.trayH, `(tray ${tray.trayH}px)`);
  if (w === 390) await p.screenshot({ path: `${SHOT}/bar-phone-tray.png` });
  await p.click('.tray-close');
  await p.waitForTimeout(150);
  const after = await probe();
  check(`${w}x${h}: closing it hands the strip back`, after.innerH <= after.barH + 2);
}

await browser.close();
httpServer.close();
console.log(bad ? `bar: FAILED (${bad})` : 'bar: all checks passed');
process.exit(bad ? 1 : 0);
