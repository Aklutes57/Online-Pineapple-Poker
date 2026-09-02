import { Hand } from '../server/hand.js';
import { availableActionsFor } from '../server/betting.js';
import * as betting from '../server/betting.js';
import { PHASES } from '../shared/constants.js';

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

function makePlayer(seatIndex, stack, nickname) {
  return { id: `p${seatIndex}`, nickname: nickname || `p${seatIndex}`, seatIndex, stack, sittingOut: false };
}

function makeCtx() {
  return {
    logs: [],
    timer: null,
    finishedFlag: false,
    log(t) { this.logs.push(t); },
    changed() {},
    finished() { this.finishedFlag = true; },
    setTimer(name, ms, fn) { this.timer = { name, ms, fn }; },
    clearTimer() { this.timer = null; },
    markAway(p) { p.sittingOut = true; },
    fire() {
      const t = this.timer;
      if (!t) throw new Error('no timer to fire');
      this.timer = null;
      t.fn();
    },
    fireAll() {
      let guard = 0;
      while (this.timer && guard++ < 50) this.fire();
    },
  };
}

function makeHand({ players, deck, variantKey = 'holdem', sb = 1, bb = 2, buttonSeat = 0, actionTime = 30, options = {} }) {
  const ctx = makeCtx();
  const hand = new Hand({
    handNo: 1, variantKey, smallBlind: sb, bigBlind: bb, actionTime,
    buttonSeat, players, deck, ctx, options,
  });
  return { hand, ctx };
}

function act(hand, seat, action, amount = null) {
  if (hand.toActSeat !== seat) {
    throw new Error(`expected toAct ${seat}, got ${hand.toActSeat} (phase ${hand.phase})`);
  }
  const r = hand.handleAction(hand.bySeat.get(seat), action, amount);
  if (!r.ok) throw new Error(`action failed for seat ${seat}: ${r.error}`);
}

function av(hand, seat) {
  return availableActionsFor(hand, hand.bySeat.get(seat));
}

function totalChips(players, hand) {
  return players.reduce((a, p) => a + p.stack + p.totalCommitted, 0);
}

// Deck consumption: hole cards first (starting left of button, each player's
// full hole cards at once), then flop(3), turn(1), river(1).

// --- Heads-up blinds and order ---
{
  const players = [makePlayer(0, 200, 'btn'), makePlayer(1, 200, 'bb')];
  const deck = ['2h', '7d', '9s', 'Ts', 'Ah', 'Kc', '3c', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  check('HU: button posts SB', hand.sbSeat === 0 && hand.bbSeat === 1);
  check('HU: button acts first preflop', hand.toActSeat === 0);
  act(hand, 0, 'call');
  check('HU: BB has option', hand.toActSeat === 1);
  const bbAv = av(hand, 1);
  check('HU: BB can check and raise', bbAv.canCheck && bbAv.canRaise && bbAv.minRaiseTo === 4);
  act(hand, 1, 'check');
  check('HU: flop dealt', hand.phase === PHASES.FLOP && hand.board.length === 3);
  check('HU: BB acts first postflop', hand.toActSeat === 1);
}

// --- 3-handed: BB option, postflop order, min-raise ladder ---
{
  const players = [makePlayer(0, 500), makePlayer(1, 500), makePlayer(2, 500)];
  const deck = [
    '2h', '7d', '9s', 'Ts', 'Ah', 'Kc', // seats 1, 2, 0
    '3c', '4d', 'Jh', '8c', '5s',
  ];
  const { hand } = makeHand({ players, deck });
  hand.start();
  check('3way: sb/bb assigned left of button', hand.sbSeat === 1 && hand.bbSeat === 2);
  check('3way: UTG is button seat here', hand.toActSeat === 0);
  const utgAv = av(hand, 0);
  check('3way: UTG call 2, minRaiseTo 4', utgAv.callAmount === 2 && utgAv.minRaiseTo === 4);
  act(hand, 0, 'raise', 7);
  const sbAv = av(hand, 1);
  check('3way: after raise to 7, call 6 and minRaiseTo 12', sbAv.callAmount === 6 && sbAv.minRaiseTo === 12);
  act(hand, 1, 'call');
  const bbAv = av(hand, 2);
  check('3way: BB calls 5 more', bbAv.callAmount === 5);
  act(hand, 2, 'call');
  check('3way: flop after BB call', hand.phase === PHASES.FLOP);
  check('3way: SB first postflop', hand.toActSeat === 1);
  check('3way: pot is 21', hand.collectedPot() === 21);
}

// --- BB option: limped pot, BB check closes street ---
{
  const players = [makePlayer(0, 500), makePlayer(1, 500), makePlayer(2, 500)];
  const deck = ['2h', '7d', '9s', 'Ts', 'Ah', 'Kc', '3c', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'call');
  const bbAv = av(hand, 2);
  check('BB option: can check or raise', bbAv.canCheck && bbAv.canRaise);
  act(hand, 2, 'check');
  check('BB option: check closes preflop', hand.phase === PHASES.FLOP);
}

// --- Short all-in does NOT reopen action ---
{
  const players = [makePlayer(0, 500, 'a'), makePlayer(1, 180, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 50);
  act(hand, 1, 'call');
  check('short: flop reached', hand.phase === PHASES.FLOP);
  act(hand, 1, 'check');
  act(hand, 0, 'bet', 100);
  const bAv = av(hand, 1);
  check('short: b min raise-to capped at all-in 130', bAv.canRaise && bAv.minRaiseTo === 130 && bAv.maxRaiseTo === 130);
  act(hand, 1, 'raise', 130);
  const aAv = av(hand, 0);
  check('short: a may not re-raise after short all-in', !aAv.canRaise);
  check('short: a owes 30', aAv.callAmount === 30);
  act(hand, 0, 'call');
  check('short: run-out triggered', hand.runOut === true);
}

// --- Full raise DOES reopen action ---
{
  const players = [makePlayer(0, 500, 'a'), makePlayer(1, 800, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 50);
  act(hand, 1, 'call');
  act(hand, 1, 'check');
  act(hand, 0, 'bet', 100);
  act(hand, 1, 'raise', 250);
  const aAv = av(hand, 0);
  check('reopen: a may re-raise after full raise', aAv.canRaise);
  check('reopen: min re-raise is 400', aAv.minRaiseTo === 400);
}

// --- PLO pot-limit anchors ---
{
  const players = [makePlayer(0, 5000), makePlayer(1, 5000), makePlayer(2, 5000)];
  const deck = [
    'Ah', 'Kh', 'Qh', 'Jh', '2c', '3c', '4c', '5c', '2d', '3d', '4d', '5d', // 4 cards x 3
    '9s', 'Ts', '6h', '7s', '8d',
  ];
  const { hand } = makeHand({ players, deck, variantKey: 'plo' });
  hand.start();
  check('plo: four hole cards', hand.bySeat.get(0).holeCards.length === 4);
  const utgAv = av(hand, 0);
  check('plo: UTG max open is pot (raise to 7)', utgAv.maxRaiseTo === 7 && utgAv.minRaiseTo === 4);
}
{
  const players = [makePlayer(0, 5000, 'a'), makePlayer(1, 5000, 'b')];
  const deck = ['Ah', 'Kh', 'Qh', 'Jh', '2c', '3c', '4c', '5c', '9s', 'Ts', '6h', '7s', '8d'];
  const { hand } = makeHand({ players, deck, variantKey: 'plo', sb: 25, bb: 50 });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('plo flop: pot is 100', hand.collectedPot() === 100);
  const bOpen = av(hand, 1);
  check('plo flop: max open bet is pot 100', bOpen.maxRaiseTo === 100 && bOpen.minRaiseTo === 50);
  act(hand, 1, 'bet', 50);
  const aAv = av(hand, 0);
  check('plo flop: facing 50 into 100, max raise to 250', aAv.maxRaiseTo === 250 && aAv.minRaiseTo === 100);
}

// --- Three-way all-in: side pots paid correctly through showdown ---
{
  const players = [makePlayer(0, 20, 'short'), makePlayer(1, 60, 'mid'), makePlayer(2, 150, 'big')];
  const chipsBefore = 230;
  const deck = [
    'Ks', 'Kd', 'Qs', 'Qd', 'As', 'Ad', // seat1, seat2, seat0
    '2h', '7d', '9s', '3c', '4d',
  ];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20); // all-in
  act(hand, 1, 'raise', 60); // all-in (full raise: 40 >= 18)
  act(hand, 2, 'call');
  check('3allin: run-out', hand.runOut === true);
  ctx.fireAll();
  check('3allin: finished at showdown', hand.finished && hand.phase === PHASES.SHOWDOWN);
  check('3allin: aces win main 60', players[0].stack === 60);
  check('3allin: kings win side 80', players[1].stack === 80);
  check('3allin: queens lose, keep 90', players[2].stack === 90);
  check('3allin: chips conserved', totalChips(players, hand) === chipsBefore);
  check('3allin: hands revealed', hand.revealed === true);
}

// --- Uncalled bet returned on fold ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  act(hand, 1, 'bet', 100);
  act(hand, 0, 'fold');
  check('uncalled: hand complete by fold', hand.finished && hand.results.byFold);
  check('uncalled: bet returned, b wins 4', players[1].stack === 202 && players[0].stack === 198);
  check('uncalled: refund recorded', hand.results.uncalledReturn?.amount === 100);
}

// --- Timeout auto-folds and marks away ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  check('timeout: action timer pending', ctx.timer?.name === 'action');
  ctx.fire();
  check('timeout: a folded, b wins', hand.finished && players[1].stack === 201);
  check('timeout: a marked away', players[0].sittingOut === true);
}

