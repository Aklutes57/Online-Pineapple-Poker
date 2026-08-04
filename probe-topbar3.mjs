import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-tb3-')), 'test.db');
const { chromium } = await import('playwright');
const { buildServer } = await import('./server/app.js');
const { EVENTS } = await import('./shared/constants.js');
const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;
const { io: ioc } = await import('socket.io-client');

async function makeTable(settings) {
  const created = await fetch(`${base}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'Host', settings }),
  }).then((r) => r.json());
  const sock = (token, nick, seat) => new Promise((res) => {
    const s = ioc(base, { transports: ['websocket'], extraHeaders: { Origin: base }, reconnection: false });
    s.on('connect', () => s.emit(EVENTS.JOIN, { gameId: created.gameId, token, nickname: nick }, (r) => {
      s.emit(EVENTS.REQUEST_SEAT, { nickname: nick, buyIn: 200, seatIndex: seat });
      res({ s, r });
    }));
  });
  const host = await sock(created.token, 'Host', 0);
  const o = await sock(null, 'P1', 1);
  await new Promise((r) => setTimeout(r, 250));
  host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: o.r.playerId, approve: true });
  await new Promise((r) => setTimeout(r, 250));
  host.s.emit(EVENTS.HOST_START_GAME, {});
  await new Promise((r) => setTimeout(r, 700));
  return created;
}
const cash = await makeTable({});
const tourn = await makeTable({ tournament: true, levelMinutes: 15, rebuyMinutes: 60 });

let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }

for (const [label, created] of [['CASH', cash], ['TOURNAMENT', tourn]]) {
  for (const w of [1920, 1512, 1440, 1366, 1301, 1300]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(([tok, gid]) => localStorage.setItem(`pp:token:${gid}`, tok), [created.token, created.gameId]);
    await page.goto(`${base}/games/${created.gameId}`);
    await page.waitForSelector('#top-bar');
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const a = document.getElementById('account-chip');
      a.classList.remove('hidden'); a.textContent = 'AydenLutes';
    });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const meta = document.querySelector('.top-meta');
      const mb = meta.getBoundingClientRect();
      const out = [];
      for (const el of meta.children) {
        const b = el.getBoundingClientRect();
        const visibleW = Math.max(0, Math.min(b.right, mb.right) - Math.max(b.left, mb.left));
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        const hit = cx >= 0 && cx < innerWidth ? document.elementFromPoint(cx, cy) : null;
        out.push({ id: el.id || el.className, w: Math.round(b.width), visibleW: Math.round(visibleW),
                   clickable: !!(hit && (hit === el || el.contains(hit))) });
      }
      return { metaW: Math.round(mb.width), content: meta.scrollWidth, out,
               clockText: document.getElementById('tourney-clock').textContent };
    });
    console.log(`${label} w=${w}: .top-meta box=${m.metaW}px content=${m.content}px`);
    for (const c of m.out) {
      if (c.w === 0) continue;
      console.log(`    ${c.id}: natural=${c.w}px visible=${c.visibleW}px clickable=${c.clickable}`);
    }
    await ctx.close();
  }
}
await browser.close(); httpServer.close(); process.exit(0);
