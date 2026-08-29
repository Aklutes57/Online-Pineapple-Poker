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
const { EVENTS, TIMINGS, rotatableVariants } = await import('../shared/constants.js');

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

// ---- an offline player's turn folds on the short disconnect clock ----
{
  const { game, host } = createGame({ actionTime: 0 }, 'Host', null);
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const pia = game.addPlayer('Pia', null);
  const quinn = game.addPlayer('Quinn', null);
  for (const [p, seat] of [[pia, 1], [quinn, 2]]) {
    p.connected = true;
    game.requestSeat(p, 200, seat);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  game.status = 'running';
  game.startHand();
  const hand = game.currentHand;
  check('untimed table: a present actor has no clock', game.timer === null || game.timer.name !== 'action');
  const actor = hand.bySeat.get(hand.toActSeat);
  actor.connected = false;
  game.nudgeCurrentTurn(actor); // what the disconnect handler does
  check('an offline actor lands on the disconnect clock',
    game.timer?.name === 'action'
    && game.timer.deadline - Date.now() <= TIMINGS.DISCONNECT_GRACE + 500);
  game.clearTimer?.();
  game.currentHand.finished = true;
}

// ---- the host can hand the table over on purpose ----
{
  const { game, host } = createGame({}, 'Creator', null);
  host.connected = true;
  const ann = game.addPlayer('Ann', null);
  const bob = game.addPlayer('Bob', null);
  ann.connected = true;
  bob.connected = false;
  ann.status = 'seated';

  check('an unknown player cannot be made host',
    game.transferHost('nobody').ok === false && game.hostId === host.id);
  check('a disconnected player cannot be made host',
    game.transferHost(bob.id).ok === false && game.hostId === host.id);
  check('the host cannot hand it to themselves', game.transferHost(host.id).ok === false);

  check('the host can hand the table to a connected player',
    game.transferHost(ann.id).ok === true && game.hostId === ann.id);
  check('the creator id is unchanged by a hand-over', game.creatorId === host.id);
  check('the log says who runs the table now',
    game.logs.some((l) => l.text.includes('Ann is now the host')));

  // The point of the flag: a deliberate hand-over must survive the old host's
  // browser reconnecting, which would otherwise silently take it back.
  check('the creator does NOT reclaim host after giving it away',
    game.reclaimHostIfCreator(host) === false && game.hostId === ann.id);
  // And the new host can hand it back.
  check('the new host can hand it back',
    game.transferHost(host.id).ok === true && game.hostId === host.id);
}

// ---- a bomb pot is dealt as its own game: Omaha, two boards ----
{
  const { game, host } = createGame(
    { variant: 'holdem', bombPotEvery: 1, bombPotAnte: 7, smallBlind: 1, bigBlind: 2 },
    'Host', null
  );
  host.connected = true;
  game.requestSeat(host, 300, 0);
  for (const [name, seat] of [['Uma', 1], ['Vic', 2]]) {
    const p = game.addPlayer(name, null);
    p.connected = true;
    game.requestSeat(p, 300, seat);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  game.status = 'running';
  game.startHand();
  const h = game.currentHand;
  check('the table is still a hold\'em table', game.settings.variant === 'holdem');
  check('but the bomb pot is dealt as Omaha', h.variant.key === 'bombOmaha');
  check('with four cards each', h.players.every((p) => p.holeCards.length === 4));
  check('and two boards', h.doubleBoard === true && h.board2?.length === 3);
  check('the host-set ante is what everyone posted',
    h.players.every((p) => p.totalCommitted === 7));
  check('a bomb pot posts no blinds', h.sbSeat === null && h.bbSeat === null);
  check('chips are conserved at the deal',
    h.players.reduce((a, p) => a + p.stack + p.totalCommitted, 0) === 900);
  game.currentHand.finished = true;
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
  check('the table option alone straddles nobody', game.currentHand.straddleSeat === null);
  game.currentHand.finished = true;

  // Opt everyone in: now the seat under the gun posts one.
  for (const p of [host, uma, vic]) {
    check('a seated player can set their straddle choice', game.setStraddle(p, true).ok === true);
    check('and their re-straddle choice, separately',
      game.setStraddle(p, true, true).ok === true && p.straddleDeepOptIn === true);
  }
  game.startHand();
  check('an opted-in UTG straddles', game.currentHand.straddleSeat !== null);
  check('three-handed leaves room for exactly one straddle',
    game.currentHand.straddleSeats.length === 1);
  check('the straddle is twice the big blind',
    game.currentHand.bySeat.get(game.currentHand.straddleSeat).betThisRound === 4);
  game.currentHand.finished = true;

  // And back out again: the choice is live from the next hand either way, and
  // turning off the first straddle leaves the re-straddle switch alone.
  for (const p of [host, uma, vic]) game.setStraddle(p, false);
  check('the two switches are independent',
    host.straddleOptIn === false && host.straddleDeepOptIn === true);
  game.startHand();
  check('opting back out plays a normal hand', game.currentHand.straddleSeat === null);
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

// ---- buy-ins have a floor and no ceiling ----
{
  // The table's maxBuyIn is a suggestion for the join box, not a gate.
  const { game } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  const deep = game.addPlayer('Deep', null);
  deep.connected = true;
  check('you can sit down far above the table maximum',
    game.requestSeat(deep, 250_000, 1).ok === true);
  check('and the chips are really there', deep.pendingBuyIn === 250_000 || deep.stack === 250_000);

  const shallow = game.addPlayer('Shallow', null);
  shallow.connected = true;
  check('but the minimum is still a floor',
    game.requestSeat(shallow, 39, 2).ok === false);
  check('a fractional buy-in is still refused',
    game.requestSeat(shallow, 100.5, 2).ok === false);
  check('an absurd buy-in past the integer bound is refused',
    game.requestSeat(shallow, Number.MAX_SAFE_INTEGER, 2).ok === false);
}
{
  // Re-buys used to stop at a hundred million, while the comment above the
  // check — and the prompt in the client — both promised no cap.
  const { game, host } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  host.connected = true;
  game.requestSeat(host, 200, 0);
  check('a re-buy past the old hundred-million ceiling is allowed',
    game.rebuy(host, 500_000_000).ok === true);
  check('the chips landed', host.stack === 200 + 500_000_000);
  check('a re-buy under the minimum is still refused',
    game.rebuy(host, 10).ok === false);
}
{
  // The queue used to drop anyone whose buy-in was outside the range — with no
  // message at all. They simply vanished from the line when a seat opened.
  const { game, host } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  host.connected = true;
  game.requestSeat(host, 200, 0);
  // Fill every remaining seat.
  for (let seat = 1; seat < 10; seat++) {
    const p = game.addPlayer(`P${seat}`, null);
    p.connected = true;
    game.requestSeat(p, 200, seat);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  check('the table is full', game.seats.every((id) => id !== null));

  const deep = game.addPlayer('Deep', null);
  deep.connected = true;
  const queued = game.requestSeat(deep, 250_000, null);
  check('a deep buy-in joins the queue rather than being turned away',
    queued.ok === true && deep.status === 'waitlisted');

  // Approve them and free a seat.
  const entry = game.waitlist.find((e) => e.playerId === deep.id);
  if (entry) entry.approved = true;
  const leaver = game.players.get(game.seats[9]);
  game.removeFromSeat(leaver, 'leave');
  game.seatFromWaitlist();

  check('a deep buy-in is promoted out of the queue rather than dropped',
    deep.status === 'seated');
  check('and they sit down with the stack they asked for', deep.stack === 250_000);
  check('the queue is empty afterwards',
    !game.waitlist.some((e) => e.playerId === deep.id));
}

// ---- tipping another player ----
function tableOfThree(settings = {}) {
  const { game, host } = createGame({ actionTime: 0, ...settings }, 'Host', null);
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const pia = game.addPlayer('Pia', null);
  const quinn = game.addPlayer('Quinn', null);
  for (const [p, seat] of [[pia, 1], [quinn, 2]]) {
    p.connected = true;
    game.requestSeat(p, 200, seat);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  game.status = 'running';
  return { game, host, pia, quinn };
}
{
  const { game, host, pia } = tableOfThree();
  const before = host.stack + pia.stack;
  check('a tip is accepted between hands', game.tipPlayer(host, pia.id, 25).ok === true);
  check('the chips left the tipper', host.stack === 175);
  check('the chips reached the other player', pia.stack === 225);
  check('a tip creates no chips', host.stack + pia.stack === before);

  check('you cannot tip yourself', game.tipPlayer(host, host.id, 5).ok === false);
  check('you cannot tip more than you have',
    game.tipPlayer(host, pia.id, 10_000_000).ok === false);
  check('a tip of nothing is refused', game.tipPlayer(host, pia.id, 0).ok === false);
  check('a fractional tip is refused', game.tipPlayer(host, pia.id, 2.5).ok === false);
  check('you cannot tip somebody who is not seated',
    game.tipPlayer(host, 'nobody-here', 5).ok === false);
}
{
  // Stacks mid-hand are load-bearing — all-in detection and side-pot levels
  // are both read off them — so a tip waits for the hand to finish.
  const { game, host, pia } = tableOfThree();
  game.startHand();
  const hostBefore = host.stack;
  const piaBefore = pia.stack;
  const r = game.tipPlayer(host, pia.id, 30);
  check('a tip during a hand is queued, not applied', r.ok === true && r.queued === true);
  check('no chips moved while the hand was live',
    host.stack === hostBefore && pia.stack === piaBefore);

  game.currentHand.finished = true;
  game.applyPendingOps();
  check('the queued tip lands once the hand is over',
    host.stack === hostBefore - 30 && pia.stack === piaBefore + 30);
}
{
  // A queued tip can be applied a whole hand after it was asked for, by which
  // time the tipper may have lost the chips they promised. Pay what is left.
  const { game, host, pia } = tableOfThree();
  game.startHand();
  game.tipPlayer(host, pia.id, 150);
  game.currentHand.finished = true;
  host.stack = 40; // busted most of it away in the meantime
  const piaBefore = pia.stack;
  game.applyPendingOps();
  check('an unaffordable queued tip pays what is left, never more',
    host.stack === 0 && pia.stack === piaBefore + 40);
}

// ---- mixed games: the table rotates its format between hands ----
{
  const { game } = createGame({ variant: 'holdem', rotateVariants: true, rotateEvery: 1 }, 'Mixer', null);
  check('rotation survives sanitizeSettings', game.settings.rotateVariants === true);

  const list = game.rotationList();
  check('an empty list means every rotatable format',
    list.join(',') === rotatableVariants().join(','));
  check('747 is never in the rotation', !list.includes('747'));

  // Walk it by hand: maybeRotateVariant is what startHand calls between deals.
  const seen = [game.settings.variant];
  for (let i = 0; i < list.length; i++) {
    game.maybeRotateVariant();
    seen.push(game.settings.variant);
  }
  check('every rotatable format comes round', new Set(seen).size === list.length);
  check('the walk returns to where it started', seen[seen.length - 1] === seen[0]);
}
{
  // rotateEvery holds the format for N hands before moving on.
  const { game } = createGame(
    { variant: 'holdem', rotateVariants: true, rotateEvery: 3, rotateList: ['holdem', 'plo'] },
    'Mixer', null
  );
  check('the host list is kept as given', game.rotationList().join(',') === 'holdem,plo');
  game.maybeRotateVariant();
  game.maybeRotateVariant();
  check('the format holds for the first two hands', game.settings.variant === 'holdem');
  game.maybeRotateVariant();
  check('and changes on the third', game.settings.variant === 'plo');
}
{
  // A list of one is not a rotation; the table plays everything instead of
  // silently pinning itself to a single game.
  const { game } = createGame(
    { variant: 'holdem', rotateVariants: true, rotateEvery: 1, rotateList: ['plo'] },
    'Mixer', null
  );
  check('a one-format list falls back to all of them',
    game.rotationList().length === rotatableVariants().length);
}
{
  // 747 is left alone: it has a pot that rides between hands, so rotating
  // away from it mid-session would strand that pot.
  const { game } = createGame(
    { variant: '747', rotateVariants: true, rotateEvery: 1 }, 'Mixer', null
  );
  game.maybeRotateVariant();
  game.maybeRotateVariant();
  check('a 747 table never rotates away', game.settings.variant === '747');
}
{
  // Rubbish in the list is dropped rather than trusted.
  const { game } = createGame(
    { variant: 'holdem', rotateVariants: true, rotateList: ['plo', 'nonsense', '747', 'bombOmaha', 'plo'] },
    'Mixer', null
  );
  check('unknown, hidden and 747 entries are stripped',
    game.settings.rotateList.join(',') === 'plo');
}

// ---- a post is visible to the whole table ----
{
  // The point of the field: dead money lands in totalCommitted, which is NOT
  // published per seat, so without `posted` a post is invisible to everyone
  // except the player who made it.
  const { buildViews } = await import('../server/views.js');
  const { game, host, pia, quinn } = tableOfThree({ actionTime: 30 });
  game.startHand();
  const hand = game.currentHand;

  // Pick somebody the action is NOT on — posting on your own turn is refused.
  const poster = [host, pia, quinn].find((p) => p.seatIndex !== hand.toActSeat);
  const seat = poster.seatIndex;
  const before = buildViews(game).pub.seats[seat];
  check('nothing is posted before anyone posts', (before.posted || 0) === 0);

  const posted = game.postToPot(poster, 40);
  check('the post is accepted', posted.ok === true);

  const view = buildViews(game).pub.seats[seat];
  check('the table can see that a post happened', view.posted === 40);
  check('and it is not mistaken for a bet', view.betThisRound !== 40);

  // A second post adds to the first rather than replacing it, which is what
  // the plate marker reads.
  game.postToPot(poster, 10);
  check('further posts accumulate in the view',
    buildViews(game).pub.seats[seat].posted === 50);

  // It really is in the pot, not just annotated on the seat.
  check('the posted chips reached the pot',
    buildViews(game).pub.hand.potTotal >= 50);
}

console.log(`host: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
