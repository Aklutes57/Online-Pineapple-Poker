// Tournament mode: the blind clock, the ladder, and the re-buy window.
// Cash games must be completely untouched by any of it.
// Usage: node test/test-tournament.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-tourney-')), 'test.db');

const { createGame } = await import('../server/gameManager.js');
const { sanitizeSettings } = await import('../server/game.js');
const { blindsForLevel, DEFAULT_SETTINGS, GAME_STATUS } = await import('../shared/constants.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}

// ---- the blind ladder ----
{
  const l0 = blindsForLevel(50, 0);
  check('level 1 is the blinds you set', l0.bigBlind === 50 && l0.smallBlind === 25);
  check('the ladder only ever climbs', (() => {
    let prev = 0;
    for (let i = 0; i < 25; i++) {
      const { bigBlind } = blindsForLevel(50, i);
      if (bigBlind <= prev) return false;
      prev = bigBlind;
    }
    return true;
  })());
  check('the small blind is always half the big one, rounded up', (() => {
    for (let i = 0; i < 25; i++) {
      const { smallBlind, bigBlind } = blindsForLevel(50, i);
      if (smallBlind !== Math.max(1, Math.ceil(bigBlind / 2))) return false;
    }
    return true;
  })());
  check('a tiny starting blind never rounds down to nothing',
    blindsForLevel(2, 0).bigBlind >= 2 && blindsForLevel(2, 0).smallBlind >= 1);
  check('past the end of the ladder each level doubles',
    blindsForLevel(50, 17).bigBlind === blindsForLevel(50, 16).bigBlind * 2);
}

// ---- settings ----
{
  const cash = sanitizeSettings({});
  check('a table is a cash game unless you ask otherwise', cash.tournament === false);
  check('the clock defaults survive sanitisation',
    cash.levelMinutes === DEFAULT_SETTINGS.levelMinutes && cash.rebuyMinutes === DEFAULT_SETTINGS.rebuyMinutes);

  const t = sanitizeSettings({ tournament: true, levelMinutes: 12, rebuyMinutes: 0 });
  check('a tournament keeps its clock', t.tournament === true && t.levelMinutes === 12);
  check('a zero re-buy period is a real value, not a missing one', t.rebuyMinutes === 0);

  const junk = sanitizeSettings({ tournament: true, levelMinutes: -5, rebuyMinutes: 99999 });
  check('a nonsense level length is clamped', junk.levelMinutes >= 1 && junk.levelMinutes <= 240);
  check('a nonsense re-buy period is clamped', junk.rebuyMinutes >= 0 && junk.rebuyMinutes <= 1440);
}

// ---- the clock only runs on a tournament ----
{
  const { game } = createGame({ smallBlind: 25, bigBlind: 50 }, 'Host', null);
  check('a cash game has no clock', game.isTournament() === false && game.msToNextLevel() === null);
  check('a cash game always takes re-buys', game.rebuysOpen() === true);
  game.advanceTournamentClock();
  check('advancing a cash game does nothing',
    game.tournamentStartedAt === null && game.settings.bigBlind === 50);
}

// ---- levels climb between hands ----
{
  const { game } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 15, rebuyMinutes: 60 },
    'Host', null
  );
  check('registration is open before the first hand', game.rebuysOpen() === true);
  check('there is no countdown before the clock starts', game.msToNextLevel() === null);

  game.advanceTournamentClock();
  check('the first hand starts the clock', typeof game.tournamentStartedAt === 'number');
  check('the clock starts on level 1 at the blinds you set',
    game.level === 0 && game.settings.bigBlind === 50 && game.settings.smallBlind === 25);
  check('the countdown is at most one full level', game.msToNextLevel() <= 15 * 60_000);

  // Wind the start time back so the clock reads as two levels in.
  game.tournamentStartedAt -= 31 * 60_000;
  check('the level is read from the wall clock', game.levelNow() === 2);
  check('blinds do not move until a hand boundary', game.settings.bigBlind === 50);
  game.advanceTournamentClock();
  const l2 = blindsForLevel(50, 2);
  check('the next hand raises the blinds',
    game.settings.bigBlind === l2.bigBlind && game.settings.smallBlind === l2.smallBlind);
  check('the level is recorded', game.level === 2);

  // Advancing again inside the same level changes nothing.
  const before = game.settings.bigBlind;
  game.advanceTournamentClock();
  check('a second hand in the same level leaves the blinds alone', game.settings.bigBlind === before);

  // The ladder is measured from the STARTING blind, not the current one, so a
  // level never compounds on a level.
  game.tournamentStartedAt -= 15 * 60_000;
  game.advanceTournamentClock();
  check('the ladder is measured from the starting blind, never compounded',
    game.settings.bigBlind === blindsForLevel(50, 3).bigBlind);
}

