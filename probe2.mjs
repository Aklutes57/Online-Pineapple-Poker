import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-probe2-')), 'test.db');
const { createGame } = await import('./server/gameManager.js');
const { GAME_STATUS, SEAT_COUNT } = await import('./shared/constants.js');

// ---- PROBE C: heads-up freezeout, one player times out (markAway) ----
{
  const { game, host } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 20, rebuyMinutes: 0,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 }, 'Host', null);
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const ann = game.addPlayer('Ann', null); ann.connected = true;
  game.requestSeat(ann, 200, 1); if (ann.status === 'requesting') game.approveSeat(ann.id, true);
  game.status = GAME_STATUS.RUNNING;
  game.advanceTournamentClock();
  // Ann's wifi drops; the hand engine marks her away after she times out.
  game.handCtx().markAway(ann);
  game.startHand();
  console.log('C: tournamentOver', game.tournamentOver, 'status', game.status,
    '| stacks host/ann', host.stack, ann.stack);
  console.log('C: log', (game.logs.at(-1).text || game.logs.at(-1)));
  // Ann comes back and un-sits-out; host resumes.
  ann.sittingOut = false;
  const r = game.setPaused(false);
  console.log('C: resume ->', JSON.stringify(r), 'status', game.status, 'hand?', !!game.currentHand);
}

// ---- PROBE D: queue joined BEFORE the window closes, seated AFTER ----
{
  const { game, host } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 20, rebuyMinutes: 0,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 }, 'Host', null);
  host.connected = true;
  game.requestSeat(host, 200, 0);
  for (let i = 1; i < SEAT_COUNT; i++) {
    const p = game.addPlayer(`P${i}`, null); p.connected = true;
    game.requestSeat(p, 200, i);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  // 11th player queues while registration is still open, host waves them in.
  const late = game.addPlayer('Eleventh', null); late.connected = true;
  console.log('D: rebuysOpen at queue time =', game.rebuysOpen());
  console.log('D: queue ->', JSON.stringify(game.requestSeat(late, 200)));
  game.approveWaitlist(late.id, true);
  console.log('D: still queued (no seat) =', late.status, 'waitlist len', game.waitlist.length);

  game.status = GAME_STATUS.RUNNING;
  game.advanceTournamentClock();
  console.log('D: rebuysOpen after cards fly =', game.rebuysOpen());
  const buyInsBefore = [...game.ledger.values()].reduce((n, e) => n + e.buyIns, 0);
  // Someone busts out and stands up between hands.
  const victim = game.players.get(game.seats[3]);
  victim.stack = 0;
  game.removeFromSeat(victim, 'busted');
  game.seatFromWaitlist();
  const buyInsAfter = [...game.ledger.values()].reduce((n, e) => n + e.buyIns, 0);
  console.log('D: eleventh status =', late.status, 'stack =', late.stack, 'seat =', late.seatIndex);
  console.log('D: total buy-ins', buyInsBefore, '->', buyInsAfter, '(registration was closed)');
  console.log('D: log', (game.logs.at(-1).text || game.logs.at(-1)));
}