// --- Pineapple: discard FIRST, then the preflop betting round ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = [
    'Ah', 'Kh', '2c', 'Qs', 'Qd', '3d', // 3 each: seat1 then seat0
    '9s', 'Ts', 'Jh', '4c', '5s',
  ];
  const { hand } = makeHand({ players, deck, variantKey: 'pineapple' });
  hand.start();
  check('pineapple: three hole cards', hand.bySeat.get(0).holeCards.length === 3);
  // The discard comes before anyone bets: you play preflop with the two you keep.
  check('pineapple: discard opens the hand', hand.phase === PHASES.DISCARD_PREFLOP);
  check('pineapple: nobody is on the clock to bet yet', hand.toActSeat === null);
  check('pineapple: no board yet', hand.board.length === 0);
  const r = hand.handleDiscard(hand.bySeat.get(0), 2); // a drops 3d -> keeps Qs Qd
  check('pineapple: discard accepted', r.ok);
  const r2 = hand.handleDiscard(hand.bySeat.get(0), 0);
  check('pineapple: double discard rejected', !r2.ok);
  hand.handleDiscard(hand.bySeat.get(1), 2); // b drops 2c -> keeps Ah Kh
  check('pineapple: preflop betting opens after the discards', hand.phase === PHASES.PREFLOP);
  check('pineapple: still no board during preflop betting', hand.board.length === 0);
  check('pineapple: two cards remain', hand.bySeat.get(0).holeCards.length === 2);
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('pineapple: flop after the preflop round', hand.phase === PHASES.FLOP && hand.board.length === 3);
  // play to showdown: board 9s Ts Jh 4c 5s -> b has AhKh (A-high), a has QsQd pair
  act(hand, 1, 'check'); act(hand, 0, 'check');
  act(hand, 1, 'check'); act(hand, 0, 'check');
  act(hand, 1, 'check'); act(hand, 0, 'check');
  check('pineapple: showdown reached', hand.phase === PHASES.SHOWDOWN);
  check('pineapple: queens win', players[0].stack === 202 && players[1].stack === 198);
}

// --- Crazy Pineapple: bet preflop with three, discard as the flop lands ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = [
    'Ah', 'Kh', '2c', 'Qs', 'Qd', '3d',
    '9s', 'Ts', 'Jh', '4c', '5s',
  ];
  const { hand } = makeHand({ players, deck, variantKey: 'crazyPineapple' });
  hand.start();
  check('crazy: preflop betting starts straight away', hand.phase === PHASES.PREFLOP);
  check('crazy: preflop is played with all three', hand.bySeat.get(0).holeCards.length === 3);
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  // The flop is dealt and the discard happens immediately — before flop betting.
  check('crazy: flop dealt', hand.board.length === 3);
  check('crazy: discard as soon as the flop lands', hand.phase === PHASES.DISCARD_POSTFLOP);
  check('crazy: nobody on the clock during the discard', hand.toActSeat === null);
  hand.handleDiscard(hand.bySeat.get(0), 2);
  hand.handleDiscard(hand.bySeat.get(1), 2);
  check('crazy: flop betting opens after the discards',
    hand.phase === PHASES.FLOP && hand.board.length === 3);
  check('crazy: two cards remain', hand.bySeat.get(0).holeCards.length === 2);
  act(hand, 1, 'check');
  act(hand, 0, 'check');
  check('crazy: turn after the flop round', hand.phase === PHASES.TURN && hand.board.length === 4);
}

// --- Discard timeout auto-discards the last card ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['Ah', 'Kh', '2c', 'Qs', 'Qd', '3d', '9s', 'Ts', 'Jh', '4c', '5s'];
  const { hand, ctx } = makeHand({ players, deck, variantKey: 'pineapple' });
  hand.start();
  check('discard timeout: timer armed', ctx.timer?.name === 'discard');
  ctx.fire();
  check('discard timeout: both auto-discarded', hand.bySeat.get(0).holeCards.length === 2 && hand.bySeat.get(1).holeCards.length === 2);
  check('discard timeout: last card dropped', !hand.bySeat.get(0).holeCards.includes('3d'));
  check('discard timeout: preflop betting opens', hand.phase === PHASES.PREFLOP);
}

// --- Crazy Pineapple all-in preflop: discard still happens during run-out, then reveal ---
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = ['Ah', 'Kh', '2c', 'Qs', 'Qd', '3d', '9s', 'Ts', 'Jh', '4c', '5s'];
  const { hand, ctx } = makeHand({ players, deck, variantKey: 'crazyPineapple' });
  hand.start();
  act(hand, 0, 'raise', 100); // all-in
  act(hand, 1, 'call');       // all-in
  check('crazy-runout: run-out started, not yet revealed', hand.runOut && !hand.revealed);
  ctx.fire(); // run-out timer -> flop
  check('crazy-runout: discard phase during run-out', hand.phase === PHASES.DISCARD_POSTFLOP);
  check('crazy-runout: cards still hidden during discard', !hand.revealed);
  hand.handleDiscard(hand.bySeat.get(0), 2);
  hand.handleDiscard(hand.bySeat.get(1), 2);
  check('crazy-runout: revealed after discards', hand.revealed === true);
  ctx.fireAll();
  check('crazy-runout: reaches showdown', hand.finished && hand.phase === PHASES.SHOWDOWN);
  check('crazy-runout: chips conserved', totalChips(players, hand) === 200);
}

// --- Pineapple all-in from the blinds: discard still comes first ---
{
  const players = [makePlayer(0, 1, 'a'), makePlayer(1, 1, 'b')];
  const deck = ['Ah', 'Kh', '2c', 'Qs', 'Qd', '3d', '9s', 'Ts', 'Jh', '4c', '5s'];
  const { hand, ctx } = makeHand({ players, deck, variantKey: 'pineapple' });
  hand.start();
  check('pineapple-runout: discard opens even when all-in', hand.phase === PHASES.DISCARD_PREFLOP);
  hand.handleDiscard(hand.bySeat.get(0), 2);
  hand.handleDiscard(hand.bySeat.get(1), 2);
  check('pineapple-runout: two cards each', hand.bySeat.get(0).holeCards.length === 2);
  ctx.fireAll();
  check('pineapple-runout: reaches showdown', hand.finished && hand.phase === PHASES.SHOWDOWN);
  check('pineapple-runout: chips conserved', totalChips(players, hand) === 2);
}