// ---- the re-buy window ----
{
  const { game, host } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 15, rebuyMinutes: 30,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  const bob = game.addPlayer('Bob', null);
  bob.connected = true;
  game.requestSeat(bob, 200);
  game.approveSeat(bob.id, true);
  check('a player can sit down before the clock starts', bob.status === 'seated');

  game.advanceTournamentClock();
  bob.stack = 0;
  check('re-buys are open inside the period', game.rebuysOpen() === true);
  check('a busted player can re-buy inside the period', game.rebuy(bob, 200).ok === true);

  // Past the window.
  game.tournamentStartedAt -= 31 * 60_000;
  bob.stack = 0;
  check('the window closes on time', game.rebuysOpen() === false);
  const late = game.rebuy(bob, 200);
  check('a re-buy after the window is refused', late.ok === false && bob.stack === 0);

  // …and standing up and asking for a seat again is not a way around it.
  game.removeFromSeat(bob, 'leave');
  const sneak = game.requestSeat(bob, 200);
  check('sitting back down after the window is refused too',
    sneak.ok === false && bob.status === 'spectating');

  const newcomer = game.addPlayer('Late', null);
  newcomer.connected = true;
  const reg = game.requestSeat(newcomer, 200);
  check('registration is closed to newcomers too',
    reg.ok === false && newcomer.status === 'spectating');
  check('the host is not exempt from a closed window',
    game.requestSeat(host, 200).ok === false);
}

// ---- a freezeout takes one bullet and no more ----
{
  const { game } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 20, rebuyMinutes: 0,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  const ann = game.addPlayer('Ann', null);
  ann.connected = true;
  check('a freezeout still lets you register before it starts', game.rebuysOpen() === true);
  game.requestSeat(ann, 200);
  game.approveSeat(ann.id, true);
  check('a freezeout seats you before the first hand', ann.status === 'seated');

  game.advanceTournamentClock();
  check('a freezeout closes the moment cards fly', game.rebuysOpen() === false);
  ann.stack = 0;
  check('a freezeout refuses a re-buy', game.rebuy(ann, 200).ok === false);
}

// ---- the finish ----
{
  const { game, host } = createGame(
    { smallBlind: 25, bigBlind: 50, tournament: true, levelMinutes: 15, rebuyMinutes: 0,
      minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  const rival = game.addPlayer('Rival', null);
  for (const [p, seat] of [[host, 0], [rival, 1]]) {
    p.connected = true;
    game.requestSeat(p, 200, seat);
    if (p.status === 'requesting') game.approveSeat(p.id, true);
  }
  game.status = GAME_STATUS.RUNNING;
  game.advanceTournamentClock();
  check('both players are in', game.eligiblePlayers().length === 2);

  rival.stack = 0;
  host.stack = 400;
  game.startHand();
  check('the last player with chips wins the tournament', game.tournamentOver === true);
  check('the table pauses rather than dealing into nobody', game.status === GAME_STATUS.PAUSED);
  check('the winner is announced by name',
    game.logs.some((l) => (l.text || l).includes?.('wins the tournament')
      || String(l).includes('wins the tournament')));
  const logsBefore = game.logs.length;
  game.startHand();
  check('the finish is announced exactly once', game.logs.length === logsBefore);
}

// A cash game with one player left just waits — it never declares a winner.
{
  const { game, host } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  host.connected = true;
  game.requestSeat(host, 200, 0);
  game.status = GAME_STATUS.RUNNING;
  game.startHand();
  check('a cash game never declares a winner', game.tournamentOver !== true);
  check('a cash game keeps running with one player', game.status === GAME_STATUS.RUNNING);
}

// ---- the cash game path is untouched ----
{
  const { game } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Host', null
  );
  const cal = game.addPlayer('Cal', null);
  cal.connected = true;
  game.requestSeat(cal, 200);
  game.approveSeat(cal.id, true);
  cal.stack = 0;
  check('a cash game takes a re-buy at any time', game.rebuy(cal, 200).ok === true);
  for (let i = 0; i < 5; i++) game.advanceTournamentClock();
  check('a cash game never moves its blinds',
    game.settings.smallBlind === 1 && game.settings.bigBlind === 2);
  check('a cash game reports no clock to clients', game.isTournament() === false);
}

console.log(`tournament: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
