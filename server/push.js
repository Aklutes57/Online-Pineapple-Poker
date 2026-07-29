// Web Push: VAPID key management, subscriptions, and the two table alerts
// ("it's your turn", "your seat was approved").
//
// Two disciplines matter here:
//  - VAPID keys are generated lazily on first use and persisted in
//    server_config, so boot (and the test suites that boot many servers in
//    one process) pays no crypto cost and no manual key setup ever happens.
//  - Sends are strictly fire-and-forget on a later tick. notifyTurn is called
//    from inside the hand loop, whose error handling voids hands — a push
//    failure must never be able to reach it.

import webpush from 'web-push';
import { run, get, all, now } from './db.js';

let vapid = null;
let sender = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options);

// Tests inject a fake so no network or real crypto is involved.
export function _setSenderForTests(fn) {
  sender = fn;
}

export function ensureVapid() {
  if (vapid) return vapid;
  const row = get("SELECT value_json FROM server_config WHERE key = 'vapid'");
  if (row) {
    vapid = JSON.parse(row.value_json);
  } else {
    vapid = webpush.generateVAPIDKeys();
    run(
      "INSERT INTO server_config (key, value_json, updated_at) VALUES ('vapid', ?, ?)",
      JSON.stringify(vapid), now()
    );
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    vapid.publicKey,
    vapid.privateKey
  );
  return vapid;
}

// Module state resets with the DB in tests.
export function _resetForTests() {
  vapid = null;
}

// ---- subscriptions ----

const B64URL = /^[A-Za-z0-9_-]+$/;

export function saveSubscription({ endpoint, keys }, accountId = null) {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length > 1024 ||
    !endpoint.startsWith('https://')
  ) {
    return { ok: false, error: 'bad subscription endpoint' };
  }
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (
    typeof p256dh !== 'string' || p256dh.length > 256 || !B64URL.test(p256dh.replace(/=+$/, '')) ||
    typeof auth !== 'string' || auth.length > 256 || !B64URL.test(auth.replace(/=+$/, ''))
  ) {
    return { ok: false, error: 'bad subscription keys' };
  }
  const ts = now();
  run(
    `INSERT INTO push_subscriptions (endpoint, keys_json, account_id, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       keys_json = excluded.keys_json,
       account_id = COALESCE(excluded.account_id, push_subscriptions.account_id),
       last_seen = excluded.last_seen`,
    endpoint, JSON.stringify({ p256dh, auth }), accountId ?? null, ts, ts
  );
  return { ok: true };
}

export function deleteSubscription(endpoint) {
  if (typeof endpoint !== 'string') return { ok: false };
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  return { ok: true };
}

export function getSubscription(endpoint) {
  return get('SELECT * FROM push_subscriptions WHERE endpoint = ?', endpoint);
}

// Every device that should hear about this player: the endpoint their table
// client registered (works for guests) plus any devices tied to their
// account, deduped.
function targetsFor(player) {
  const rows = new Map();
  if (typeof player.pushEndpoint === 'string') {
    const row = getSubscription(player.pushEndpoint);
    if (row) rows.set(row.endpoint, row);
  }
  if (player.accountId) {
    for (const row of all(
      'SELECT * FROM push_subscriptions WHERE account_id = ?', player.accountId
    )) {
      rows.set(row.endpoint, row);
    }
  }
  return [...rows.values()];
}

// ---- delivery ----

async function deliver(row, payload, options) {
  const subscription = { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) };
  try {
    ensureVapid();
    await sender(subscription, JSON.stringify(payload), options);
    run('UPDATE push_subscriptions SET last_seen = ? WHERE endpoint = ?', now(), row.endpoint);
  } catch (err) {
    // A gone subscription is permanent — prune it. Anything else is
    // transient; keep the row and move on.
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      try {
        deleteSubscription(row.endpoint);
      } catch {
        /* pruning is best-effort */
      }
    }
  }
}

function fireAndForget(player, payload, options) {
  let targets;
  try {
    // Cheap early out: most players (all soak bots, most guests) have
    // neither an endpoint nor an account.
    if (!player.pushEndpoint && !player.accountId) return;
    targets = targetsFor(player);
  } catch {
    return; // push must never surface into the hand loop
  }
  if (!targets.length) return;
  setImmediate(() => {
    for (const row of targets) {
      deliver(row, payload, options).catch(() => {});
    }
  });
}

export function notifyTurn(game, player) {
  fireAndForget(
    player,
    {
      type: 'turn',
      title: "It's your turn",
      body: `The action is on you at ${game.settings.smallBlind}/${game.settings.bigBlind} ${game.settings.variant}.`,
      url: `/games/${game.id}`,
      tag: `turn-${game.id}`,
    },
    { TTL: 60, urgency: 'high' }
  );
}

export function notifySeatApproved(game, player) {
  fireAndForget(
    player,
    {
      type: 'seat',
      title: 'Your seat is ready',
      body: `${player.nickname}, you have a seat with ${player.stack} chips. The table is waiting.`,
      url: `/games/${game.id}`,
      tag: `seat-${game.id}`,
    },
    { TTL: 600 }
  );
}