// --- showCards is rejected for players not dealt into the hand ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'fold');
  check('showcards: hand ended by fold', hand.finished && hand.results.byFold);
  const outsider = { ...makePlayer(5, 200, 'stranger'), holeCards: ['As', 'Ad'], folded: false };
  check('showcards: outsider rejected', !hand.handleShowCards(outsider).ok);
  check('showcards: winner may show', hand.handleShowCards(hand.bySeat.get(1)).ok);
}

// --- Chip conservation on an ordinary multi-street hand ---
{
  const players = [makePlayer(0, 300), makePlayer(1, 300), makePlayer(2, 300)];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 10);
  act(hand, 1, 'call');
  act(hand, 2, 'call');
  act(hand, 1, 'check');
  act(hand, 2, 'bet', 20);
  act(hand, 0, 'call');
  act(hand, 1, 'fold');
  act(hand, 2, 'bet', 40);
  act(hand, 0, 'call');
  act(hand, 2, 'check');
  act(hand, 0, 'check');
  check('multi-street: reaches showdown', hand.phase === PHASES.SHOWDOWN);
  check('multi-street: chips conserved', players.reduce((a, p) => a + p.stack, 0) === 900);
}

// ============ home-game options ============

// --- Pre-actions ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  // Seat 1 arms Check/Fold while seat 0 is still to act.
  check('pre-action accepted out of turn', hand.setPreAction(hand.bySeat.get(1), 'checkFold').ok);
  check('pre-action rejected on your own turn', !hand.setPreAction(hand.bySeat.get(0), 'check').ok);
  check('unknown pre-action rejected', !hand.setPreAction(hand.bySeat.get(1), 'shove').ok);
  // Seat 0 raises: seat 1's Check/Fold must fold when the turn arrives.
  act(hand, 0, 'raise', 10);
  check('checkFold folds when facing a bet', hand.bySeat.get(1).folded === true);
  check('pre-action is consumed once used', hand.bySeat.get(1).preAction === null);
}
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  hand.setPreAction(hand.bySeat.get(1), 'check');
  act(hand, 0, 'raise', 10);
  // A plain "Check" facing a bet must cancel, NOT fold.
  check('plain check does not fold when a bet appears', hand.bySeat.get(1).folded === false);
  check('plain check hands back a normal turn', hand.toActSeat === 1);
  check('cancelled pre-action is cleared', hand.bySeat.get(1).preAction === null);
}
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  hand.setPreAction(hand.bySeat.get(1), 'callAny');
  hand.setPreAction(hand.bySeat.get(2), 'callAny');
  act(hand, 0, 'raise', 30);
  // Both queued calls fire in the same pass, which closes preflop outright.
  check('callAny pays the raise',
    hand.bySeat.get(1).totalCommitted === 30 && hand.bySeat.get(2).totalCommitted === 30);
  check('a chain of pre-actions resolves in one pass and closes the street',
    hand.phase === PHASES.FLOP && hand.toActSeat === 1);
  check('chip conservation with pre-actions', totalChips(players, hand) === 600);
}

// --- Time bank ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  players[0].timeBank = 10000;
  players[0].connected = true;
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  check('action timer armed', ctx.timer?.name === 'action');
  ctx.fire();
  check('timing out drops into the time bank', ctx.timer?.name === 'timebank');
  check('not folded yet', hand.finished === false);
  ctx.fire();
  check('exhausting the time bank folds', hand.finished === true);
  check('time bank spent', players[0].timeBank === 0);
}
{
  // With no time bank the old behaviour is byte-for-byte unchanged.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  ctx.fire();
  check('no time bank still folds on the first timeout', hand.finished === true);
}

// --- Straddle ---
// Straddling is opt-IN: the table option only makes it available, and a player
// who has not asked to be in it plays a normal hand.
{
  const players = [makePlayer(0, 500, 'btn'), makePlayer(1, 500, 'sb'), makePlayer(2, 500, 'bb')];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('the table option alone posts no straddle', hand.straddleSeat === null);
  check('nobody straddling leaves the big blind as the bet', hand.currentBet === 2);
}
{
  const players = [makePlayer(0, 500, 'btn'), makePlayer(1, 500, 'sb'), makePlayer(2, 500, 'bb')];
  players[0].straddleOptIn = true;
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('straddle posted by UTG', hand.straddleSeat === 0);
  check('straddle is twice the big blind', hand.bySeat.get(0).betThisRound === 4);
  check('current bet is the straddle', hand.currentBet === 4);
  check('action starts left of the straddle', hand.toActSeat === 1);
  check('min raise doubles the straddle', av(hand, 1).minRaiseTo === 8);
  act(hand, 1, 'call');
  act(hand, 2, 'call');
  check('the straddler gets the option', hand.toActSeat === 0);
  check('the straddler can check or raise', av(hand, 0).canCheck && av(hand, 0).canRaise);
  act(hand, 0, 'check');
  check('checking the option ends preflop', hand.phase === PHASES.FLOP);
  check('straddle chips conserved', totalChips(players, hand) === 1500);
}
{
  // Double straddle: UTG puts up 2 big blinds, the next seat doubles it.
  const players = [0, 1, 2, 3, 4, 5].map((i) => makePlayer(i, 500, `p${i}`));
  players[3].straddleOptIn = true;     // UTG posts the first straddle
  players[4].straddleDeepOptIn = true; // UTG+1 is in for the re-straddle
  const deck = Array.from({ length: 30 }, (_, i) => ['2h','7d','9c','Tc','Ah','Kc','3s','4d','Jh','8c','5s','6d','Qh','2c','3d','4h','5c','6s','7h','8d','9s','Td','Js','Qc','Kd','As','2s','3h','4c','5d'][i]);
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('double: first straddler posts 4', hand.bySeat.get(3).betThisRound === 4);
  check('double: second straddler posts 8', hand.bySeat.get(4).betThisRound === 8);
  check('double: both seats are flagged', hand.straddleSeats.join() === '3,4');
  check('double: the last straddle is the bet', hand.currentBet === 8);
  check('double: action starts left of the last straddler', hand.toActSeat === 5);
  check('double: min raise doubles the last straddle', av(hand, 5).minRaiseTo === 16);
  act(hand, 5, 'call');
  act(hand, 0, 'call');
  act(hand, 1, 'call');
  act(hand, 2, 'call');
  check('double: the first straddler still owes a decision', hand.toActSeat === 3);
  act(hand, 3, 'call');
  check('double: the last straddler gets the option', hand.toActSeat === 4);
  check('double: the option can check', av(hand, 4).canCheck);
  act(hand, 4, 'check');
  check('double: checking the option ends preflop', hand.phase === PHASES.FLOP);
  check('double: chips conserved', totalChips(players, hand) === 3000);
}
{
  // Triple straddle, with a seat that is out of it in the middle: skipping a
  // seat does not break the chain, and the doubling counts straddles, not
  // seats. Also: the blinds are never candidates, however they voted.
  const players = [0, 1, 2, 3, 4, 5].map((i) => makePlayer(i, 500, `p${i}`));
  for (const p of players) { p.straddleOptIn = true; p.straddleDeepOptIn = true; }
  players[4].straddleOptIn = false;     // UTG+1 sits this one out
  players[4].straddleDeepOptIn = false;
  const deck = Array.from({ length: 30 }, (_, i) => `${'23456789TJQKA'[i % 13]}${'hdcs'[i % 4]}`);
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('skip: the opted-out seat posts nothing', hand.bySeat.get(4).betThisRound === 0);
  check('skip: the chain carries past it', hand.straddleSeats.join() === '3,5,0');
  check('skip: sizes still double, 4/8/16', hand.bySeat.get(3).betThisRound === 4
    && hand.bySeat.get(5).betThisRound === 8 && hand.bySeat.get(0).betThisRound === 16);
  check('skip: the small blind never straddles', hand.bySeat.get(1).betThisRound === 1);
  check('skip: the big blind never straddles', hand.bySeat.get(2).betThisRound === 2);
  check('skip: the chain stops at the button', hand.straddleSeat === 0);
  check('skip: the last straddle is the bet', hand.currentBet === 16);
  check('skip: action starts left of the button straddle', hand.toActSeat === 1);
  check('skip: min raise doubles the last straddle', av(hand, 1).minRaiseTo === 32);
  check('skip: chips conserved', totalChips(players, hand) === 3000);
}
{
  // The two choices are independent. Agreeing to put up two big blinds under
  // the gun is not agreeing to put up sixteen four seats later, so a player
  // who is only in for the FIRST straddle is skipped once somebody has
  // already straddled — and a player who is only in for the RE-straddle is
  // skipped when the chain has not started yet.
  const players = [0, 1, 2, 3, 4, 5].map((i) => makePlayer(i, 500, `p${i}`));
  players[3].straddleOptIn = true;      // UTG: first straddle only
  players[4].straddleOptIn = true;      // UTG+1: first straddle only — too late
  players[5].straddleDeepOptIn = true;  // UTG+2: re-straddles behind them
  const deck = Array.from({ length: 30 }, (_, i) => `${'23456789TJQKA'[i % 13]}${'hdcs'[i % 4]}`);
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('split: the first-only player opens the chain', hand.bySeat.get(3).betThisRound === 4);
  check('split: a first-only player behind them is skipped', hand.bySeat.get(4).betThisRound === 0);
  check('split: the re-straddler posts double', hand.bySeat.get(5).betThisRound === 8);
  check('split: only the two who posted are in the chain',
    hand.straddleSeats.join() === '3,5');
  check('split: chips conserved', totalChips(players, hand) === 3000);
}
{
  // Re-straddle on its own straddles nothing: there is no straddle to double.
  const players = [0, 1, 2, 3, 4, 5].map((i) => makePlayer(i, 500, `p${i}`));
  for (const p of players) p.straddleDeepOptIn = true;
  const deck = Array.from({ length: 30 }, (_, i) => `${'23456789TJQKA'[i % 13]}${'hdcs'[i % 4]}`);
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('split: nobody in for the first straddle means no chain at all',
    hand.straddleSeats.length === 0 && hand.straddleSeat === null);
  check('split: the big blind is still the bet', hand.currentBet === 2);
}

