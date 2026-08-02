// End-to-end WebRTC: two real browsers with fake camera/mic join a table, turn
// on Video, and must each see the OTHER's live webcam stream. Temp verifier.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-media-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;

const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'Host', settings: {} }),
}).then((r) => r.json());

const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
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

const host = await page('host', created.token, 'Host');
await host.click('.empty-seat-btn');
await host.click('#j-request');
await host.waitForSelector('.seat.me .nameplate');

const guest = await page('guest', null, 'Guest');
await guest.click('[data-act="open-join"]');
await guest.fill('#j-nickname', 'Guest');
await guest.click('#j-request');
// Host approves.
await host.waitForSelector('#seat-requests button[data-approve="yes"]');
await host.locator('#seat-requests button[data-approve="yes"]').first().click();
await guest.waitForSelector('.seat.me .nameplate');

// Both turn on Video.
await host.waitForSelector('#av-join:not(.hidden)');
await host.click('#av-join');
await guest.waitForSelector('#av-join:not(.hidden)');
await guest.click('#av-join');

// Give ICE time to connect and frames to flow.
async function remoteLive(p) {
  return p.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const vids = [...document.querySelectorAll('#seats-layer video.seat-cam')];
      const remote = vids.find((v) => !v.classList.contains('mine') && v.videoWidth > 0);
      const mineOk = vids.some((v) => v.classList.contains('mine') && v.videoWidth > 0);
      if (remote && mineOk) return { ok: true, count: vids.length, remoteW: remote.videoWidth };
      await new Promise((r) => setTimeout(r, 500));
    }
    const vids = [...document.querySelectorAll('#seats-layer video.seat-cam')];
    return { ok: false, count: vids.length, widths: vids.map((v) => v.videoWidth) };
  });
}

const h = await remoteLive(host);
const g = await remoteLive(guest);
console.log('host sees:', JSON.stringify(h));
console.log('guest sees:', JSON.stringify(g));
const pass = h.ok && g.ok;
console.log(pass ? 'MEDIA: peer-to-peer webcam is flowing both ways' : 'MEDIA: FAILED to establish two-way video');

await browser.close();
await new Promise((r) => httpServer.close(r));
process.exit(pass ? 0 : 1);
