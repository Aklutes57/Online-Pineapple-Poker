import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-tb-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('./server/app.js');
const { EVENTS } = await import('./shared/constants.js');

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;
const { io: ioc } = await import('socket.io-client');
const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'Host', settings: { tournament: true, levelMinutes: 15, rebuyMinutes: 60 } }),
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
for (let i = 1; i <= 3; i++) others.push(await sock(null, `P${i}`, i));
await new Promise((r) => setTimeout(r, 300));
for (const o of others) host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: o.r.playerId, approve: true });
await new Promise((r) => setTimeout(r, 300));
host.s.emit(EVENTS.HOST_START_GAME, {});
await new Promise((r) => setTimeout(r, 800));

let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }

const widths = [1920, 1512, 1440, 1366, 1200, 1101, 1100, 900, 800, 760, 721, 720, 500, 390];
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(([tok, gid]) => {
    localStorage.setItem(`pp:token:${gid}`, tok);
  }, [created.token, created.gameId]);
  await page.goto(`${base}/games/${created.gameId}`);
  await page.waitForSelector('#top-bar');
  await page.waitForTimeout(600);
  // Signed-in players also carry an account chip; unhide it with a realistic name.
  await page.evaluate(() => {
    const a = document.getElementById('account-chip');
    a.classList.remove('hidden');
    a.textContent = 'AydenLutes';
  });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const bar = document.getElementById('top-bar');
    const br = bar.getBoundingClientRect();
    const meta = document.querySelector('.top-meta').getBoundingClientRect();
    const acts = document.querySelector('.top-actions').getBoundingClientRect();
    const vis = (el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return 'none';
      const clippedRight = b.right > br.right + 0.5 || b.right > window.innerWidth + 0.5;
      const clippedLeft = b.left < br.left - 0.5;
      // also clipped by .top-meta's own overflow:hidden
      const mm = el.closest('.top-meta');
      let metaClip = false;
      if (mm) {
        const mb = mm.getBoundingClientRect();
        metaClip = b.right > mb.right + 0.5 || b.left < mb.left - 0.5;
      }
      return { w: Math.round(b.width), x: Math.round(b.left), r: Math.round(b.right),
               off: clippedRight || clippedLeft, metaClip };
    };
    const names = ['#game-badge', '#tourney-clock', '#fair-chip', '#account-chip'];
    const out = {};
    for (const n of names) { const e = document.querySelector(n); out[n] = e ? vis(e) : 'missing'; }
    return {
      barH: Math.round(br.height),
      metaW: Math.round(meta.width), metaRight: Math.round(meta.right),
      actsW: Math.round(acts.width), actsH: Math.round(acts.height),
      actsScrollW: Math.round(document.querySelector('.top-actions').scrollWidth),
      barScrollW: bar.scrollWidth, barClientW: bar.clientWidth,
      metaScrollW: document.querySelector('.top-meta').scrollWidth,
      metaClientW: document.querySelector('.top-meta').clientWidth,
      tableAreaH: Math.round(document.getElementById('table-area').getBoundingClientRect().height),
      out,
    };
  });
  console.log(`w=${w} barH=${m.barH} tableAreaH=${m.tableAreaH} metaW=${m.metaW} (content ${m.metaScrollW}) actsW=${m.actsW} actsH=${m.actsH} barScroll=${m.barScrollW}/${m.barClientW}`);
  for (const [k, v] of Object.entries(m.out)) {
    if (v === 'none' || v === 'missing') { console.log(`    ${k}: hidden`); continue; }
    console.log(`    ${k}: w=${v.w} x=${v.x}..${v.r} offscreen=${v.off} clippedByMeta=${v.metaClip}`);
  }
  await ctx.close();
}
await browser.close();
httpServer.close();
process.exit(0);
