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

  // Re-buy puts them back in: the table minimum still holds, but there is
  // no ceiling — a home game tops up however deep it likes.
  const tooSmall = game.rebuy(broke, game.settings.minBuyIn - 1);
  check('a re-buy under the table minimum is refused', tooSmall.ok === false);

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

// ---- the re-buy offer waits for the hand to be completely over ----
{
  const { game, host } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  const { buildViews } = await import('../server/views.js');
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const eve = game.addPlayer('Eve', null);
  eve.connected = true;
  game.requestSeat(eve, 200, 1);
  if (eve.status === 'requesting') game.approveSeat(eve.id, true);
  game.status = 'running';
  game.startHand();
  check('a hand is live', game.currentHand && !game.currentHand.finished);

  // All-in: the stack hits zero while the hand is still running.
  eve.stack = 0;
  const during = buildViews(game).forPlayer(eve.id);
  check('no buy-in is offered while the hand is still being played',
    during.canRebuy === false);

  // The hand ends — now the offer appears.
  game.currentHand.finished = true;
  const after = buildViews(game).forPlayer(eve.id);
  check('the offer appears once the hand is completely over',
    after.canRebuy === true);
}

// ---- a queued carry-pot liquidation is never dropped, and "I'm back"
// cancels your own queued stand-up (but never a host kick) ----
{
  const { game, host } = createGame({ variant: '747' }, 'Host', null);
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const kim = game.addPlayer('Kim', null);
  kim.connected = true;
  game.requestSeat(kim, 200, 1);
  if (kim.status === 'requesting') game.approveSeat(kim.id, true);

  // The op has no playerId — it must survive the per-player guard.
  game.settings.variant = 'holdem';
  game.carryPot = 120;
  game.queueOp({ type: 'liquidateCarry' });
  const stacksBefore = host.stack + kim.stack;
  game.applyPendingOps();
  check('a queued carry liquidation actually runs at hand end',
    game.carryPot === 0 && host.stack + kim.stack === stacksBefore + 120);

  // A voluntary stand-up queued mid-hand is cancelled by "I'm back"…
  game.status = 'running';
  game.startHand();
  game.removeFromSeat(kim, 'leave');
  check('a mid-hand stand-up is queued, not immediate',
    kim.status === 'seated' && game.pendingOps.some((op) => op.type === 'unseat' && op.playerId === kim.id));
  const back = game.sitIn(kim);
  check('"I\'m back" cancels the queued stand-up',
    back.ok === true && !game.pendingOps.some((op) => op.type === 'unseat' && op.playerId === kim.id));
  game.currentHand.finished = true;
  game.applyPendingOps();
  check('the player keeps the seat after the hand', kim.status === 'seated');

  // …but a host kick is not the player's to undo.
  game.startHand();
  game.removeFromSeat(kim, 'kick');
  const denied = game.sitIn(kim);
  check('a queued kick cannot be cancelled by the player',
    denied.ok === false && game.pendingOps.some((op) => op.type === 'unseat' && op.playerId === kim.id));
}

// ---- straddling is each player's own choice, and re-buys have no ceiling ----
{
  const { game, host } = createGame({ straddle: true, smallBlind: 1, bigBlind: 2 }, 'Host', null);
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const uma = game.addPlayer('Uma', null);
  const vic = game.addPlayer('Vic', null);
  for (const [p, seat] of [[uma, 1], [vic, 2]]) {
    p.connected = true;
    game.requestSeat(p, 200, seat);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  game.status = 'running';
  // Button starts somewhere; find the UTG (after the big blind) of the first
  // hand and opt them out BEFORE the deal.
  game.startHand();
  const firstStraddler = game.currentHand.straddleSeat;
  check('with the option on, UTG straddles by default', firstStraddler !== null);
  game.currentHand.finished = true;

  // Opt everyone out: no hand should post a straddle now.
  for (const p of [host, uma, vic]) {
    check('a seated player can set their straddle choice', game.setStraddle(p, false).ok === true);
  }
  game.startHand();
  check('an opted-out UTG plays a normal hand', game.currentHand.straddleSeat === null);
  game.currentHand.finished = true;

  // Re-buy: floor enforced, no ceiling.
  uma.stack = 0;
  check('a tiny re-buy is refused', game.rebuy(uma, 1).ok === false);
  check('a huge re-buy is welcome', game.rebuy(uma, 50000).ok === true);
  check('the whole amount landed', uma.stack === 50000);
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
