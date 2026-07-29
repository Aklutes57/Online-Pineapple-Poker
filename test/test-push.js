// Web Push: VAPID persistence, subscription CRUD, and the turn/seat alert
// triggers driven through a real socket game with an injected fake sender.
// The load-bearing assertions: a connected player is never pushed, a turn is
// never pushed twice, dead subscriptions are pruned, and a failing push can
// never pause the table.
// Usage: node test/test-push.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-push-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');

const { io: ioc } = await import('socket.io-client');
const { buildServer } = await import('../server/app.js');
const { EVENTS, TIMINGS } = await import('../shared/constants.js');
const { initDb, closeDb, get } = await import('../server/db.js');
const push = await import('../server/push.js');

TIMINGS.NEXT_HAND_DELAY = 40;
TIMINGS.RUNOUT_STREET_DELAY = 5;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recording fake sender — push must never hit the network in tests.
let sent = [];
let sendBehavior = null; // optional per-call error injector
push._setSenderForTests(async (subscription, payload) => {
  if (sendBehavior) {
    const err = sendBehavior;
    throw err;
  }
  sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
});

// ---- VAPID persistence ----

initDb();
const key1 = push.ensureVapid().publicKey;
check('vapid key generated', typeof key1 === 'string' && key1.length > 80);
closeDb();
push._resetForTests();
initDb();
check('vapid key survives a database reopen', push.ensureVapid().publicKey === key1);

// ---- subscription validation ----

const GOOD_SUB = {
  endpoint: 'https://push.example/sub/abc123',
  keys: { p256dh: 'BPtESTkey_123-abc', auth: 'authTOKEN_45-6' },
};
check('valid subscription saves', push.saveSubscription(GOOD_SUB).ok === true);
check('http endpoint rejected', push.saveSubscription({
  endpoint: 'http://push.example/x', keys: GOOD_SUB.keys,
}).ok === false);
check('missing keys rejected', push.saveSubscription({ endpoint: 'https://push.example/y' }).ok === false);
check('oversized endpoint rejected', push.saveSubscription({
  endpoint: 'https://push.example/' + 'x'.repeat(2000), keys: GOOD_SUB.keys,
}).ok === false);
check('garbage keys rejected', push.saveSubscription({
  endpoint: 'https://push.example/z', keys: { p256dh: 'has spaces!!', auth: 'ok' },
}).ok === false);

const firstRow = push.getSubscription(GOOD_SUB.endpoint);
push.saveSubscription({ ...GOOD_SUB, keys: { p256dh: 'BnewKEY', auth: 'newAUTH' } });
const updated = push.getSubscription(GOOD_SUB.endpoint);
check('re-subscribe upserts keys', JSON.parse(updated.keys_json).p256dh === 'BnewKEY');
check('re-subscribe keeps created_at', updated.created_at === firstRow.created_at);
push.deleteSubscription(GOOD_SUB.endpoint);
check('unsubscribe deletes', push.getSubscription(GOOD_SUB.endpoint) === null);

// ---- live game triggers ----

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const url = `http://localhost:${httpServer.address().port}`;

// HTTP subscribe path (what the browser does).
const subRes = await fetch(`${url}/api/push/subscribe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(GOOD_SUB),
});
check('HTTP subscribe works', subRes.ok);
const badRes = await fetch(`${url}/api/push/subscribe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ endpoint: 'http://evil', keys: {} }),
});
check('HTTP subscribe rejects garbage', badRes.status === 400);
const vapidRes = await fetch(`${url}/api/push/vapid-key`).then((r) => r.json());
check('vapid key served over HTTP', vapidRes.key === key1);
check('healthz responds', (await fetch(`${url}/healthz`)).ok);

const created = await fetch(`${url}/api/games`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'host', settings: { smallBlind: 1, bigBlind: 2 } }),
}).then((r) => r.json());
const gameId = created.gameId;

function connect(name, { token = null, pushEndpoint = null } = {}) {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { transports: ['websocket'] });
    s.on('connect', () => {
      s.emit(EVENTS.JOIN, { gameId, token, nickname: name, pushEndpoint }, (r) => {
        if (!r?.ok) reject(new Error(`join failed for ${name}`));
        else resolve({ socket: s, token: r.token, playerId: r.playerId, state: r.state });
      });
    });
  });
}

