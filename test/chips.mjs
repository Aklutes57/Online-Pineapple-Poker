// The chip flights: money moving between stacks has to be something you can
// watch, and it has to clean up after itself. Counted with a MutationObserver
// rather than by sampling, so the assertions do not race a 520ms animation.
// Usage: node test/chips.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-chips-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { EVENTS } = await import('../shared/constants.js');

let bad = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) bad++;
};

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;
const { io: ioc } = await import('socket.io-client');

const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  // Bounty on: it is the one payout that is genuinely stack to stack.
  body: JSON.stringify({ nickname: 'Host', settings: { sevenDeuceBounty: 5 } }),
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
const others = [await sock(null, 'P1', 1), await sock(null, 'P2', 2)];
await new Promise((r) => setTimeout(r, 300));
for (const o of others) host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: o.r.playerId, approve: true });
await new Promise((r) => setTimeout(r, 300));

let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }

// Counts every chip that is ever added to the flight layer, and the most that
// were in the air at once, so a finished animation still leaves evidence.
const OBSERVE = `
  window.__fx = { total: 0, peak: 0 };
  const start = () => {
    const layer = document.getElementById('fx-layer');
    if (!layer) return setTimeout(start, 50);
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.classList?.contains('fx-chip')) window.__fx.total++;
        }
      }
      window.__fx.peak = Math.max(window.__fx.peak, layer.children.length);
    }).observe(layer, { childList: true });
  };
  start();
`;

async function watcher({ reducedMotion } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  pageerror: ${e.message}`); bad++; });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
    [`pp:${created.gameId}`, JSON.stringify({ token: created.token, nickname: 'Host' })]);
  await page.addInitScript(OBSERVE);
  await page.goto(`${base}/games/${created.gameId}`);
  await page.waitForSelector('#table');
  return page;
}

const page = await watcher();
const still = await watcher({ reducedMotion: 'reduce' });
check('the flight layer exists on the felt',
  await page.evaluate(() => !!document.getElementById('fx-layer')));

// Everyone folds to one player: blinds get collected and a pot is paid out.
for (const o of [host, ...others]) {
  o.s.on(EVENTS.STATE, (state) => {
    const av = state.you?.availableActions;
    if (!av || !state.hand) return;
    // The host takes it down; the other two give it up.
    const action = state.you.seatIndex === 0 ? (av.canCheck ? 'check' : 'call') : 'fold';
    o.s.emit(EVENTS.ACTION, { handId: state.hand.handId, action });
  });
}
host.s.emit(EVENTS.HOST_START_GAME, {});
await new Promise((r) => setTimeout(r, 2500));

const fx = await page.evaluate(() => window.__fx);
check(`chips were flown (${fx.total} in total, ${fx.peak} at once)`, fx.total > 0);
check('more than one chip moved — bets in AND the pot out', fx.total > 1);

// …and the felt is left clean.
await new Promise((r) => setTimeout(r, 1600));
const leftover = await page.evaluate(() => document.getElementById('fx-layer').children.length);
check('every chip cleans itself up', leftover === 0);

const stillFx = await still.evaluate(() => window.__fx);
check('a viewer who asked not to be moved gets no flights', stillFx.total === 0);

// The numbers themselves must be unaffected either way: the animation is a
// flourish over state that is already correct.
const stacks = await Promise.all([page, still].map((p) => p.evaluate(() =>
  [...document.querySelectorAll('#seats-layer .seat.occupied .np-stack')].map((n) => n.textContent))));
check('both viewers read the same stacks',
  JSON.stringify(stacks[0]) === JSON.stringify(stacks[1]) && stacks[0].length > 0);

await browser.close();
for (const o of [host, ...others]) o.s.disconnect();
await new Promise((r) => httpServer.close(r));
console.log(bad === 0 ? 'CHIPS: all good' : `CHIPS: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
