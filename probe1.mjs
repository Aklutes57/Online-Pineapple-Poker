import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-probe-')), 'test.db');

const { createGame } = await import('./server/gameManager.js');
const { GAME_STATUS, SEAT_COUNT } = await import('./shared/constants.js');

// ---- PROBE A: waitlist bypasses the closed registration window ----
{
  const { game, host } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 20, rebuyMinutes: 0,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const seated = [host];
  for (let i = 1; i < SEAT_COUNT; i++) {
    const p = game.addPlayer(`P${i}`, null);
    p.connected = true;
    game.requestSeat(p, 200, i);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
    seated.push(p);
  }
  console.log('A: seated count', seated.filter((p) => p.status === 'seated').length, 'seats full?', !game.seats.includes(null));

  game.status = GAME_STATUS.RUNNING;
  game.advanceTournamentClock();            // clock starts -> freezeout closed
  console.log('A: rebuysOpen after clock start =', game.rebuysOpen());

  // A brand new player turns up AFTER registration closed. Table is full.
  const late = game.addPlayer('Late', null);
  late.connected = true;
  const r = game.requestSeat(late, 200);
  console.log('A: requestSeat result =', JSON.stringify(r), 'status =', late.status);

  const buyInsBefore = [...game.ledger.values()].reduce((n, e) => n + e.buyIns, 0);

  // Somebody busts and stands up; the seat frees between hands.
  const victim = seated[3];
  victim.stack = 0;
  game.removeFromSeat(victim, 'busted');
  game.seatFromWaitlist();

  const buyInsAfter = [...game.ledger.values()].reduce((n, e) => n + e.buyIns, 0);
  console.log('A: late player status =', late.status, 'stack =', late.stack, 'seat =', late.seatIndex);
  console.log('A: total buy-ins', buyInsBefore, '->', buyInsAfter);
  console.log('A: rebuysOpen still =', game.rebuysOpen());
}

// ---- PROBE B: sitting-out players count as busted -> premature winner ----
{
  const { game, host } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 20, rebuyMinutes: 0,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const a = game.addPlayer('Ann', null); a.connected = true;
  game.requestSeat(a, 200, 1); if (a.status === 'requesting') game.approveSeat(a.id, true);
  const b = game.addPlayer('Ben', null); b.connected = true;
  game.requestSeat(b, 200, 2); if (b.status === 'requesting') game.approveSeat(b.id, true);
  game.status = GAME_STATUS.RUNNING;
  game.advanceTournamentClock();
  console.log('B: eligible', game.eligiblePlayers().length, 'rebuysOpen', game.rebuysOpen());
  // Two players step away for a smoke; all three still have every chip.
  a.sittingOut = true;
  b.sittingOut = true;
  game.startHand();
  console.log('B: stacks host/ann/ben =', host.stack, a.stack, b.stack);
  console.log('B: tournamentOver =', game.tournamentOver, 'status =', game.status);
  console.log('B: log tail =', game.logs.slice(-2).map((l) => l.text || l));
}
