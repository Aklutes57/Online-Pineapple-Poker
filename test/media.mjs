// End-to-end WebRTC in real browsers with fake camera/mic. Three scenarios,
// because "the webcam works" has three different meanings:
//
//   A. two players who both turn Video on see each other (the mesh itself)
//   B. a player who turns NOTHING on still sees and HEARS everyone who did
//      — watching is not the same as broadcasting, and this is the one that
//      used to fail: only the broadcaster ever saw a picture
//   C. that watcher then joins, and the players already in the session start
//      receiving their camera too (the connection is rebuilt, not left stale)
//
// Usage: npm run media
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-media-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;

const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'Host', settings: {} }),
}).then((r) => r.json());

const args = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  // The audio assertion below needs an AudioContext to run without a gesture.
  '--autoplay-policy=no-user-gesture-required',
];
let browser;
try { browser = await chromium.launch({ args }); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args }); }

async function page(name, token, nick) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console.error: ${m.text()}`); });
  if (token) await p.addInitScript(([k, v]) => localStorage.setItem(k, v), [`pp:${created.gameId}`, JSON.stringify({ token, nickname: nick })]);
  await p.goto(`${base}/games/${created.gameId}`);
  return p;
}

// ---- three players at the table ----

const host = await page('host', created.token, 'Host');
await host.click('.empty-seat-btn');
await host.click('#j-request');
await host.waitForSelector('.seat.me .nameplate');

async function seatGuest(p, nick) {
  await p.click('[data-act="open-join"]');
  await p.fill('#j-nickname', nick);
  await p.click('#j-request');
  await host.waitForSelector('#seat-requests button[data-approve="yes"]');
  await host.locator('#seat-requests button[data-approve="yes"]').first().click();
  await p.waitForSelector('.seat.me .nameplate');
}

const guest = await page('guest', null, 'Guest');
await seatGuest(guest, 'Guest');
// The watcher: seated at the table, but never presses Join for A/V.
const watcher = await page('watcher', null, 'Watcher');
await seatGuest(watcher, 'Watcher');

// How many live remote tiles a page can see, and whether its own is running.
async function tiles(p, { wantRemote = 1, wantMine = true } = {}) {
  return p.evaluate(async ({ wantRemote, wantMine }) => {
    for (let i = 0; i < 40; i++) {
      const vids = [...document.querySelectorAll('#seats-layer video.seat-cam')];
      const remote = vids.filter((v) => !v.classList.contains('mine') && v.videoWidth > 0);
      const mine = vids.filter((v) => v.classList.contains('mine') && v.videoWidth > 0);
      if (remote.length >= wantRemote && (!wantMine || mine.length > 0)) {
        return { ok: true, remote: remote.length, mine: mine.length };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const vids = [...document.querySelectorAll('#seats-layer video.seat-cam')];
    return {
      ok: false,
      remote: vids.filter((v) => !v.classList.contains('mine') && v.videoWidth > 0).length,
      mine: vids.filter((v) => v.classList.contains('mine') && v.videoWidth > 0).length,
      widths: vids.map((v) => `${v.className}:${v.videoWidth}`),
    };
  }, { wantRemote, wantMine });
}

// Is sound actually arriving? The fake device emits a periodic tone, so a
// non-zero peak off the received stream proves voice is flowing end to end —
// not merely that an element exists with a track attached to it.
async function voice(p, { want = 1 } = {}) {
  return p.evaluate(async ({ want }) => {
    const measure = async (stream) => {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      try {
        await ctx.resume().catch(() => {});
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        let peak = 0;
        for (let i = 0; i < 40; i++) {
          an.getFloatTimeDomainData(buf);
          for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
          if (peak > 0.01) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return peak;
      } finally {
        await ctx.close().catch(() => {});
      }
    };

    for (let attempt = 0; attempt < 20; attempt++) {
      const els = [...document.querySelectorAll('#av-audio audio')];
      const withTracks = els.filter((el) => el.srcObject && el.srcObject.getAudioTracks().length > 0);
      if (withTracks.length >= want) {
        const peaks = [];
        for (const el of withTracks) peaks.push(await measure(el.srcObject));
        return {
          ok: peaks.filter((x) => x > 0.01).length >= want,
          elements: els.length,
          peaks,
          playing: withTracks.every((el) => !el.paused),
          muted: withTracks.map((el) => el.muted),
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const els = [...document.querySelectorAll('#av-audio audio')];
    return { ok: false, elements: els.length, reason: 'no audio element ever received a track' };
  }, { want });
}

// The A/V controls live inside the settings sheet, which is closed by default,
// so Start video has to be reached the way a player reaches it.
async function startVideo(p) {
  await p.waitForSelector('#av-join:not(.hidden)', { state: 'attached' });
  const sheet = p.locator('#top-menu');
  if (!(await sheet.isVisible().catch(() => false))) await p.click('#menu-toggle');
  await p.waitForSelector('#av-join:not(.hidden)');
  await p.click('#av-join');
  await p.click('#menu-toggle'); // put the sheet away again
}

// ---- A. two broadcasters see each other ----

for (const p of [host, guest]) await startVideo(p);

const a1 = await tiles(host);
const a2 = await tiles(guest);
check('A: host sees the guest’s webcam', a1.ok, JSON.stringify(a1));
check('A: guest sees the host’s webcam', a2.ok, JSON.stringify(a2));

// ---- B. the watcher never joined, and must still see and hear both ----

const b = await tiles(watcher, { wantRemote: 2, wantMine: false });
check('B: a player who never turned their camera on sees both webcams', b.ok, JSON.stringify(b));
check('B: the watcher is not broadcasting anything of their own', b.mine === 0);

const bVoice = await voice(watcher, { want: 2 });
check('B: the watcher hears both players', bVoice.ok, JSON.stringify(bVoice));
check('B: the watcher’s audio is playing, not paused', bVoice.playing === true);

// A tile carries no sound of its own — voices come out of the audio elements,
// so a hidden or rebuilt tile can never cost you the table.
const tilesMuted = await watcher.evaluate(() =>
  [...document.querySelectorAll('video.seat-cam')].every((v) => v.muted));
check('B: video tiles are muted (audio is separate)', tilesMuted);

// ---- C. the watcher joins: the others must start receiving them ----

await startVideo(watcher);

const c1 = await tiles(host, { wantRemote: 2 });
const c2 = await tiles(guest, { wantRemote: 2 });
const c3 = await tiles(watcher, { wantRemote: 2 });
check('C: host receives the new joiner’s camera', c1.ok, JSON.stringify(c1));
check('C: guest receives the new joiner’s camera', c2.ok, JSON.stringify(c2));
check('C: the joiner still sees both others', c3.ok, JSON.stringify(c3));
const cVoice = await voice(host, { want: 2 });
check('C: host hears both other players', cVoice.ok, JSON.stringify(cVoice));

// ---- D. bets must not land on people's faces ----
//
// The complaint this exists for: with a camera on, the chips in front of a
// player were drawn over their picture. The placement code always knew a tile
// was an obstacle — it just ran too early, inside renderBets, BEFORE the
// tiles were put back into the freshly rebuilt pods. So this has to go
// through the app's own update path with real cameras and real chips, which
// means dealing a hand: the blinds alone put chips on the felt.

// The A/V controls live in the Menu sheet, which is still open from scenario
// C and would swallow the click.
if (await host.evaluate(() =>
  document.getElementById('menu-toggle')?.getAttribute('aria-expanded') === 'true')) {
  await host.click('#menu-toggle');
  await host.waitForSelector('#top-menu.hidden', { state: 'attached' });
}
await host.click('#start-game-btn');
await host.waitForSelector('.bet-chip', { timeout: 10000 });
// Let the deal animation and the A/V re-attach settle.
await host.waitForTimeout(1200);

const chipsOnFaces = await host.evaluate(() => {
  const hits = (a, b) =>
    a.left < b.right - 1 && a.right > b.left + 1
    && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  const tiles = [...document.querySelectorAll('#seats-layer video.seat-cam')]
    .map((v) => v.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  const chips = [...document.querySelectorAll('.bet-chip')].map((c) => c.getBoundingClientRect());
  return {
    tiles: tiles.length,
    chips: chips.length,
    over: chips.filter((c) => tiles.some((t) => hits(c, t))).length,
  };
});
check('D: there are live camera tiles and chips on the felt to test with',
  chipsOnFaces.tiles > 0 && chipsOnFaces.chips > 0, JSON.stringify(chipsOnFaces));
check('D: no bet chip is drawn over a live camera tile',
  chipsOnFaces.over === 0, JSON.stringify(chipsOnFaces));

// ---- E. the mute button is a control you can actually hit ----
// It was a 9.5px pill in the plate's corner — present, but not something
// anybody found. It must stay absolutely positioned (it costs the pod no
// height, which the seat-overlap gates rely on) and be big enough to tap.
const muteBtn = await host.evaluate(() => {
  const b = document.querySelector('#seats-layer .np-mute');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  return {
    text: b.textContent.trim(),
    w: Math.round(r.width), h: Math.round(r.height),
    font: parseFloat(cs.fontSize), position: cs.position,
  };
});
check('E: another player who is broadcasting has a mute button',
  !!muteBtn, JSON.stringify(muteBtn));
if (muteBtn) {
  check('E: it says what it does', muteBtn.text === 'Mute', muteBtn.text);
  check('E: it is big enough to read and hit',
    muteBtn.font >= 11 && muteBtn.w >= 44 && muteBtn.h >= 16, JSON.stringify(muteBtn));
  check('E: and still costs the pod no height', muteBtn.position === 'absolute');
}

console.log(`media: ${passes} passed, ${failures} failed`);

await browser.close();
await new Promise((r) => httpServer.close(r));
process.exit(failures ? 1 : 0);
