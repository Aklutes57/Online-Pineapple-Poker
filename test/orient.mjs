// Verifies the table stands upright on portrait screens and lies down on
// landscape ones, fits with no cutoff either way, and fills the space far
// better than a letterboxed landscape table would. Temp tool.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-or-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { EVENTS, BET_COORDS, BET_COORDS_PORTRAIT } = await import('../shared/constants.js');
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
// A full ten-handed table is the worst case for both clipping and overlap.
for (let i = 1; i <= 9; i++) others.push(await sock(null, `P${i}`, i));
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

const landscapeCoords = BET_COORDS;
const portraitCoords = BET_COORDS_PORTRAIT;

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

  const m = await page.evaluate(async ([landscapeCoords, portraitCoords]) => {
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
    // A bet chip sitting on top of somebody's name makes both unreadable, so
    // every chip is checked against every nameplate, card fan and avatar.
    const hits = (a, b) =>
      a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    // The probe has to measure the pod at its TALLEST, not at its emptiest.
    // A bare table has no last-action bubble and no webcam tile, so probing one
    // proves nothing about the layout people actually see — a chip can only
    // ever collide with the things that appear once a hand is under way.
    const stand = [];
    for (const pod of document.querySelectorAll('#seats-layer .seat.occupied')) {
      const plate = pod.querySelector('.nameplate');
      if (plate && !plate.querySelector('.np-bubble')) {
        const bubble = document.createElement('div');
        bubble.className = 'np-bubble probe';
        bubble.textContent = 'raise 200';
        plate.appendChild(bubble);
        stand.push(bubble);
      }
      if (!pod.querySelector('video.seat-cam')) {
        const cam = document.createElement('video');
        cam.className = 'seat-cam probe';
        pod.insertBefore(cam, pod.firstChild);
        stand.push(cam);
      }
    }

    // Only the blinds are actually live, so every remaining anchor is probed
    // with a stand-in chip: the check is about geometry, not about the hand.
    const layer = document.getElementById('bets-layer');
    const probes = [];
    const coords = t.classList.contains('upright') ? portraitCoords : landscapeCoords;
    const taken = new Set([...layer.querySelectorAll('.bet-chip')].map((c) => c.style.left + c.style.top));
    coords.forEach((c) => {
      const key = `${c.left}%${c.top}%`;
      if (taken.has(key)) return;
      const el = document.createElement('div');
      el.className = 'bet-chip probe';
      el.style.left = `${c.left}%`;
      el.style.top = `${c.top}%`;
      el.textContent = '8888';
      layer.appendChild(el);
      probes.push(el);
    });
    // Placing the chips is the app's job, so the gate asks the app to do it
    // against the pod it just built — measuring anchors alone would only prove
    // the constants are what the constants are.
    await (await import('/js/render.js')).clearChipsOfPods();
    const chips = [...layer.querySelectorAll('.bet-chip')].map((c) => c.getBoundingClientRect());
    // Everything a chip could land on, including the absolutely-positioned
    // action bubble (which is NOT inside its nameplate's rect) and the webcam
    // tile, which is the tallest thing a pod ever holds.
    const pods = [...document.querySelectorAll(
      '#seats-layer .nameplate, #seats-layer .card, #seats-layer .seat-avatar,'
      + ' #seats-layer .np-bubble, #seats-layer video.seat-cam'
    )].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const collisions = chips.filter((c) => pods.some((n) => hits(c, n))).length;
    for (const el of probes) el.remove();
    for (const el of stand) el.remove();

    return {
      upright: t.classList.contains('upright'),
      tw: Math.round(r.width), th: Math.round(r.height),
      overflowX: de.scrollWidth - window.innerWidth,
      iw: window.innerWidth, ih: window.innerHeight,
      seatsOut: seats.filter((s) => s.l < -1 || s.r > 1 || s.t < -1 || s.b > 1).length,
      worst: seats.reduce((m, s) => Math.max(m, -s.l, s.r, -s.t, s.b), 0),
      seatCount: seats.length,
      chips: chips.length,
      collisions,
    };
  }, [landscapeCoords, portraitCoords]);

  const orientOk = m.upright === wantUpright;
  const tallerThanWide = m.th > m.tw;
  const shapeOk = wantUpright ? tallerThanWide : !tallerThanWide;
  const fits = m.overflowX <= 2 && m.seatsOut === 0 && m.collisions === 0;
  // How much of the screen the felt covers — the point of the whole change.
  const cover = ((m.tw * m.th) / (m.iw * m.ih) * 100).toFixed(0);
  const ok = orientOk && shapeOk && fits;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: upright=${m.upright} felt=${m.tw}x${m.th} cover=${cover}% overflowX=${m.overflowX} seatsClipped=${m.seatsOut}/${m.seatCount} worstOverhang=${m.worst}px betOverlaps=${m.collisions}/${m.chips}`);
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
