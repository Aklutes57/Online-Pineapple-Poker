import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-tb2-')), 'test.db');
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
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }

for (const [w, withAccount] of [[1920, true], [1512, true], [1366, true], [1366, false], [1920, false]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(([tok, gid]) => localStorage.setItem(`pp:token:${gid}`, tok), [created.token, created.gameId]);
  await page.goto(`${base}/games/${created.gameId}`);
  await page.waitForSelector('#top-bar');
  await page.waitForTimeout(700);
  if (withAccount) await page.evaluate(() => {
    const a = document.getElementById('account-chip');
    a.classList.remove('hidden'); a.textContent = 'AydenLutes';
  });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const meta = document.querySelector('.top-meta');
    const mb = meta.getBoundingClientRect();
    const row = [];
    for (const el of meta.children) {
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const hit = document.elementFromPoint(Math.max(0, Math.min(cx, innerWidth - 1)), cy);
      row.push({
        id: el.id || el.className,
        x: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width),
        beyondMeta: b.right > mb.right + 0.5,
        hittable: !!(hit && (hit === el || el.contains(hit))),
      });
    }
    return {
      meta: { x: Math.round(mb.left), r: Math.round(mb.right), w: Math.round(mb.width),
              scrollW: meta.scrollWidth, clientW: meta.clientWidth,
              overflow: getComputedStyle(meta).overflow },
      row,
    };
  });
  console.log(`\n--- viewport ${w}px, accountChip=${withAccount} ---`);
  console.log(`  .top-meta box ${m.meta.x}..${m.meta.r} (w=${m.meta.w}) content=${m.meta.scrollW}px overflow=${m.meta.overflow}`);
  for (const c of m.row) console.log(`    ${c.id}: ${c.x}..${c.r} w=${c.w} beyondMetaBox=${c.beyondMeta} clickable=${c.hittable}`);
  await ctx.close();
}
await browser.close(); httpServer.close(); process.exit(0);
