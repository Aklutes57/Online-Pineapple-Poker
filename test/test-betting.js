import { Hand } from '../server/hand.js';
import { availableActionsFor } from '../server/betting.js';
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
{
  const players = [makePlayer(0, 500, 'btn'), makePlayer(1, 500, 'sb'), makePlayer(2, 500, 'bb')];
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
  // Heads-up must not straddle: the button already posts the small blind.
  const players = [makePlayer(0, 500, 'a'), makePlayer(1, 500, 'b')];
  const deck = ['2h', '7d', 'Ah', 'Kc', '9s', 'Ts', '3c', '4d', 'Jh'];
  const { hand } = makeHand({ players, deck, options: { straddle: true } });
  hand.start();
  check('no straddle heads-up', hand.straddleSeat === null);
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

console.log(`betting: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