{
  // A straddler who cannot cover the full post is all-in for what they have,
  // and the chain ends there: there is no honest double of a short straddle.
  const players = [0, 1, 2, 3, 4].map((i) => makePlayer(i, 500, `p${i}`));
  players[3].stack = 3; // UTG can't cover the 4
  for (const p of players) { p.straddleOptIn = true; p.straddleDeepOptIn = true; }
  const deck = Array.from({ length: 30 }, (_, i) => `${'23456789TJQKA'[i % 13]}${'hdcs'[i % 4]}`);
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('short: the straddler is all-in for their stack', hand.bySeat.get(3).betThisRound === 3
    && hand.bySeat.get(3).allIn === true);
  check('short: the chain stops at a short straddle', hand.straddleSeats.join() === '3');
  check('short: the short post is still the bet to match', hand.currentBet === 3);
  // A short post never resets the raise size, so the next raise is measured
  // off the big blind: 3 to call, 5 to raise.
  check('short: the min raise still comes off the big blind', av(hand, 4).minRaiseTo === 5);
  // And it does not become the seat the round is dealt around: an all-in
  // player cannot act, so anchoring on them would quietly take the option
  // away from the big blind.
  check('short: a short straddle is not the action anchor', hand.straddleSeat === null);
  check('short: action starts left of the big blind as usual', hand.toActSeat === 4);
  act(hand, 4, 'call');
  act(hand, 0, 'call');
  act(hand, 1, 'call');
  check('short: the big blind still closes the round', hand.toActSeat === 2);
  check('short: and still has the option to raise', av(hand, 2).canRaise === true);
  check('short: chips conserved', totalChips(players, hand) === 2003);
}
{
  // Everyone folds to a player who is all-in for less than the money in
  // front of them: they win what they COVERED, and the rest goes back to the
  // people who put it in. A straddle chain is what makes this bite — it puts
  // 4, 8 and 16 in from three seats before a card is dealt.
  const players = [0, 1, 2, 3, 4].map((i) => makePlayer(i, 500, `p${i}`));
  players[2].stack = 2; // the big blind is all-in from posting
  for (const p of players) { p.straddleOptIn = true; p.straddleDeepOptIn = true; }
  const deck = Array.from({ length: 30 }, (_, i) => `${'23456789TJQKA'[i % 13]}${'hdcs'[i % 4]}`);
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  const before = totalChips(players, hand);
  check('fold-cap: the chain is 4/8/16', hand.bySeat.get(3).betThisRound === 4
    && hand.bySeat.get(4).betThisRound === 8 && hand.bySeat.get(0).betThisRound === 16);
  check('fold-cap: the big blind is all-in for 2', players[2].allIn === true);
  // Everyone with chips behind folds, leaving only the all-in big blind.
  act(hand, 1, 'fold');
  act(hand, 3, 'fold');
  act(hand, 4, 'fold');
  act(hand, 0, 'fold');
  check('fold-cap: the hand is over', hand.finished === true);
  // Seat 2 covered 2 apiece: their own 2, the small blind's 1, and 2 from
  // each of the three straddlers — nine chips, not the whole 31.
  check('fold-cap: the winner is paid what they covered', players[2].stack === 9);
  check('fold-cap: the small blind loses only its 1', players[1].stack === 499);
  check('fold-cap: the first straddler gets 2 back', players[3].stack === 498);
  check('fold-cap: the second straddler gets 6 back', players[4].stack === 498);
  check('fold-cap: the third straddler gets 14 back', players[0].stack === 498);
  check('fold-cap: chips conserved', totalChips(players, hand) === before);
}
{
  // The ordinary case is unchanged: bet, everyone folds, the bettor takes it
  // and gets their own uncalled chips back.
  const players = [0, 1, 2].map((i) => makePlayer(i, 500, `p${i}`));
  const deck = Array.from({ length: 20 }, (_, i) => `${'23456789TJQKA'[i % 13]}${'hdcs'[i % 4]}`);
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 50);
  act(hand, 1, 'fold');
  act(hand, 2, 'fold');
  check('fold-plain: the raiser wins the blinds', players[0].stack === 503);
  check('fold-plain: the uncalled part came back', hand.results.uncalledReturn?.amount === 48);
  check('fold-plain: chips conserved', totalChips(players, hand) === 1500);
}

{
  // Heads-up must not straddle: the button already posts the small blind.
  const players = [makePlayer(0, 500, 'a'), makePlayer(1, 500, 'b')];
  for (const p of players) { p.straddleOptIn = true; p.straddleDeepOptIn = true; }
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('no straddle heads-up', hand.straddleSeat === null);
  check('no straddle heads-up leaves no chain', hand.straddleSeats.length === 0);
}

