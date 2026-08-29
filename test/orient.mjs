// Verifies the table stands upright on portrait screens and lies down on
// landscape ones, fits with no cutoff either way, and fills the space far
// better than a letterboxed landscape table would. Temp tool.
//
// PP_VARIANT picks the game to lay out; the gate runs the ones that pass.
// THREE DO NOT, all portrait-only and all pre-existing:
//
//   PP_VARIANT=pineapple     podClash 4  (3 portrait viewports)
//   PP_VARIANT=747           podClash 4  (3 portrait viewports)
//   PP_VARIANT=sevenCardStud podClash 4  (3 portrait viewports)
//
// Nameplates collide with their neighbours on a ten-handed upright ring. The
// status row was half of it and is fixed (it is out of flow now, so it costs
// the pod no height); what is left is ring geometry — these games deal more
// cards, taller pods make fitTableStage refit to a different felt, and the
// seats end up close enough for the plates to touch. Reproduce with the lines
// above before changing any of it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-or-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { EVENTS, BET_COORDS, BET_COORDS_PORTRAIT } = await import('../shared/constants.js');
const SHOT = process.env.PP_SHOT_DIR || '/tmp';
const VARIANT_LABEL = process.env.PP_VARIANT || 'holdem';

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;

const { io: ioc } = await import('socket.io-client');
const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  // Which game to lay out. Stud is the worst case for the pods: seven cards in
  // front of every player, where the geometry was designed around two.
  body: JSON.stringify({
    nickname: 'Host',
    settings: process.env.PP_VARIANT ? { variant: process.env.PP_VARIANT } : {},
  }),
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

