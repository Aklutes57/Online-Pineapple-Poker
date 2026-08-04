// Host controls: whoever creates a table can run it (no account required), a
// dropped host passes to a seated player, and the creator reclaims host the
// moment they return. Regression cover for "my friend couldn't accept players".
// Usage: node test/test-host.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-host-')), 'test.db');

const { io: ioc } = await import('socket.io-client');
const { Game } = await import('../server/game.js');
const { createGame } = await import('../server/gameManager.js');
const { buildServer } = await import('../server/app.js');
const { EVENTS } = await import('../shared/constants.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}

// ---- Game-level: creator tracking, transfer, and reclaim ----
{
  const { game, host } = createGame({}, 'FriendHost', null);
  check('the creator is recorded and is the host', game.creatorId === host.id && game.hostId === host.id);

  const ann = game.addPlayer('Ann', null);
  host.connected = true;
  ann.connected = true;
  ann.status = 'seated';

  // A connected host is never transferred away.
  game.maybeTransferHost();
  check('a connected host keeps host', game.hostId === host.id);

  // Host drops → host passes to the seated player.
  host.connected = false;
  game.maybeTransferHost();
  check('a dropped host passes to a seated player', game.hostId === ann.id);
  check('the creator id does not change on transfer', game.creatorId === host.id);

  // A non-creator returning does NOT steal host back.
  const bob = game.addPlayer('Bob', null);
  bob.connected = true;
  check('a non-creator cannot reclaim host', game.reclaimHostIfCreator(bob) === false && game.hostId === ann.id);

  // The creator returns → host snaps back to them.
  host.connected = true;
  const reclaimed = game.reclaimHostIfCreator(host);
  check('the returning creator reclaims host', reclaimed === true && game.hostId === host.id);

  // Idempotent: reclaiming while already host is a no-op.
  check('reclaim is a no-op when already host', game.reclaimHostIfCreator(host) === false);
}

// ---- socket-level: a GUEST host can accept players AFTER starting the game ----
{
  const { httpServer } = buildServer();
  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;

  const created = await fetch(`${url}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'GuestHost', settings: {} }),
  }).then((r) => r.json());

  function connect(token, nickname) {
    return new Promise((resolve, reject) => {
      const s = ioc(url, { transports: ['websocket'], extraHeaders: { Origin: url }, reconnection: false });
      s.on('connect', () => s.emit(EVENTS.JOIN, { gameId: created.gameId, token, nickname }, (res) => {
        res?.ok ? resolve({ s, res }) : reject(new Error('join failed'));
      }));
      s.on('connect_error', reject);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stateOf = (h) => new Promise((r) => h.s.emit(EVENTS.JOIN, { gameId: created.gameId, token: h.res.token }, (res) => r(res.state)));

  const host = await connect(created.token, 'GuestHost'); // no account token anywhere
  check('a guest host is the host (no account needed)', host.res.state.you.isHost === true);

  host.s.emit(EVENTS.REQUEST_SEAT, { nickname: 'GuestHost', buyIn: 200 });
  const bob = await connect(null, 'Bob');
  bob.s.emit(EVENTS.REQUEST_SEAT, { nickname: 'Bob', buyIn: 200 });
  await wait(150);
  host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: bob.res.playerId, approve: true });
  await wait(150);
  host.s.emit(EVENTS.HOST_START_GAME, {});
  await wait(250);

  // Someone joins AFTER the start.
  const carol = await connect(null, 'Carol');
  carol.s.emit(EVENTS.REQUEST_SEAT, { nickname: 'Carol', buyIn: 200 });
  await wait(200);

  const afterStart = await stateOf(host);
  check('the host still holds host after starting', afterStart.you.isHost === true);
  check('the post-start request reaches the host', afterStart.seatRequests.some((r) => r.nickname === 'Carol'));
  check('state carries hostName for the change toast', afterStart.hostName === 'GuestHost');

  host.s.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: carol.res.playerId, approve: true });
  await wait(200);
  const seated = (await stateOf(host)).seats.some((s) => s && s.nickname === 'Carol');
  check('the guest host successfully accepts a player after start', seated);

  host.s.close(); bob.s.close(); carol.s.close();
  await new Promise((r) => httpServer.close(r));
}

// ---- busted players: never dealt in, and can re-buy or leave ----
{
  const { game, host } = createGame({}, 'Host', null);
  const broke = game.addPlayer('Broke', null);
  const rich = game.addPlayer('Rich', null);
  for (const [p, seat, stack] of [[host, 0, 200], [rich, 2, 200]]) {
    p.connected = true;
    p.status = 'seated';
    p.seatIndex = seat;
    p.stack = stack;
    game.seats[seat] = p.id;
  }
  // Broke goes in through the real door — request, host approves — because the
  // "no second approval" rule keys off having been approved once.
  broke.connected = true;
  game.requestSeat(broke, 200, 1);
  game.approveSeat(broke.id, true);
  check('everyone with chips is dealt in', game.eligiblePlayers().length === 3);

  broke.stack = 0;
  const dealtIn = game.eligiblePlayers();
  check('a player with no chips is not dealt into the hand',
    !dealtIn.some((p) => p.id === broke.id) && dealtIn.length === 2);

  // Re-buy puts them back in, within the table's buy-in limits.
  const tooSmall = game.rebuy(broke, game.settings.minBuyIn - 1);
  check('a re-buy under the table minimum is refused', tooSmall.ok === false);
  const tooBig = game.rebuy(broke, game.settings.maxBuyIn + 1);
  check('a re-buy over the table maximum is refused', tooBig.ok === false);

  const ok = game.rebuy(broke, 200);
  check('a re-buy is accepted', ok.ok === true && broke.stack === 200);
  check('re-buying deals them back in', game.eligiblePlayers().some((p) => p.id === broke.id));
  check('the re-buy lands on the ledger next to the first buy-in',
    game.ledgerRows().find((r) => r.playerId === broke.id)?.buyIns === 400);

  // Or they can just leave the seat instead.
  broke.stack = 0;
  const left = game.removeFromSeat(broke, 'leave');
  check('a busted player can stand up instead', left.ok === true && broke.status !== 'seated');
  check('standing up frees the seat', game.seats[1] === null);

  // …and sitting back down does NOT go back through the host: the host let
  // them in once, and that holds for the rest of the session.
  const back = game.requestSeat(broke, 200);
  check('buying back in after standing up needs no host approval',
    back.ok === true && broke.status === 'seated' && broke.stack === 200);
  check('the buy-back-in is on the ledger too',
    game.ledgerRows().find((r) => r.playerId === broke.id)?.buyIns === 600);
  check('an auto-seated player never shows up in the host queue',
    [...game.players.values()].every((p) => p.status !== 'requesting'));
}

// ---- a first-timer still waits, and a kicked player does not walk back in ----
{
  const { game, host } = createGame({}, 'Host', null);
  host.connected = true;
  host.status = 'seated';
  host.seatIndex = 0;
  host.stack = 200;
  game.seats[0] = host.id;

  const newcomer = game.addPlayer('Newcomer', null);
  newcomer.connected = true;
  const first = game.requestSeat(newcomer, 200);
  check('a first-timer still waits for the host',
    first.ok === true && newcomer.status === 'requesting');
  game.approveSeat(newcomer.id, true);
  check('the host can still approve a first-timer', newcomer.status === 'seated');

  const troublemaker = game.addPlayer('Troublemaker', null);
  troublemaker.connected = true;
  game.requestSeat(troublemaker, 200);
  game.approveSeat(troublemaker.id, true);
  check('the kicked player was seated first', troublemaker.status === 'seated');
  game.removeFromSeat(troublemaker, 'kick');
  check('a kick unseats them', troublemaker.status === 'spectating');
  const sneak = game.requestSeat(troublemaker, 200);
  check('a kicked player goes back through the host',
    sneak.ok === true && troublemaker.status === 'requesting');
  check('a kicked player is not auto-seated', troublemaker.seatIndex === null);
}

// ---- any player at the table can put a picture on the felt ----
{
  const { game, host } = createGame({}, 'Host', null);
  const guest = game.addPlayer('Guest', null); // no account at all
  guest.connected = true;

  const bad = game.setTableImage(guest, 'https://evil.example/x.png');
  check('an off-site image URL is refused', bad.ok === false);

  const good = game.setTableImage(guest, '/uploads/abc.png');
  check('a guest can set the table picture', good.ok === true);
  check('the picture applies to the whole table',
    game.settings.tableTheme.feltImage === '/uploads/abc.png');

  const stranger = { id: 'not-here', nickname: 'Nobody' };
  check('someone not at the table cannot change it',
    game.setTableImage(stranger, '/uploads/x.png').ok === false);
  void host;
}

console.log(`host: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