// --- Bomb pot ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck, options: { bombPot: true, ante: 10 } });
  hand.start();
  check('bomb pot skips straight to the flop', hand.phase === PHASES.FLOP);
  check('bomb pot deals a flop', hand.board.length === 3);
  check('bomb pot posts no blinds', hand.sbSeat === null && hand.bbSeat === null);
  check('everyone anted', players.every((p) => p.stack === 190));
  check('antes are in the pot', hand.collectedPot() === 30);
  check('bomb pot chips conserved', totalChips(players, hand) === 600);
  check('first to act is left of the button', hand.toActSeat === 1);
  act(hand, 1, 'check'); act(hand, 2, 'check'); act(hand, 0, 'check');
  check('bomb pot advances to the turn', hand.phase === PHASES.TURN);
}
{
  // The bomb pot as it is actually dealt: Omaha, four cards each, and TWO
  // boards with half the pot riding on each. The table's own variant does not
  // come into it — this hand is built as the bomb-pot variant.
  //
  // Hole cards are dealt in blocks starting left of the button, so with the
  // button on seat 0 the deck runs: seat 1, seat 2, seat 0, then the two
  // boards street by street.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = [
    'As', 'Ks', 'Qs', 'Js',       // seat 1
    '2c', '3c', '4d', '5d',       // seat 2
    '7h', '8h', '9h', 'Th',       // seat 0
    'Ac', 'Kc', '2s',             // board one, flop
    '7c', '8c', '9s',             // board two, flop
    '3h',                         // board one, turn
    'Td',                         // board two, turn
    '4h',                         // board one, river
    'Jd',                         // board two, river
  ];
  const { hand } = makeHand({
    players, deck, variantKey: 'bombOmaha', options: { bombPot: true, ante: 10 },
  });
  hand.start();
  check('bomb pot: dealt as a double board', hand.doubleBoard === true);
  check('bomb pot: four cards each', players.every((p) => p.holeCards.length === 4));
  check('bomb pot: two boards flop together',
    hand.board.length === 3 && hand.board2.length === 3);
  check('bomb pot: both boards are face up as they are dealt',
    hand.board2Shown === hand.board2.length);
  check('bomb pot: the boards are different cards',
    hand.board.every((c) => !hand.board2.includes(c)));
  check('bomb pot: no run-it-twice vote to hold', hand.runItTwiceEnabled === false);

  act(hand, 1, 'check'); act(hand, 2, 'check'); act(hand, 0, 'check');
  check('bomb pot: both boards get their turn card',
    hand.board.length === 4 && hand.board2.length === 4 && hand.board2Shown === 4);
  act(hand, 1, 'check'); act(hand, 2, 'check'); act(hand, 0, 'check');
  check('bomb pot: both boards get their river',
    hand.board.length === 5 && hand.board2.length === 5);
  act(hand, 1, 'check'); act(hand, 2, 'check'); act(hand, 0, 'check');

  check('bomb pot: finished at showdown', hand.finished === true);
  check('bomb pot: the result carries both boards', hand.results?.boards?.length === 2);
  // Board one is Ac Kc 2s 3h 4h: seat 2 plays 5d+3c for the wheel, which beats
  // seat 1's two pair. Board two is 7c 8c 9s Td Jd: seat 1 plays Ks+Qs for a
  // king-high straight, which beats seat 0's jack-high one.
  check('bomb pot: board one goes to the wheel', players[2].stack === 205);
  check('bomb pot: board two goes to the bigger straight', players[1].stack === 205);
  check('bomb pot: the third player wins neither', players[0].stack === 190);
  check('bomb pot: the pot really did split in half',
    hand.results.boards[0].winners[0].amount === 15
    && hand.results.boards[1].winners[0].amount === 15);
  check('bomb pot: chips conserved across two boards', totalChips(players, hand) === 600);
}
{
  // A bomb pot is POT LIMIT. Everyone is already in for the ante, so no-limit
  // would make the first bet a shove and there would be nothing to play for.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = [
    'As', 'Ks', 'Qs', 'Js', '2c', '3c', '4d', '5d', '7h', '8h', '9h', 'Th',
    'Ac', 'Kc', '2s', '7c', '8c', '9s', '3h', 'Td', '4h', 'Jd',
  ];
  const { hand } = makeHand({
    players, deck, variantKey: 'bombOmaha', options: { bombPot: true, ante: 10 },
  });
  hand.start();
  check('bomb pot: pot limit is on', hand.potLimit === true);
  // Three antes of 10 are in the middle, so the opening bet is capped at 30.
  const first = av(hand, 1);
  check('bomb pot: the opening bet is capped at the pot',
    first.canCheck === true && first.maxRaiseTo === 30);
  check('bomb pot: and still opens at the big blind', first.minRaiseTo === 2);
  act(hand, 1, 'bet', 30);
  // Facing 30 into 60: 30 to call, then the pot of 90 — a raise to 120.
  const next = av(hand, 2);
  check('bomb pot: a pot-limit raise is call plus the pot', next.maxRaiseTo === 120);
  check('bomb pot: over the cap is refused',
    hand.handleAction(hand.bySeat.get(2), 'raise', 121).ok === false);
  act(hand, 2, 'raise', 120);
  check('bomb pot: the capped raise stands', hand.currentBet === 120);
  // Seat 0 faces 120 into a pot of 180, so the cap is 420 — more than they
  // have. The stack wins, and the tray offers a genuine all-in.
  check('bomb pot: a cap above your stack is just an all-in',
    av(hand, 0).maxRaiseTo === 190);
  check('bomb pot: chips conserved under pot limit', totalChips(players, hand) === 600);
}
{
  // An odd pot cannot be halved evenly: the extra chip goes to the first
  // board rather than evaporating.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = [
    'As', 'Ks', 'Qs', 'Js', '2c', '3c', '4d', '5d', '7h', '8h', '9h', 'Th',
    'Ac', 'Kc', '2s', '7c', '8c', '9s', '3h', 'Td', '4h', 'Jd',
  ];
  const { hand } = makeHand({
    players, deck, variantKey: 'bombOmaha', options: { bombPot: true, ante: 5 },
  });
  hand.start();
  for (let street = 0; street < 3; street++) {
    act(hand, 1, 'check'); act(hand, 2, 'check'); act(hand, 0, 'check');
  }
  const paid = hand.results.boards.reduce(
    (a, b) => a + b.winners.reduce((x, w) => x + w.amount, 0), 0
  );
  check('bomb pot: an odd pot is paid out whole', paid === 15);
  check('bomb pot: the odd chip lands on the first board',
    hand.results.boards[0].winners[0].amount === 8
    && hand.results.boards[1].winners[0].amount === 7);
  check('bomb pot: odd-pot chips conserved', totalChips(players, hand) === 600);
}
{
  // A player whose whole stack is the ante goes all-in rather than negative.
  const players = [makePlayer(0, 5, 'short'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['2h', '7d', '9c', 'Tc', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck, options: { bombPot: true, ante: 10 } });
  hand.start();
  check('short stack antes only what it has', players[0].stack === 0 && players[0].allIn === true);
  check('short ante chips conserved', totalChips(players, hand) === 405);
}

// --- Seven-deuce bounty ---
{
  // Seat 0 wins by fold holding 7-2 and collects from everyone dealt in.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah', 'Ad', 'Kh', 'Kd', '7c', '2s', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck, options: { sevenDeuceBounty: 25 } });
  hand.start();
  check('seat 0 holds seven-deuce', hand.bySeat.get(0).holeCards.join('') === '7c2s');
  act(hand, 0, 'raise', 20);
  act(hand, 1, 'fold');
  act(hand, 2, 'fold');
  check('bounty paid', hand.results.bounty?.total === 50);
  check('bounty collected from both opponents', players[1].stack === 174 && players[2].stack === 173);
  check('bounty chips conserved', players.reduce((a, p) => a + p.stack, 0) === 600);
  check('bounty forces the winning hand face up', players[0].showedCards === true);
}
{
  // A payer shorter than the bounty pays only what they have — never more.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 6, 'short')];
  const deck = ['Kh', 'Kd', '7c', '2s', '3s', '4d', 'Jh', '8c', '5s'];
  const { hand } = makeHand({ players, deck, options: { sevenDeuceBounty: 500 } });
  hand.start();
  check('short payer holds seven-deuce opponent', hand.bySeat.get(0).holeCards.join('') === '7c2s');
  act(hand, 0, 'raise', 6);
  act(hand, 1, 'fold');
  check('short payer never goes negative', players[1].stack >= 0);
  check('bounty is zero-sum against a short stack',
    players.reduce((a, p) => a + p.stack, 0) === 206);
}

// --- The 7-2 bounty only belongs to the two-card games ---
{
  // PLO end to end: seat 0 wins holding both a seven and a deuce among its
  // four cards, and must collect nothing.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  // Heads-up, button 0: seat 1 takes deck[0..3], seat 0 takes deck[4..7].
  const deck = ['Ah','Kh','Qh','Jh', '7c','2s','3d','4d', '9h','8c','5s','Tc','Td'];
  const { hand } = makeHand({ players, deck, variantKey: 'plo', options: { sevenDeuceBounty: 25 } });
  hand.start();
  check('the Omaha hand really does hold a seven and a deuce',
    hand.bySeat.get(0).holeCards.join('') === '7c2s3d4d');
  const av = availableActionsFor(hand, hand.bySeat.get(hand.toActSeat));
  act(hand, hand.toActSeat, 'raise', av.minRaiseTo);
  act(hand, hand.toActSeat, 'fold');
  check('Omaha pays no 7-2 bounty', hand.results.bounty === null);
  check('and no chips moved for it', totalChips(players, hand) === 400);
  check('the winner is not forced face up either', players[0].showedCards !== true);
}
{
  // The gate itself, for every game that should not pay it. Calling
  // applySevenDeuce directly is the point: it proves the refusal is the
  // variant, not some accident of how the hand happened to end.
  const cases = [
    ['plo', 4], ['bombOmaha', 4], ['fiveCardDraw', 5], ['sevenCardStud', 3],
  ];
  for (const [variantKey, holeCount] of cases) {
    const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
    const deck = ['2c','3c','4c','5c','6c','7d','8d','9d','Td','Jd',
      'Qd','Kd','Ad','2h','3h','4h','5h','6h','7h','8h','9h','Th','Jh'];
    const { hand } = makeHand({ players, deck, variantKey, options: { sevenDeuceBounty: 25 } });
    hand.start();
    const winner = hand.bySeat.get(0);
    // Hand them a seven and a deuce outright, so only the variant can refuse.
    winner.holeCards = ['7c', '2s', ...winner.holeCards.slice(2, holeCount)];
    check(`${variantKey} pays no 7-2 bounty`, hand.applySevenDeuce(winner) === null);
    check(`${variantKey} moved no chips for it`, players[1].stack + players[1].totalCommitted === 200);
  }
}
{
  // …and Pineapple still does, on the two cards you keep.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  // 3 each: seat1 deck[0..2], seat2 deck[3..5], seat0 deck[6..8].
  const deck = ['Ah','Ad','Ac', 'Kh','Kd','Kc', '7c','2s','Qd', '3s','4d','Jh','8c','5s'];
  const { hand } = makeHand({
    players, deck, variantKey: 'pineapple', options: { sevenDeuceBounty: 25 },
  });
  hand.start();
  check('pineapple deals three', hand.bySeat.get(0).holeCards.length === 3);
  // Everyone throws one; seat 0 keeps the seven and the deuce.
  hand.handleDiscard(hand.bySeat.get(0), 2);
  hand.handleDiscard(hand.bySeat.get(1), 2);
  hand.handleDiscard(hand.bySeat.get(2), 2);
  check('seat 0 kept the seven-deuce', hand.bySeat.get(0).holeCards.join('') === '7c2s');
  act(hand, 0, 'raise', 20);
  act(hand, 1, 'fold');
  act(hand, 2, 'fold');
  check('pineapple still pays the 7-2 bounty', hand.results.bounty?.total === 50);
  check('pineapple bounty is still zero-sum',
    players.reduce((a, p) => a + p.stack, 0) === 600);
}

// --- Posting dead money into the pot ---
{
  // A post is not a bet: it must not move the current bet, must not count as
  // a call, and must not change whose turn it is.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah','Ad','Kh','Kd','7c','2s','3s','4d','Jh','8c','5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20);
  const toActBefore = hand.toActSeat;
  const betBefore = hand.currentBet;
  const owedBefore = availableActionsFor(hand, hand.bySeat.get(2)).callAmount;
  const potBefore = betting.potTotal(hand);
  // Seat 2 is the big blind here, so it already has chips in front of it —
  // measure the post against what was there, not against the buy-in.
  const streetBefore = hand.bySeat.get(2).betThisRound;
  const stackBefore = players[2].stack;

  const r = hand.postDead(hand.bySeat.get(2), 50);
  check('a post is accepted off-turn', r.ok === true && r.amount === 50);
  check('a post lands in the pot', betting.potTotal(hand) === potBefore + 50);
  check('a post does not move the current bet', hand.currentBet === betBefore);
  check('a post does not change whose turn it is', hand.toActSeat === toActBefore);
  check('a post does not pay off what you owe',
    availableActionsFor(hand, hand.bySeat.get(2)).callAmount === owedBefore);
  check('a post leaves the street bet alone',
    hand.bySeat.get(2).betThisRound === streetBefore);
  check('a post is counted where the table can see it',
    hand.bySeat.get(2).postedThisHand === 50);
  check('a post comes out of the stack', players[2].stack === stackBefore - 50);
}
{
  // Refused on your own turn — that is what the betting controls are for, and
  // in a pot-limit game it would inflate the pot your own max raise is
  // measured against, immediately before you make it.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah','Ad','Kh','Kd','7c','2s','3s','4d','Jh','8c','5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  const onTurn = hand.bySeat.get(hand.toActSeat);
  check('no posting while the action is on you', hand.postDead(onTurn, 10).ok === false);
  check('a post of nothing is refused', hand.postDead(hand.bySeat.get(0), 0).ok === false);
  check('a post you cannot cover is refused',
    hand.postDead(hand.bySeat.get(0), 100000).ok === false);
}
{
  // A folded player has no interest left in the pot, and letting them post
  // would collide with the fold-win cap handing it straight back to them.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah','Ad','Kh','Kd','7c','2s','3s','4d','Jh','8c','5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'fold');
  check('a folded player cannot post', hand.postDead(hand.bySeat.get(0), 10).ok === false);
}
{
  // Chips are conserved through a hand that had dead money posted into it.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah','Ad','Kh','Kd','7c','2s','3s','4d','Jh','8c','5s'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20);
  hand.postDead(hand.bySeat.get(2), 40);
  act(hand, 1, 'fold');
  act(hand, 2, 'fold');
  ctx.fireAll();
  check('the dead money is in the pot that gets paid out',
    totalChips(players, hand) === 600);
  check('the winner collected the posted chips too', players[0].stack > 200);
}
{
  // Posting everything you have leaves you all-in, exactly as shoving would.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 30, 'c')];
  const deck = ['Ah','Ad','Kh','Kd','7c','2s','3s','4d','Jh','8c','5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20);
  hand.postDead(hand.bySeat.get(2), players[2].stack);
  check('posting your whole stack puts you all in',
    players[2].stack === 0 && players[2].allIn === true);
}
{
  // Two posts in one hand accumulate rather than replacing each other.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah','Ad','Kh','Kd','7c','2s','3s','4d','Jh','8c','5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20);
  hand.postDead(hand.bySeat.get(2), 10);
  hand.postDead(hand.bySeat.get(2), 15);
  check('posts add up over a hand', hand.bySeat.get(2).postedThisHand === 25);
  check('and all of it is in the pot',
    hand.bySeat.get(2).totalCommitted >= 25);
}

// --- Run it twice ---
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = [
    '2h', '7d', 'Ah', 'Kc',            // hole cards
    '3s', '4d', 'Jh',                   // board 1 flop
    '8c', '5s', '9d',                   // board 2 flop
    'Ts', 'Qh', '6c', '2c',             // turns and rivers for both
  ];
  const { hand, ctx } = makeHand({ players, deck, options: { runItTwice: true } });
  hand.start();
  act(hand, 0, 'raise', 100);
  act(hand, 1, 'call');
  // Running twice is never automatic — the table is asked, and it only happens
  // if everyone still in the hand says yes.
  check('run it twice is put to a vote', hand.phase === PHASES.RIT_VOTE);
  check('not running twice until the votes are in', hand.runItTwice === false);
  hand.handleRitVote(hand.bySeat.get(0), true);
  check('still waiting on the second player', hand.runItTwice === false);
  hand.handleRitVote(hand.bySeat.get(1), true);
  check('run it twice engaged once everyone agreed', hand.runItTwice === true);
  ctx.fireAll();
  check('two boards dealt', hand.board.length === 5 && hand.board2.length === 5);
  check('boards share no cards', !hand.board.some((c) => hand.board2.includes(c)));
  check('run it twice chips conserved', players.reduce((a, p) => a + p.stack, 0) === 200);
  check('per-board results recorded', hand.results.boards?.length === 2);
}
{
  // An odd pot must still split exactly across two boards.
  const players = [makePlayer(0, 51, 'a'), makePlayer(1, 51, 'b')];
  const deck = [
    '2h', '7d', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s', '9d', 'Ts', 'Qh', '6c', '2c',
  ];
  const { hand, ctx } = makeHand({ players, deck, options: { runItTwice: true } });
  hand.start();
  act(hand, 0, 'raise', 51);
  act(hand, 1, 'call');
  hand.handleRitVote(hand.bySeat.get(0), true);
  hand.handleRitVote(hand.bySeat.get(1), true);
  ctx.fireAll();
  check('odd run-it-twice pot conserved', players.reduce((a, p) => a + p.stack, 0) === 102);
}

// --- One "no" means once, and so does nobody answering ---
{
  const deck = ['2h', '7d', 'Ah', 'Kc', '3s', '4d', 'Jh', '8c', '5s', '9d', 'Ts', 'Qh', '6c', '2c'];
  {
    const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
    const { hand, ctx } = makeHand({ players, deck, options: { runItTwice: true } });
    hand.start();
    act(hand, 0, 'raise', 100);
    act(hand, 1, 'call');
    hand.handleRitVote(hand.bySeat.get(0), true);
    hand.handleRitVote(hand.bySeat.get(1), false); // one refusal settles it
    check('a single no means run it once', hand.runItTwice === false);
    check('the vote does not linger', hand.phase !== PHASES.RIT_VOTE);
    ctx.fireAll();
    check('one board only', hand.board.length === 5 && !hand.board2?.length);
    check('declined run-it-twice conserves chips',
      players.reduce((a, p) => a + p.stack, 0) === 200);
  }
  {
    const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
    const { hand, ctx } = makeHand({ players, deck, options: { runItTwice: true } });
    hand.start();
    act(hand, 0, 'raise', 100);
    act(hand, 1, 'call');
    check('vote is open', hand.phase === PHASES.RIT_VOTE);
    ctx.fireAll(); // nobody answers — the vote times out
    check('no answer means run it once', hand.runItTwice === false);
    check('timed-out vote still reaches showdown', hand.finished);
    check('timed-out vote conserves chips',
      players.reduce((a, p) => a + p.stack, 0) === 200);
  }
}

// --- Rabbit hunt ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck, options: { rabbitHunt: true } });
  hand.start();
  check('rabbit hunt refused during a live hand', !hand.handleRabbitHunt(hand.bySeat.get(0)).ok);
  act(hand, 0, 'fold');
  check('rabbit hunt allowed after a fold win', hand.handleRabbitHunt(hand.bySeat.get(1)).ok);
  check('rabbit cards revealed', hand.rabbit.length === 5);
  check('rabbit hunt only once', !hand.handleRabbitHunt(hand.bySeat.get(1)).ok);
}
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck, options: { rabbitHunt: false } });
  hand.start();
  act(hand, 0, 'fold');
  check('rabbit hunt refused when the table has it off', !hand.handleRabbitHunt(hand.bySeat.get(1)).ok);
}

