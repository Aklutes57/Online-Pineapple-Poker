// Audio behaviour at the table: the turn cue, and what the music player costs
// a page that never uses it.
//
// The turn cue is guarded because its failure mode is silence:
// the chime was written, wired and correct, and never once played, because the
// audio context it ran on had never been opened by a user gesture and browsers
// reject resume() from anywhere else. Nothing threw; the table was just quiet.
// Usage: node test/sound.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-snd-')), 'test.db');

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
const { tokenFor } = await import('./helpers/account.js');

const hostAccount = await tokenFor('Host');
const created = await fetch(`${base}/api/games`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostAccount}` },
  body: JSON.stringify({ nickname: 'Host', settings: {} }),
}).then((r) => r.json());

async function sock(token, nick, seat) {
  // The creator's seat token only works for the creator's account.
  const accountToken = nick === 'Host' ? hostAccount : await tokenFor(nick);
  return new Promise((res) => {
    const s = ioc(base, { transports: ['websocket'], extraHeaders: { Origin: base }, reconnection: false });
    s.on('connect', () => s.emit(EVENTS.JOIN, { gameId: created.gameId, token, nickname: nick, accountToken }, (r) => {
      s.emit(EVENTS.REQUEST_SEAT, { nickname: nick, buyIn: 200, seatIndex: seat });
      res({ s, r });
    }));
  });
}
const host = await sock(created.token, 'Host', 0);
const other = await sock(null, 'P1', 1);
await new Promise((r) => setTimeout(r, 300));
host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: other.r.playerId, approve: true });
await new Promise((r) => setTimeout(r, 300));

let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log(`  pageerror: ${e.message}`); bad++; });

// Everything the page asks the outside world for. A table where nobody has
// queued music must not reach YouTube at all — it used to, on every page load,
// for every player, because the player was built at boot.
const offsite = [];
page.on('request', (r) => {
  const host = new URL(r.url()).hostname;
  if (!host.includes('localhost') && host !== '127.0.0.1') offsite.push(host);
});
// Never actually let it out: this machine may have no route to YouTube, and
// the point is to observe the attempt, not to wait for it.
await page.route('**://*.youtube.com/**', (r) => r.abort());
await page.route('**://*.ytimg.com/**', (r) => r.abort());
await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
  [`pp:${created.gameId}`, JSON.stringify({ token: created.token, nickname: 'Host' })]);
await page.addInitScript((t) => localStorage.setItem('pp:account', t), hostAccount);
await page.goto(`${base}/games/${created.gameId}`);
await page.waitForSelector('#table');
await page.waitForTimeout(400);

// The bug, stated directly: before anyone touches the page there is no audio
// context at all, so a cue arriving on a websocket update has nothing to play
// through. This assertion is the one that fails if the unlock is removed.
const before = await page.evaluate(() => window.__audioState?.() ?? 'missing');
check(`no audio context before a gesture (${before})`, before === 'none');

// A real click is the only thing a browser accepts as permission.
await page.mouse.click(640, 400);
await page.waitForTimeout(400);
const after = await page.evaluate(() => window.__audioState?.() ?? 'missing');
check(`a gesture opens it (${after})`, after === 'running');

// And it stays open, so every later cue — which all arrive on socket updates,
// never on a click — has somewhere to play.
await page.waitForTimeout(500);
const later = await page.evaluate(() => window.__audioState?.() ?? 'missing');
check(`it stays open for the cues that follow (${later})`, later === 'running');

// The toggle is itself a gesture and plays the cue it just enabled, so a
// player can tell the setting did something.
const toggled = await page.evaluate(() => {
  const btn = document.getElementById('sound-toggle');
  return !!btn;
});
check('there is a sound toggle to confirm with', toggled);

// ---- what an unused music player costs ----
check(`a table with no music asks nothing of youtube (${offsite.join(',') || 'nothing offsite'})`,
  !offsite.some((h) => h.endsWith('youtube.com') || h.endsWith('ytimg.com')));

// …and the moment somebody queues something, it loads.
host.s.emit(EVENTS.MUSIC_ADD, { url: 'https://youtu.be/dQw4w9WgXcQ' });
await page.waitForTimeout(1500);
check('queueing a track is what pulls YouTube in',
  offsite.some((h) => h.endsWith('youtube.com')));

await browser.close();
for (const o of [host, other]) o.s.disconnect();
await new Promise((r) => httpServer.close(r));
console.log(bad === 0 ? 'SOUND: all good' : `SOUND: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
