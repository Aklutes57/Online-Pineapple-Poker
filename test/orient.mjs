// Verifies the table stands upright on portrait screens and lies down on
// landscape ones, fits with no cutoff either way, and fills the space far
// better than a letterboxed landscape table would. Temp tool.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-or-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { EVENTS } = await import('../shared/constants.js');
const SHOT = process.env.PP_SHOT_DIR || '/tmp';

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;

const { io: ioc } = await import('socket.io-client');
const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'Host', settings: {} }),
}).then((r) => r.json());
function sock(token, nick, seat) {
  return new Promise((res) => {
    const s = ioc(base, { transports: ['websocket'], extraHeaders: { Origin: base }, reconnection: false });
    s.on('connect', () => s.emit(EVENTS.JOIN, { gameId: created.gameId, token, nickname: nick }, (r) => {
      s.emit(EVENTS.REQUEST_SEAT, { nickname: nick, buyIn: 200, seatIndex: seat });
      res({ s, r });
    }));
  });
}
const host = await sock(created.token, 'Host', 0);
const others = [];
for (let i = 1; i <= 5; i++) others.push(await sock(null, `P${i}`, i));
await new Promise((r) => setTimeout(r, 300));
for (const o of others) host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: o.r.playerId, approve: true });
await new Promise((r) => setTimeout(r, 300));
host.s.emit(EVENTS.HOST_START_GAME, {});
await new Promise((r) => setTimeout(r, 500));

let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }

const views = [
  ['iphone-portrait', 390, 844, true],
  ['iphone-se-portrait', 375, 667, true],
  ['iphone-landscape', 844, 390, false],
  ['ipad-portrait', 820, 1180, true],
  ['ipad-landscape', 1180, 820, false],
  ['laptop', 1366, 768, false],
];

let bad = 0;
for (const [name, w, h, wantUpright] of views) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [${name}] pageerror: ${e.message}`); bad++; });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
    [`pp:${created.gameId}`, JSON.stringify({ token: created.token, nickname: 'Host' })]);
  await page.goto(`${base}/games/${created.gameId}`);
  await page.waitForSelector('#table');
  await page.waitForTimeout(800);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const t = document.getElementById('table');
    const r = t.getBoundingClientRect();
    // Measure against #table-area: it has overflow:hidden, so it — not the
    // window — is what actually clips a seat.
    const area = document.getElementById('table-area').getBoundingClientRect();
    const seats = [...document.querySelectorAll('#seats-layer .seat.occupied')].map((s) => {
      const b = s.getBoundingClientRect();
      return { l: Math.round(b.left - area.left), r: Math.round(b.right - area.right),
               t: Math.round(b.top - area.top), b: Math.round(b.bottom - area.bottom) };
    });
    return {
      upright: t.classList.contains('upright'),
      tw: Math.round(r.width), th: Math.round(r.height),
      overflowX: de.scrollWidth - window.innerWidth,
      iw: window.innerWidth, ih: window.innerHeight,
      seatsOut: seats.filter((s) => s.l < -1 || s.r > 1 || s.t < -1 || s.b > 1).length,
      worst: seats.reduce((m, s) => Math.max(m, -s.l, s.r, -s.t, s.b), 0),
      seatCount: seats.length,
    };
  });

  const orientOk = m.upright === wantUpright;
  const tallerThanWide = m.th > m.tw;
  const shapeOk = wantUpright ? tallerThanWide : !tallerThanWide;
  const fits = m.overflowX <= 2 && m.seatsOut === 0;
  // How much of the screen the felt covers — the point of the whole change.
  const cover = ((m.tw * m.th) / (m.iw * m.ih) * 100).toFixed(0);
  const ok = orientOk && shapeOk && fits;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: upright=${m.upright} felt=${m.tw}x${m.th} cover=${cover}% overflowX=${m.overflowX} seatsClipped=${m.seatsOut}/${m.seatCount} worstOverhang=${m.worst}px`);
  await page.screenshot({ path: `${SHOT}/orient-${name}.png` });
  await ctx.close();
}

// Rotating a live page must re-lay the table, not just rescale it.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
    [`pp:${created.gameId}`, JSON.stringify({ token: created.token, nickname: 'Host' })]);
  await page.goto(`${base}/games/${created.gameId}`);
  await page.waitForSelector('#table');
  await page.waitForTimeout(600);
  const before = await page.evaluate(() => document.getElementById('table').classList.contains('upright'));
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const t = document.getElementById('table');
    const seats = [...document.querySelectorAll('#seats-layer .seat.occupied')].map((s) => s.getBoundingClientRect());
    return {
      upright: t.classList.contains('upright'),
      offscreen: seats.filter((b) => b.left < -1 || b.right > window.innerWidth + 1 || b.top < -1 || b.bottom > window.innerHeight + 1).length,
    };
  });
  const ok = before === true && after.upright === false && after.offscreen === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} rotate-live: portrait=${before} -> landscape upright=${after.upright} seatsOffscreen=${after.offscreen}`);
  await page.screenshot({ path: `${SHOT}/orient-after-rotate.png` });
  await ctx.close();
}

await browser.close();
host.s.close(); others.forEach((o) => o.s.close());
await new Promise((r) => httpServer.close(r));
console.log(bad === 0 ? 'ORIENTATION: all good' : `ORIENTATION: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