// --- Show cards after the hand: folders may always show, face-up hands may not ---
{
  // Showdown: the folded player can flash the fold; live hands are already up.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = ['Ah', 'Ad', 'Kh', 'Kd', '9c', '3d', '7s', '8h', 'Jh', 'Tc', '5s'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'fold');
  act(hand, 1, 'call');
  act(hand, 2, 'check');
  for (let street = 0; street < 3; street++) {
    act(hand, 1, 'check');
    act(hand, 2, 'check');
  }
  check('show-after-showdown: hand went to showdown', hand.finished && !hand.results.byFold);
  check('show-after-showdown: folded player may show', hand.handleShowCards(hand.bySeat.get(0)).ok);
  check('show-after-showdown: folded cards marked shown', hand.bySeat.get(0).showedCards === true);
  check('show-after-showdown: face-up hand refused', !hand.handleShowCards(hand.bySeat.get(1)).ok);
  check('show-after-showdown: double show refused', !hand.handleShowCards(hand.bySeat.get(0)).ok);
}
{
  // Fold-win: both the winner and the folder can show.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'fold');
  check('show-after-fold: winner may show', hand.handleShowCards(hand.bySeat.get(1)).ok);
  check('show-after-fold: folder may show too', hand.handleShowCards(hand.bySeat.get(0)).ok);
}