// Host + guest, guest registered for push via the JOIN payload.
const host = await connect('host', { token: created.token });
const guest = await connect('guest', { pushEndpoint: GOOD_SUB.endpoint });

host.socket.emit(EVENTS.REQUEST_SEAT, { nickname: 'host', buyIn: 200 });
guest.socket.emit(EVENTS.REQUEST_SEAT, { nickname: 'guest', buyIn: 200 });
await sleep(200);
const reqState = await new Promise((resolve) => {
  host.socket.emit(EVENTS.JOIN, { gameId, token: host.token }, (r) => resolve(r.state));
});
for (const req of reqState.seatRequests) {
  host.socket.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: req.playerId, approve: true });
}
await sleep(200);
host.socket.emit(EVENTS.HOST_START_GAME, {});
await sleep(300);

check('no push while everyone is connected', sent.length === 0);

// Guest vanishes; when the action reaches them, exactly one push fires.
guest.socket.disconnect();
await sleep(100);

// Play until it's the guest's turn: host acts whenever it can.
let hostState = null;
host.socket.on(EVENTS.STATE, (s) => {
  hostState = s;
  if (s.you?.availableActions) {
    const av = s.you.availableActions;
    host.socket.emit(EVENTS.ACTION, {
      handId: s.hand.handId,
      action: av.canCheck ? 'check' : 'call',
    });
  }
});
// Kick a fresh state so the loop starts.
host.socket.emit(EVENTS.JOIN, { gameId, token: host.token }, () => {});
await sleep(1200);

check('disconnected player got a turn push', sent.length >= 1);
check('turn push carries the table URL', sent[0]?.payload.url === `/games/${gameId}`);
check('turn push is typed', sent[0]?.payload.type === 'turn');
const sentAfterTurn = sent.length;

// A reconnect re-arm must not re-push the same decision.
const guest2 = await connect('guest', { token: guest.token });
guest2.socket.disconnect();
await sleep(300);
check('re-arming the same turn does not re-push', sent.length === sentAfterTurn);

// ---- dead subscription cleanup, and the hand survives failures ----

sent = [];
sendBehavior = Object.assign(new Error('gone'), { statusCode: 410 });
// Trigger another notify by nudging the flow: reconnect + disconnect to re-arm
// is deduped, so instead push directly through the module against the game.
push.notifyTurn({ id: gameId, settings: { smallBlind: 1, bigBlind: 2, variant: 'holdem' } }, {
  pushEndpoint: GOOD_SUB.endpoint,
  accountId: null,
  nickname: 'guest',
});
await sleep(100);
check('410 prunes the subscription', push.getSubscription(GOOD_SUB.endpoint) === null);

push.saveSubscription(GOOD_SUB);
sendBehavior = Object.assign(new Error('flaky'), { statusCode: 500 });
push.notifyTurn({ id: gameId, settings: { smallBlind: 1, bigBlind: 2, variant: 'holdem' } }, {
  pushEndpoint: GOOD_SUB.endpoint,
  accountId: null,
  nickname: 'guest',
});
await sleep(100);
check('transient failure keeps the subscription', push.getSubscription(GOOD_SUB.endpoint) !== null);
sendBehavior = null;

// The game shrugged all of this off.
const finalState = await new Promise((resolve) => {
  host.socket.emit(EVENTS.JOIN, { gameId, token: host.token }, (r) => resolve(r.state));
});
check('game still running after push failures', finalState.status === 'running');

// A player with no endpoint and no account is a free no-op.
sent = [];
push.notifyTurn({ id: gameId, settings: { smallBlind: 1, bigBlind: 2, variant: 'holdem' } }, {
  pushEndpoint: null, accountId: null, nickname: 'nobody',
});
await sleep(50);
check('no-subscription player sends nothing', sent.length === 0);

host.socket.disconnect();
guest2.socket.disconnect();
await new Promise((r) => httpServer.close(r));
closeDb();
rmSync(dir, { recursive: true, force: true });

console.log(`push: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
