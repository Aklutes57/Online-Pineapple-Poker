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

function makeHand({ players, deck, variantKey = 'holdem', sb = 1, bb = 2, buttonSeat = 0, actionTime = 30 }) {
  const ctx = makeCtx();
  const hand = new Hand({
    handNo: 1, variantKey, smallBlind: sb, bigBlind: bb, actionTime,
    buttonSeat, players, deck, ctx,
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

// --- Pineapple: discard before the flop ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = [
    'Ah', 'Kh', '2c', 'Qs', 'Qd', '3d', // 3 each: seat1 then seat0
    '9s', 'Ts', 'Jh', '4c', '5s',
  ];
  const { hand } = makeHand({ players, deck, variantKey: 'pineapple' });
  hand.start();
  check('pineapple: three hole cards', hand.bySeat.get(0).holeCards.length === 3);
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('pineapple: discard before flop', hand.phase === PHASES.DISCARD_PREFLOP);
  check('pineapple: no board yet', hand.board.length === 0);
  const r = hand.handleDiscard(hand.bySeat.get(0), 2); // a drops 3d -> keeps Qs Qd
  check('pineapple: discard accepted', r.ok);
  const r2 = hand.handleDiscard(hand.bySeat.get(0), 0);
  check('pineapple: double discard rejected', !r2.ok);
  hand.handleDiscard(hand.bySeat.get(1), 2); // b drops 2c -> keeps Ah Kh
  check('pineapple: flop after discards', hand.phase === PHASES.FLOP && hand.board.length === 3);
  check('pineapple: two cards remain', hand.bySeat.get(0).holeCards.length === 2);
  // play to showdown: board 9s Ts Jh 4c 5s -> b has AhKh (K-high... A-high), a has QsQd pair
  act(hand, 1, 'check'); act(hand, 0, 'check');
  act(hand, 1, 'check'); act(hand, 0, 'check');
  act(hand, 1, 'check'); act(hand, 0, 'check');
  check('pineapple: showdown reached', hand.phase === PHASES.SHOWDOWN);
  check('pineapple: queens win', players[0].stack === 202 && players[1].stack === 198);
}

// --- Crazy Pineapple: discard after the flop betting round ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = [
    'Ah', 'Kh', '2c', 'Qs', 'Qd', '3d',
    '9s', 'Ts', 'Jh', '4c', '5s',
  ];
  const { hand } = makeHand({ players, deck, variantKey: 'crazyPineapple' });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('crazy: flop comes before discard', hand.phase === PHASES.FLOP && hand.board.length === 3);
  check('crazy: still three cards on flop', hand.bySeat.get(0).holeCards.length === 3);
  act(hand, 1, 'check');
  act(hand, 0, 'check');
  check('crazy: discard after flop betting', hand.phase === PHASES.DISCARD_POSTFLOP);
  hand.handleDiscard(hand.bySeat.get(0), 2);
  hand.handleDiscard(hand.bySeat.get(1), 2);
  check('crazy: turn after discards', hand.phase === PHASES.TURN && hand.board.length === 4);
}

// --- Discard timeout auto-discards the last card ---
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const deck = ['Ah', 'Kh', '2c', 'Qs', 'Qd', '3d', '9s', 'Ts', 'Jh', '4c', '5s'];
  const { hand, ctx } = makeHand({ players, deck, variantKey: 'pineapple' });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('discard timeout: timer armed', ctx.timer?.name === 'discard');
  ctx.fire();
  check('discard timeout: both auto-discarded', hand.bySeat.get(0).holeCards.length === 2 && hand.bySeat.get(1).holeCards.length === 2);
  check('discard timeout: last card dropped', !hand.bySeat.get(0).holeCards.includes('3d'));
  check('discard timeout: flop dealt', hand.phase === PHASES.FLOP);
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

console.log(`betting: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