// --- 6-2 gets announced when it wins in the open ---
{
  // Showdown scoop with 6-2 announces itself.
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = ['Ah', 'Kd', '6h', '2s', '6c', '2d', '9h', 'Ts', '3c'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  check('six-deuce: seat 0 holds it', hand.bySeat.get(0).holeCards.join('') === '6h2s');
  act(hand, 0, 'raise', 100);
  act(hand, 1, 'call');
  ctx.fireAll();
  check('six-deuce: showdown reached', hand.finished && !hand.results.byFold);
  check('six-deuce: winner announced', hand.results.sixTwo?.seat === 0);
  check('six-deuce: log carries the callout', ctx.logs.some((l) => l.includes('wins with the 6-2')));
  check('six-deuce: no chips moved by the callout', players.reduce((a, p) => a + p.stack, 0) === 200);
}
{
  // A split pot is nobody's glory — no announcement.
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = ['6d', '2c', '6h', '2s', '6c', '2h', 'Ah', 'Ks', 'Qd'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 100);
  act(hand, 1, 'call');
  ctx.fireAll();
  check('six-deuce split: pot chopped', hand.results.winners.length === 2);
  check('six-deuce split: no announcement', !hand.results.sixTwo);
}
{
  // A fold-win with 6-2 stays private — until the winner shows the bluff.
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['Ah', 'Kd', '6h', '2s', '9c', 'Ts', '3c', '4d', 'Jh'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  check('six-deuce fold-win: seat 0 holds it', hand.bySeat.get(0).holeCards.join('') === '6h2s');
  act(hand, 0, 'raise', 20);
  act(hand, 1, 'fold');
  check('six-deuce fold-win: hidden cards stay unannounced', !hand.results.sixTwo);
  check('six-deuce fold-win: showing earns the callout',
    hand.handleShowCards(hand.bySeat.get(0)).ok && hand.results.sixTwo?.seat === 0);
  check('six-deuce fold-win: log carries the late callout',
    ctx.logs.some((l) => l.includes('wins with the 6-2')));
}

// --- Uncapped stakes: chip math must stay exact at nosebleed sizes ---
{
  const TRILLION = 1_000_000_000_000;
  const players = [makePlayer(0, 10 * TRILLION, 'a'), makePlayer(1, 10 * TRILLION, 'b')];
  const deck = ['Ah', 'Kd', 'Qh', 'Js', '6c', '2d', '9h', 'Ts', '3c'];
  const { hand, ctx } = makeHand({ players, deck, sb: TRILLION, bb: 2 * TRILLION });
  hand.start();
  act(hand, 0, 'raise', 10 * TRILLION);
  act(hand, 1, 'call');
  ctx.fireAll();
  check('nosebleed: hand completes', hand.finished);
  check('nosebleed: chips conserved exactly',
    players.reduce((a, p) => a + p.stack, 0) === 20 * TRILLION);
  check('nosebleed: every stack is a safe integer',
    players.every((p) => Number.isSafeInteger(p.stack)));
}

// --- Run it twice deals one board at a time ---
// The second board is DRAWN street by street with the first (same deck
// positions as ever, so the integrity proof is untouched) but stays face down
// until the first board has finished running out.
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = [
    '2h', '7d', 'Ah', 'Kc',            // hole cards
    '3s', '4d', 'Jh',                   // board 1 flop
    '8c', '5s', '9d',                   // board 2 flop
    'Ts', 'Qh', '6c', '2c',             // turns and rivers for both
  ];
  const { hand, ctx } = makeHand({ players, deck, options: { runItTwice: true } });
  hand.start();
  act(hand, 0, 'raise', 100);
  act(hand, 1, 'call');
  hand.handleRitVote(hand.bySeat.get(0), true);
  hand.handleRitVote(hand.bySeat.get(1), true);
  check('rit: agreed before any board is dealt', hand.runItTwice && hand.board.length === 0);
  check('rit: the second board starts hidden', hand.board2Shown === 0);

  // Walk the first board out. Nothing of the second board may be visible.
  const shownDuringFirst = [];
  let guard = 0;
  while (ctx.timer && hand.board.length < 5 && guard++ < 20) {
    ctx.fire();
    shownDuringFirst.push(hand.board2Shown);
  }
  check('rit: first board runs out on its own', hand.board.length === 5);
  check('rit: second board stayed face down throughout the first',
    shownDuringFirst.every((n) => n === 0));
  check('rit: both boards are already drawn', hand.board2.length === 5);
  check('rit: nothing has been shown of board two yet', hand.board2Shown === 0);

  // Now the second board runs out, one street at a time.
  const steps = [];
  guard = 0;
  while (ctx.timer && !hand.finished && guard++ < 20) {
    ctx.fire();
    if (!hand.finished) steps.push(hand.board2Shown);
  }
  check('rit: second board revealed in street-sized steps',
    JSON.stringify(steps) === JSON.stringify([3, 4, 5]));
  check('rit: hand finishes after both boards', hand.finished);
  check('rit: finished hand shows all of board two', hand.board2Shown === 5);
  check('rit: sequential deal conserves chips',
    players.reduce((a, p) => a + p.stack, 0) === 200);
  check('rit: per-board results still recorded', hand.results.boards?.length === 2);
  check('rit: boards still share no cards',
    !hand.board.some((c) => hand.board2.includes(c)));
  // The deck positions are what the fairness proof is over: board one takes
  // the flop, board two the next three, and so on, exactly as before.
  check('rit: deck consumption order unchanged',
    hand.board.join(',') === '3s,4d,Jh,Ts,6c'
    && hand.board2.join(',') === '8c,5s,9d,Qh,2c');
}

// The same, but agreed on the turn: the boards share four cards, which land
// together when the second row appears.
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '3s', '4d', 'Jh', 'Ts', '6c', 'Qh', '2c'];
  const { hand, ctx } = makeHand({ players, deck, options: { runItTwice: true } });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  // Flop, then get it all in on the turn.
  check('rit-turn: flop dealt', hand.phase === PHASES.FLOP);
  act(hand, 1, 'check');
  act(hand, 0, 'check');
  check('rit-turn: turn dealt', hand.board.length === 4);
  act(hand, 1, 'raise', 98); // the blinds are already in, so 98 is the shove
  act(hand, 0, 'call');
  check('rit-turn: vote opened on the turn', hand.phase === PHASES.RIT_VOTE);
  hand.handleRitVote(hand.bySeat.get(0), true);
  hand.handleRitVote(hand.bySeat.get(1), true);
  check('rit-turn: four shared cards', hand.ritPrefix === 4);
  const shown = [];
  let guard = 0;
  while (ctx.timer && !hand.finished && guard++ < 20) {
    ctx.fire();
    if (!hand.finished) shown.push(hand.board2Shown);
  }
  // River on board one (second board still hidden), then the shared four
  // appear, then board two's own river.
  check('rit-turn: shared cards land together, then the river',
    JSON.stringify(shown) === JSON.stringify([0, 4, 5]));
  check('rit-turn: chips conserved', players.reduce((a, p) => a + p.stack, 0) === 200);
}

