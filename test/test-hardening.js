// Regression tests for protocol hardening: malformed payloads from clients
// must never crash the server, and abuse paths must be rejected cleanly.
// Usage: node test/test-hardening.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-hard-')), 'test.db');

const { io: ioc } = await import('socket.io-client');
const { buildServer } = await import('../server/app.js');
const { EVENTS } = await import('../shared/constants.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const port = httpServer.address().port;
const url = `http://localhost:${port}`;

const createRes = await fetch(`${url}/api/games`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'host', settings: {} }),
});
const { gameId, token } = await createRes.json();

function connect(name, tok) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { transports: ['websocket'] });
    const errors = [];
    s.on(EVENTS.ERROR_MSG, (e) => errors.push(e));
    s.on('connect', () => {
      s.emit(EVENTS.JOIN, { gameId, token: tok, nickname: name }, (r) => {
        if (!r?.ok) reject(new Error(`join failed for ${name}`));
        else resolve({ socket: s, errors, res: r });
      });
    });
  });
}

const host = await connect('host', token);
const guest = await connect('guest', null);

// ---- malformed payloads on every guarded event must not crash the server ----

const eventNames = [
  EVENTS.REQUEST_SEAT, EVENTS.CANCEL_SEAT_REQUEST, EVENTS.ACTION, EVENTS.DISCARD,
  EVENTS.SHOW_CARDS, EVENTS.SIT_OUT, EVENTS.SIT_IN, EVENTS.STAND_UP, EVENTS.CHAT,
  EVENTS.HOST_APPROVE_SEAT, EVENTS.HOST_START_GAME, EVENTS.HOST_PAUSE,
  EVENTS.HOST_KICK, EVENTS.HOST_ADJUST_STACK, EVENTS.HOST_UPDATE_SETTINGS,
];
const badPayloads = [null, undefined, 'a string', 42, [1, 2, 3], { __proto__: { evil: 1 } }];
for (const event of eventNames) {
  for (const payload of badPayloads) {
    guest.socket.emit(event, payload);
    host.socket.emit(event, payload);
  }
}
await new Promise((r) => setTimeout(r, 400));

const alive = await fetch(`${url}/api/games/${gameId}`).then((r) => r.ok).catch(() => false);
check('server survives malformed payloads on every event', alive);
check('prototype pollution attempt did not stick', {}.evil === undefined);

// ---- garbage push endpoints in JOIN are ignored, never fatal ----

for (const bad of [42, 'javascript:alert(1)', 'x'.repeat(50000), {}, [], 'http://not-https']) {
  await new Promise((resolve) => {
    guest.socket.emit(EVENTS.JOIN, { gameId, token: guest.res.token, pushEndpoint: bad }, () => resolve());
  });
}
check('server survives garbage pushEndpoint values',
  await fetch(`${url}/api/games/${gameId}`).then((r) => r.ok).catch(() => false));

// ---- garbage bodies to the push endpoints get 400s, not crashes ----

for (const body of [null, [], 'str', { endpoint: 'http://evil', keys: {} }, { endpoint: 'https://x', keys: { p256dh: '!!', auth: '' } }]) {
  const res = await fetch(`${url}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 400) {
    check(`push subscribe rejects ${JSON.stringify(body)?.slice(0, 40)}`, false);
  }
}
check('push subscribe rejects garbage bodies', true);
check('server alive after push endpoint abuse',
  await fetch(`${url}/healthz`).then((r) => r.ok).catch(() => false));

// ---- invalid buy-ins are rejected, valid one works ----

guest.socket.emit(EVENTS.REQUEST_SEAT, { nickname: 'guest', buyIn: -50 });
guest.socket.emit(EVENTS.REQUEST_SEAT, { nickname: 'guest', buyIn: 3.5 });
guest.socket.emit(EVENTS.REQUEST_SEAT, { nickname: 'guest', buyIn: 1e15 });
await new Promise((r) => setTimeout(r, 200));
check('bad buy-ins rejected with errors', guest.errors.length >= 3);

const stateAfter = await new Promise((resolve) => {
  guest.socket.emit(EVENTS.JOIN, { gameId, token: guest.res.token }, (r) => resolve(r.state));
});
check('bad buy-ins did not seat the guest', stateAfter.seats.every((s) => !s || s.nickname !== 'guest'));

// ---- non-host cannot use host controls ----

guest.socket.emit(EVENTS.HOST_ADJUST_STACK, { playerId: guest.res.playerId, delta: 100000 });
await new Promise((r) => setTimeout(r, 200));
const state2 = await new Promise((resolve) => {
  guest.socket.emit(EVENTS.JOIN, { gameId, token: guest.res.token }, (r) => resolve(r.state));
});
check('non-host cannot mint chips', state2.ledger.every((row) => row.buyIns <= 200));

// ---- re-JOIN on a bound socket must not leave a stale connected player ----

const rejoin = await new Promise((resolve) => {
  guest.socket.emit(EVENTS.JOIN, { gameId }, (r) => resolve(r)); // no token -> brand-new player
});
check('re-join without token creates a fresh identity', rejoin.playerId !== guest.res.playerId);
guest.socket.disconnect();
await new Promise((r) => setTimeout(r, 300));
const state3 = await new Promise((resolve) => {
  host.socket.emit(EVENTS.JOIN, { gameId, token }, (r) => resolve(r.state));
});
// After disconnect, no seat/nameplate should still claim the old guest is connected.
check(
  'no stale connected player after re-join + disconnect',
  state3.seats.every((s) => !s || s.nickname === 'host' || !s.connected)
);

console.log(`hardening: ${passes} passed, ${failures} failed`);
host.socket.disconnect();
await new Promise((r) => httpServer.close(r));
process.exit(failures ? 1 : 0);