// Stud is only interesting to lay out once the cards are actually there:
// third street is three, and the fan that has to hold seven is the thing that
// changed. Drive everyone to check or call until the live players are holding
// six or seven cards, then stop, so the layout is still while it is measured.
if (VARIANT_LABEL === 'sevenCardStud') {
  const all = [host, ...others];
  for (const o of all) {
    o.s.on(EVENTS.STATE, (state) => {
      if (o.parked) return;
      const av = state.you?.availableActions;
      if (!av) return;
      const hand = state.hand;
      o.s.emit(EVENTS.ACTION, {
        handId: hand.handId,
        action: av.canCheck ? 'check' : 'call',
      });
    });
  }
  // Read the hand straight off the server rather than round-tripping a
  // broadcast: this process is the server, and the socket nudge it used to
  // rely on was being dropped, so the loop just timed out at third street.
  const { getGame } = await import('../server/gameManager.js');
  const game = getGame(created.gameId);
  const deadline = Date.now() + 30000;
  let reached = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const live = (game.currentHand?.players || []).filter((p) => !p.folded);
    reached = Math.max(0, ...live.map((p) => p.holeCards.length));
    if (reached >= 7) break;
    // A hand that ends before seventh street just deals another one; keep going.
  }
  for (const o of all) o.parked = true;
  // Pause before measuring. Without this the table deals another hand three
  // seconds later while the viewports are being walked, so the layout is read
  // against whatever state that hand happens to be in — which made this gate
  // report anything between "all good" and three failures on identical code.
  host.s.emit(EVENTS.HOST_PAUSE, { paused: true });
  await new Promise((r) => setTimeout(r, 1200));
  console.log(`  (stud driven to ${reached} cards a player before measuring)`);
}

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
      // The wide-fan shape: PLO and 747 deal four cards, which is when the
      // fans beside yours reach furthest. Pad every fan out to four, with the
      // class render.js would give a real four-card deal.
      const fan = pod.querySelector('.cards-fan');
      if (fan && fan.children.length > 0) {
        while (fan.children.length < 4) {
          const back = document.createElement('div');
          back.className = 'card back probe';
          fan.appendChild(back);
          stand.push(back);
        }
        if (!fan.classList.contains('fan-4')) {
          fan.classList.add('fan-4', 'probe-class');
        }
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
    // Whatever else overlaps, YOUR cards must be the thing on top: hit-test
    // the centre of each of my cards and require my own seat to answer.
    let myCardsBlocked = 0;
    for (const card of document.querySelectorAll('#seats-layer .seat.me .cards-fan .card')) {
      const r = card.getBoundingClientRect();
      if (!r.width) continue;
      const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (topEl && !topEl.closest('.seat.me')) myCardsBlocked++;
    }

    // The community cards are the one thing at the table no neighbour's fan
    // may cover. Preflop the board is empty, so stand in the full five and
    // hit-test their centres. The centre layer is click-through by design,
    // which elementFromPoint would skip — give it pointer events back for
    // the duration of the probe so the test sees the true paint order.
    const board = document.getElementById('board');
    const center = document.getElementById('table-center');
    let boardRow = board.querySelector('.board-row');
    if (!boardRow) {
      boardRow = document.createElement('div');
      boardRow.className = 'board-row';
      board.appendChild(boardRow);
      stand.push(boardRow);
    }
    while (boardRow.children.length < 5) {
      const c = document.createElement('div');
      c.className = 'card back probe';
      boardRow.appendChild(c);
      stand.push(c);
    }
    center.style.pointerEvents = 'auto';
    let boardCovered = 0;
    for (const card of boardRow.children) {
      const r = card.getBoundingClientRect();
      if (!r.width) continue;
      const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (topEl && !topEl.closest('#table-center')) boardCovered++;
    }
    center.style.pointerEvents = '';

    // Overlap is not just about who paints on top: a board that COVERS a
    // nameplate is as broken as a fan that covers the board. The board box
    // must intersect no nameplate at all, and no seat's plate or webcam tile
    // may sit on another seat's plate.
    const boardBox = boardRow.getBoundingClientRect();
    const plates = [...document.querySelectorAll('#seats-layer .nameplate')]
      .map((n) => n.getBoundingClientRect()).filter((b) => b.width > 0);
    const boardHitsPlate = plates.filter((b) => hits(boardBox, b)).length;
    let podClash = 0;
    const podBoxes = [...document.querySelectorAll('#seats-layer .seat.occupied')].map((s) => ({
      plate: s.querySelector('.nameplate')?.getBoundingClientRect(),
      cam: s.querySelector('video.seat-cam')?.getBoundingClientRect(),
    }));
    for (let a = 0; a < podBoxes.length; a++) {
      for (let b = 0; b < podBoxes.length; b++) {
        if (a === b) continue;
        const src = [podBoxes[a].plate, podBoxes[a].cam].filter((r) => r && r.width);
        const dst = podBoxes[b].plate;
        if (!dst || !dst.width) continue;
        if (src.some((r) => hits(r, dst))) podClash++;
      }
    }

    for (const el of probes) el.remove();
    for (const el of stand) el.remove();
    for (const fan of document.querySelectorAll('.cards-fan.probe-class')) {
      fan.classList.remove('fan-4', 'probe-class');
    }

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
      myCardsBlocked,
      boardCovered,
      boardHitsPlate,
      podClash,
    };
  }, [landscapeCoords, portraitCoords]);

  const orientOk = m.upright === wantUpright;
  const tallerThanWide = m.th > m.tw;
  const shapeOk = wantUpright ? tallerThanWide : !tallerThanWide;
  const fits = m.overflowX <= 2 && m.seatsOut === 0 && m.collisions === 0
    && m.myCardsBlocked === 0 && m.boardCovered === 0
    && m.boardHitsPlate === 0 && m.podClash === 0;
  // How much of the screen the felt covers — the point of the whole change.
  const cover = ((m.tw * m.th) / (m.iw * m.ih) * 100).toFixed(0);
  const ok = orientOk && shapeOk && fits;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: upright=${m.upright} felt=${m.tw}x${m.th} cover=${cover}% overflowX=${m.overflowX} seatsClipped=${m.seatsOut}/${m.seatCount} worstOverhang=${m.worst}px betOverlaps=${m.collisions}/${m.chips} myCardsBlocked=${m.myCardsBlocked} boardCovered=${m.boardCovered} boardHitsPlate=${m.boardHitsPlate} podClash=${m.podClash}`);
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
console.log(bad === 0
  ? `ORIENTATION (${VARIANT_LABEL}): all good`
  : `ORIENTATION (${VARIANT_LABEL}): ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