// --- Live equity while the hand runs out ---
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  // Cards go out in blocks starting left of the button, so seat 1 takes the
  // first two: seat 1 = Ah Kh, seat 0 = 2c 7d. Board runs Qh Jh 3s / 4d / 9c.
  const deck = ['Ah', 'Kh', '2c', '7d', 'Qh', 'Jh', '3s', '4d', '9c'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  check('equity: the deal is as the test assumes',
    hand.bySeat.get(1).holeCards.join('') === 'AhKh'
    && hand.bySeat.get(0).holeCards.join('') === '2c7d');
  check('equity: nothing published before the chips are in', hand.equityNow === null);
  act(hand, 0, 'raise', 100);
  check('equity: still nothing while a decision is pending', hand.equityNow === null);
  act(hand, 1, 'call');
  check('equity: the run-out is on', hand.runOut === true);
  check('equity: hands are face up', hand.revealed === true);
  check('equity: published once the cards are face up', !!hand.equityNow);
  const preflop = hand.equityNow;
  check('equity: one row per live player', preflop.rows.length === 2);
  check('equity: rows are sorted best first', preflop.rows[0].pct >= preflop.rows[1].pct);
  check('equity: shares add up to 100',
    Math.abs(preflop.rows.reduce((a, r) => a + r.pct, 0) - 100) < 0.5);
  check('equity: AKs is the favourite over 72o preflop',
    preflop.rows.find((r) => r.seat === 1).pct > 60);
  check('equity: no board cards counted yet', preflop.cards === 0);

  ctx.fire(); // flop: Qh Jh 3s — seat 1 adds a royal draw to two overcards
  check('equity: recomputed on the flop', hand.equityNow.cards === 3);
  check('equity: AKs further ahead on the flop',
    hand.equityNow.rows.find((r) => r.seat === 1).pct > 80);
  ctx.fireAll();
  check('equity: cleared when the hand is over', hand.equityNow === null);
  check('equity: winner took it', players[1].stack === 200);
}

// Equity is only ever arithmetic on cards the table can already see: a hand
// that ends without a run-out never publishes any.
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = ['Ah', '2c', 'Kh', '7d', 'Qh', 'Jh', '3s', '4d', '9c'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20);
  act(hand, 1, 'fold');
  ctx.fireAll();
  check('equity: a hand won by a fold publishes nothing', hand.equityNow === null);
  check('equity: folded hand stays face down', hand.revealed === false);
}

// --- Nobody to act: a seatless player must never arm a turn ---
// toActSeat is null whenever the table waits on everyone at once (an all-in
// run-out, a discard, the run-it-twice vote), and a spectator or a player who
// stood up has seatIndex null. `hand.toActSeat === player.seatIndex` is then
// null === null, which used to pass the guard, call beginTurn for a seat that
// is not in the hand, and throw — taking down the process, and with it every
// other table on the machine.
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  for (const p of players) p.connected = true;
  const deck = ['Ah', '2c', 'Kh', '7d', 'Qh', 'Jh', '3s', '4d', '9c'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 100);
  act(hand, 1, 'call');
  check('run-out: nobody is to act', hand.toActSeat === null);
  check('run-out: still counts as a betting phase', hand.isBettingPhase() === true);
  const timerBefore = ctx.timer?.name ?? null;
  let threw = null;
  try {
    hand.beginTurn();
  } catch (err) {
    threw = err;
  }
  check('beginTurn with no seat to act returns instead of throwing', threw === null);
  // The run-out's own timer is pending and must survive: the game keeps a
  // single timer slot, so arming an action clock here would evict the run-out
  // and strand the hand.
  check('...and leaves the run-out timer alone',
    (ctx.timer?.name ?? null) === timerBefore && ctx.timer?.name !== 'action');
}

// --- Showing after a fold-win says what the hand WAS ---
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  // Seat 1 takes the first block: Ah Kh. Seat 0 gets 2c 7d.
  const deck = ['Ah', 'Kh', '2c', '7d', 'Qh', 'Jh', '3s', '4d', '9c'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'raise', 20);
  act(hand, 1, 'fold');
  ctx.fireAll();
  check('fold-win: the hand is over', hand.finished);
  const winner = hand.bySeat.get(0);
  check('fold-win: no description until they choose to show', !winner.handResult.desc);
  const res = hand.handleShowCards(winner);
  check('fold-win: showing is allowed', res.ok === true);
  check('fold-win: the shown hand is described',
    winner.handResult.desc === 'Seven High');
  check('fold-win: the log carries the description',
    ctx.logs.some((l) => l.includes('shows 2c 7d') && l.includes('Seven High')));
  check('fold-win: winnings are not overwritten', winner.handResult.won > 0);
}

// A hand that reached a board describes against it, not against the two cards.
{
  const players = [makePlayer(0, 100, 'a'), makePlayer(1, 100, 'b')];
  const deck = ['Ah', 'Kh', '2c', '7d', 'Qh', 'Jh', '3s', '4d', '9c'];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('board reached: flop is out', hand.board.length === 3);
  act(hand, 1, 'bet', 10);
  act(hand, 0, 'fold');
  ctx.fireAll();
  const winner = hand.bySeat.get(1);
  hand.handleShowCards(winner);
  // Ah Kh on Qh Jh 3s is ace-high, and the description must come from the
  // five cards actually available.
  check('fold-win on a flop: described against the board',
    winner.handResult.desc === 'Ace High');
}

console.log(`betting: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
