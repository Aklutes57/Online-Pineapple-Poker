// WebRTC voice/video: the server is a pure signalling relay. It must pass the
// handshake to the right co-player, keep it inside the game, never leak across
// tables, and advertise A/V presence. (The peer-to-peer media itself is a
// browser concern, exercised in the UI smoke test.)
// Usage: node test/test-webrtc.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-rtc-')), 'test.db');

const { io: ioc } = await import('socket.io-client');
const { buildServer } = await import('../server/app.js');
const { EVENTS } = await import('../shared/constants.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const url = `http://localhost:${httpServer.address().port}`;

// ---- ICE config + CSP ----
{
  const cfg = await fetch(`${url}/api/rtc-config`).then((r) => r.json());
  check('rtc-config serves STUN servers', Array.isArray(cfg.iceServers)
    && JSON.stringify(cfg.iceServers).includes('stun:stun.l.google.com'));

  const headers = (await fetch(`${url}/`)).headers;
  const csp = headers.get('content-security-policy') || '';
  check('CSP connect-src allows the stun/turn schemes', /connect-src[^;]*stun:[^;]*turn:/.test(csp));
  check('Permissions-Policy allows camera + mic for this origin',
    /camera=\(self\)/.test(headers.get('permissions-policy') || '')
    && /microphone=\(self\)/.test(headers.get('permissions-policy') || ''));

  // A configured TURN relay shows up in the ICE config (env read live).
  process.env.TURN_URL = 'turn:turn.example.com:3478';
  process.env.TURN_USERNAME = 'u';
  process.env.TURN_CREDENTIAL = 'p';
  const cfg2 = await fetch(`${url}/api/rtc-config`).then((r) => r.json());
  check('a configured TURN relay is advertised',
    JSON.stringify(cfg2.iceServers).includes('turn:turn.example.com:3478'));
  delete process.env.TURN_URL; delete process.env.TURN_USERNAME; delete process.env.TURN_CREDENTIAL;
}

async function makeGame(nick) {
  return fetch(`${url}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: nick, settings: {} }),
  }).then((r) => r.json());
}
function connect(gameId, token, nick) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { transports: ['websocket'], extraHeaders: { Origin: url }, reconnection: false });
    const signals = [];
    let state = null;
    s.on(EVENTS.RTC_SIGNAL, (m) => signals.push(m));
    s.on(EVENTS.STATE, (st) => { state = st; });
    s.on('connect', () => s.emit(EVENTS.JOIN, { gameId, token, nickname: nick }, (r) => {
      r?.ok ? resolve({ s, res: r, signals, get state() { return state; } }) : reject(new Error('join failed'));
    }));
    s.on('connect_error', reject);
  });
}

// ---- signalling relay within a game ----
const g1 = await makeGame('Alice');
const alice = await connect(g1.gameId, g1.token, 'Alice');
const bob = await connect(g1.gameId, null, 'Bob');
await wait(100);

alice.s.emit(EVENTS.RTC_SIGNAL, { to: bob.res.playerId, data: { sdp: { type: 'offer', sdp: 'x' } } });
await wait(150);
check('a signal is relayed to the target co-player',
  bob.signals.length === 1 && bob.signals[0].from === alice.res.playerId && bob.signals[0].data.sdp.type === 'offer');
check('the sender does not receive its own signal', alice.signals.length === 0);

// Bob answers back.
bob.s.emit(EVENTS.RTC_SIGNAL, { to: alice.res.playerId, data: { sdp: { type: 'answer', sdp: 'y' } } });
await wait(150);
check('the answer is relayed back', alice.signals.length === 1 && alice.signals[0].data.sdp.type === 'answer');

// A signal to a non-existent player is silently dropped (no crash).
alice.s.emit(EVENTS.RTC_SIGNAL, { to: 'nobody', data: { sdp: {} } });
await wait(100);
check('server survives a signal to an unknown target',
  await fetch(`${url}/healthz`).then((r) => r.ok).catch(() => false));

// ---- A/V presence in the game state ----
alice.s.emit(EVENTS.RTC_MEDIA, { on: true });
await wait(150);
const seatAlice = bob.state?.seats?.find((s) => s && s.playerId === alice.res.playerId);
// Alice is not seated, so she's not in seats; presence shows once seated.
alice.s.emit(EVENTS.REQUEST_SEAT, { nickname: 'Alice', buyIn: 200 });
await wait(150);
alice.s.emit(EVENTS.RTC_MEDIA, { on: true });
await wait(150);
const seated = bob.state?.seats?.find((s) => s && s.playerId === alice.res.playerId);
check('a seated player who joined A/V shows mediaOn to others', seated?.mediaOn === true);
alice.s.emit(EVENTS.RTC_MEDIA, { on: false });
await wait(150);
const after = bob.state?.seats?.find((s) => s && s.playerId === alice.res.playerId);
check('leaving A/V clears mediaOn', after?.mediaOn === false);

// ---- profile pictures ----
const GOOD_AVATAR = `/uploads/${'a'.repeat(64)}.png`;
alice.s.emit(EVENTS.SET_AVATAR, { url: GOOD_AVATAR });
await wait(150);
const withPic = bob.state?.seats?.find((s) => s && s.playerId === alice.res.playerId);
check('a profile picture reaches every client at the table', withPic?.avatarUrl === GOOD_AVATAR);

for (const bad of ['https://evil.example/x.png', '/uploads/../../etc/passwd', '/uploads/nothex.png', 42, { nested: 1 }]) {
  alice.s.emit(EVENTS.SET_AVATAR, { url: bad });
}
await wait(200);
const stillGood = bob.state?.seats?.find((s) => s && s.playerId === alice.res.playerId);
check('an off-site or malformed picture URL is refused', stillGood?.avatarUrl === GOOD_AVATAR);

alice.s.emit(EVENTS.SET_AVATAR, { url: '' });
await wait(150);
const cleared = bob.state?.seats?.find((s) => s && s.playerId === alice.res.playerId);
check('a player can clear their picture', cleared?.avatarUrl === null);

// ---- cross-table isolation ----
const g2 = await makeGame('Carol');
const carol = await connect(g2.gameId, g2.token, 'Carol');
await wait(100);
alice.s.emit(EVENTS.RTC_SIGNAL, { to: carol.res.playerId, data: { sdp: { type: 'offer' } } });
await wait(150);
check('a signal never crosses to a player in another game', carol.signals.length === 0);

alice.s.close(); bob.s.close(); carol.s.close();
console.log(`webrtc: ${passes} passed, ${failures} failed`);
await new Promise((r) => httpServer.close(r));
process.exit(failures ? 1 : 0);
