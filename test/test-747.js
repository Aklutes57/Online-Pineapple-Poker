// 747 Poker: evaluator (wild fours, Five of a Kind, Natural Seven) and the
// Hand747 engine (antes, simultaneous decisions, countdown, dealer showdown,
// carry pot). Chip conservation is asserted after every finished hand.

import {
  evaluate747, describe747, describePartial747, isNaturalSeven, NATURAL_SEVEN_SCORE, CATEGORY_747,
} from '../server/evaluator747.js';
import { rank5 } from '../server/evaluator.js';
import { Hand747 } from '../server/hand747.js';
import { sanitizeSettings } from '../server/game.js';
import { PHASES, VARIANTS } from '../shared/constants.js';

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

// ---- evaluator ----

check('natural seven: two real sevens', isNaturalSeven(['7s', '7h', 'Qd', '5c']));
check('natural seven: a four disqualifies', !isNaturalSeven(['7d', '4c', '7s', 'Kd']));
check('natural seven: one seven is not enough', !isNaturalSeven(['7d', '2c', '9s', 'Kd']));
check('natural seven: three sevens is not exactly two', !isNaturalSeven(['7d', '7c', '7s', 'Kd']));
check('natural seven outranks five of a kind',
  NATURAL_SEVEN_SCORE > evaluate747(['4c', '4d', '4h', '4s', 'Ah']));

check('no wilds falls through to rank5',
  evaluate747(['As', 'Kd', 'Qh', 'Jc', '9s']) === rank5(['As', 'Kd', 'Qh', 'Jc', '9s']));

check('four wilds + ace = five aces',
  describe747(evaluate747(['4c', '4d', '4h', '4s', 'Ah'])) === 'Five of a Kind, Aces');
check('two wilds + three aces = five aces',
  describe747(evaluate747(['As', 'Ah', 'Ad', '4c', '4d'])) === 'Five of a Kind, Aces');
check('five aces beat five kings',
  evaluate747(['4c', '4d', '4h', '4s', 'Ah']) > evaluate747(['Ks', 'Kh', 'Kd', '4c', '4d']));
check('five of a kind beats a natural straight flush',
  evaluate747(['Ks', 'Kh', 'Kd', '4c', '4d']) > rank5(['As', 'Ks', 'Qs', 'Js', 'Ts']));

check('wild completes a royal flush',
  describe747(evaluate747(['As', 'Ks', 'Qs', 'Js', '4h'])) === 'Royal Flush');
check('wild completes a straight flush when naturals are suited',
  describe747(evaluate747(['5s', '6s', '7s', '8s', '4h'])) === 'Straight Flush, Nine high');
check('wild completes a straight',
  (evaluate747(['5c', '6d', '7s', '8h', '4h']) >> 20) === 4);
check('wild makes quads from trips',
  describe747(evaluate747(['Ks', 'Kh', 'Kd', '4c', '2s'])) === 'Four of a Kind, Kings');
check('wild upgrades two pair to the better full house',
  describe747(evaluate747(['2s', '2h', '3d', '3c', '4h'])) === 'Full House, Threes full of Deuces');
check('wild never counts as a mere four',
  (evaluate747(['4s', 'Ah', '9d', '6c', '2h']) >> 20) >= 1); // at least a pair of aces

check('partial: natural seven readout', describePartial747(['7s', '7h', 'Qd', '5c']) === 'NATURAL SEVEN');
check('partial: wild pairs the kicker', describePartial747(['4s', 'Kh', '2d', '3c']) === 'Pair of Kings');
check('partial: two wilds make trips', describePartial747(['4s', '4h', 'Kd', '2c']) === 'Three of a Kind, Kings');
check('partial: high card is a full word', describePartial747(['2c', '3d', '5h', '6s']) === 'Six High');
check('partial: four wilds', describePartial747(['4s', '4h', '4d', '4c']) === 'Four Wilds');

check('CATEGORY_747 sits above straight flush',
  CATEGORY_747.FIVE_OF_A_KIND === 9 && CATEGORY_747.NATURAL_SEVEN === 10);

// Every declared variant must survive settings sanitization — a stale
// whitelist here once silently turned 747 tables into hold'em.
for (const key of Object.keys(VARIANTS)) {
  check(`sanitizeSettings keeps variant ${key}`,
    sanitizeSettings({ variant: key }).variant === key);
}

// ---- engine ----

function makePlayer(seatIndex, stack, nickname) {
  return {
    id: `p${seatIndex}`, nickname: nickname || `p${seatIndex}`, seatIndex,
    stack, sittingOut: false, connected: true,
  };
}

function makeCtx() {
  return {
    logs: [],
    timer: null,
    finishedFlag: false,
    log(t) { this.logs.push(t); },
    changed() {},
    finished() { this.finishedFlag = true; },
    carried: 0,
    carryOut(amount) { this.carried += amount; },
    setTimer(name, ms, fn) { this.timer = { name, ms, fn }; },
    clearTimer() { this.timer = null; },
    fire() {
      const t = this.timer;
      if (!t) throw new Error('no timer to fire');
      this.timer = null;
      t.fn();
    },
  };
}

function make747({
  players, deck, buttonSeat = 0, bb = 10, actionTime = 30, carryIn = 0,
  ante = 0, penaltyCap = 0,
}) {
  const ctx = makeCtx();
  const hand = new Hand747({
    handNo: 1, smallBlind: bb / 2, bigBlind: bb, actionTime,
    buttonSeat, players, deck, ctx, carryIn, ante, penaltyCap,
  });
  hand.start();
  return { hand, ctx };
}

function totalChips(players) {
  return players.reduce((a, p) => a + p.stack, 0);
}

function conserve(name, players, before, hand, carryIn = 0) {
  check(`${name}: chips conserved`,
    totalChips(players) + (hand.results?.carryOut ?? 0) === before + carryIn);
}

// Basic flow: antes, four cards each, hidden dealer hand, decision phase.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  const { hand, ctx } = make747({ players, deck: null });
  check('start: everyone anted', players.every((p) => p.stack === 90 && p.totalCommitted === 10));
  check('start: four cards each', players.every((p) => p.holeCards.length === 4));
  check('start: originalFour snapshot', players.every((p) => p.originalFour.length === 4));
  check('start: dealer has four hidden cards',
    hand.dealerCards.length === 4 && hand.dealerView().cards === null && hand.dealerView().cardCount === 4);
  check('start: decision phase with a timer',
    hand.phase === PHASES.DECISION_747 && ctx.timer?.name === 'decision747');
  check('start: nobody is "to act"', hand.toActSeat === null);
  check('betting is refused', hand.handleAction(players[0], { kind: 'bet', amount: 5 }).ok === false);
  check('discard is refused', hand.handleDiscard(players[0], 0).ok === false);
}

// One stayer beats the dealer and takes the whole pot.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  const before = totalChips(players);
  // Deal order from button 0: seat1, seat2, seat0, dealer; fifths in the same order.
  const deck = [
    'As', 'Ah', 'Ad', 'Kc', // seat 1 — stays, makes quad aces
    '2c', '3d', '8h', '9s', // seat 2 — stays, misses
    'Jd', 'Jh', 'Js', 'Jc', // seat 0 — folds
    'Kd', 'Kh', '5s', '6d', // dealer — pair of kings
    'Ac', 'Th', '2d',       // fifths: seat1, seat2, dealer
  ];
  const { hand, ctx } = make747({ players, deck });
  check('decision accepted', hand.handleDecision(players[1], true).ok);
  check('double decision refused', hand.handleDecision(players[1], true).ok === false);
  hand.handleDecision(players[2], true);
  check('still in decision until everyone locks', hand.phase === PHASES.DECISION_747);
  hand.handleDecision(players[0], false);
  check('all locked -> countdown', hand.phase === PHASES.COUNTDOWN_747 && ctx.timer?.name === 'countdown747');
  ctx.fire(); // countdown ends -> reveal
  check('hand finished', hand.finished && ctx.finishedFlag);
  check('folder is folded, ante stays in pot', players[0].folded && players[0].stack === 90);
  check('stayers have five cards', players[1].holeCards.length === 5 && players[2].holeCards.length === 5);
  check('dealer revealed with five cards',
    hand.dealerView().cards?.length === 5 && hand.dealerView().desc === 'Pair of Kings');
  check('quad aces beat the dealer', players[1].stack === 90 + 30);
  check('loser paid the ante and no more', players[2].stack === 90);
  check('winner recorded', hand.results.winners.length === 1 && hand.results.winners[0].seat === 1);
  check('hand results describe the win', players[1].handResult.desc === 'Four of a Kind, Aces');
  check('no carry out', hand.results.carryOut === 0);
  conserve('single winner', players, before, hand);
}

// Natural Seven beats even the dealer's Five of a Kind.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100)];
  const before = totalChips(players);
  const deck = [
    '7s', '7h', 'Kd', '5c', // seat 1 — NATURAL SEVEN
    '2c', '3c', '9d', 'Th', // seat 0 — stays, queen high
    '4c', '4d', '4h', '4s', // dealer — four wilds
    'Jd', 'Qh', 'Ah',       // fifths: seat1, seat0, dealer (five aces)
  ];
  const { hand, ctx } = make747({ players, deck });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[0], true);
  ctx.fire();
  check('natural seven wins automatically', players[1].stack === 90 + 20);
  check('natural seven seat recorded', hand.results.naturalSevenSeats.includes(1));
  check('natural seven described', players[1].handResult.desc === 'Natural Seven');
  check('dealer had five of a kind', hand.results.dealer.desc === 'Five of a Kind, Aces');
  conserve('natural seven', players, before, hand);
}

// An exact tie loses to the dealer: the pot rides.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100)];
  const before = totalChips(players);
  const deck = [
    'Ks', 'Kc', '8d', '6h', // seat 1 — pair of kings, 8-6-2 kickers
    '3s', '5h', '9c', 'Tc', // seat 0 — folds
    'Kd', 'Kh', '8c', '6s', // dealer — identical pair of kings
    '2h', '2d',             // fifths: seat1, dealer
  ];
  const { hand, ctx } = make747({ players, deck });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  check('tie loses to the dealer', players[1].stack === 90);
  check('tied pot rides', hand.results.carryOut === 20);
  check('the ride is handed to the game before the broadcast', ctx.carried === 20);
  check('no winners on a sweep', hand.results.winners.length === 0);
  check('a 747 folder may show after the hand', hand.handleShowCards(players[0]).ok);
  check('a 747 stayer may not re-show', !hand.handleShowCards(players[1]).ok);
  conserve('tie sweep', players, before, hand);
}

// Everyone folds: no fifth cards, the dealer sweeps the antes.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  const before = totalChips(players);
  const { hand, ctx } = make747({ players, deck: null });
  hand.handleDecision(players[0], false);
  hand.handleDecision(players[1], false);
  hand.handleDecision(players[2], false);
  ctx.fire();
  check('all-fold: finished', hand.finished);
  check('all-fold: dealer keeps four cards', hand.dealerCards.length === 4);
  check('all-fold: whole pot rides', hand.results.carryOut === 30);
  conserve('all fold', players, before, hand);
}

// A riding pot joins the antes and goes to the winner.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100)];
  const before = totalChips(players);
  const deck = [
    'As', 'Ah', 'Ad', 'Kc', // seat 1 — quads
    '2c', '3c', '9d', 'Th', // seat 0 — folds
    'Kd', 'Kh', '5s', '6d', // dealer
    'Ac', '2d',             // fifths: seat1, dealer
  ];
  const { hand, ctx } = make747({ players, deck, carryIn: 50 });
  check('carry shows in the collected pot', hand.collectedPot() === 20 + 50);
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  check('winner takes antes plus the riding pot', players[1].stack === 90 + 70);
  conserve('carry in', players, before, hand, 50);
}

// A dead-exact tie for best hand is not a loss to anyone: both hold players
// challenge the dealer together and split, odd chip clockwise from the button.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  const before = totalChips(players);
  const { hand, ctx } = make747({
    players,
    deck: [
      'As', 'Ks', 'Qs', 'Js', // seat 1
      'Ah', 'Kh', 'Qh', 'Jh', // seat 2
      '2c', '3c', '9d', '8c', // seat 0 — folds
      '8d', '8s', '5s', '6d', // dealer
      'Ts', 'Th', '2d',       // fifths: two royal flushes, dealer pairs eights
    ],
    carryIn: 5,
    penaltyCap: 25,
  });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[2], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  const pot = 30 + 5;
  const w1 = hand.results.winners.find((w) => w.seat === 1)?.amount ?? 0;
  const w2 = hand.results.winners.find((w) => w.seat === 2)?.amount ?? 0;
  check('tied best hands both play the dealer', w1 > 0 && w2 > 0);
  check('split covers the whole pot', w1 + w2 === pot);
  check('split is near-even', Math.abs(w1 - w2) <= 1);
  check('a tie for best carries no penalty', (hand.results.penalties || []).length === 0);
  conserve('split pot', players, before, hand, 5);
}

// Losing to another player: only the best hand plays the dealer, and the
// beaten holder pays min(pot, cap) into the NEXT pot — never into this one.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  const before = totalChips(players);
  const { hand, ctx } = make747({
    players,
    deck: [
      'As', 'Ah', 'Ad', 'Jc', // seat 1 -> quad aces with the fifth
      'Ks', 'Kh', 'Kd', 'Qc', // seat 2 -> quad kings with the fifth
      '2c', '3c', '9d', '8c', // seat 0 — folds
      '8d', '8s', '5s', '6d', // dealer -> pair of eights
      'Ac', 'Kc', '2d',
    ],
    penaltyCap: 25,
  });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[2], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  const pot = 30; // three antes of 10, read before any penalty
  check('only the best holder plays the dealer',
    hand.results.winners.length === 1 && hand.results.winners[0].seat === 1);
  check('the beaten holder pays the pot, capped',
    hand.results.penalties.length === 1
    && hand.results.penalties[0].seat === 2
    && hand.results.penalties[0].amount === 25
    && hand.results.penalties[0].to === 'player');
  check('the winner takes only the pot that was already there',
    hand.results.winners[0].amount === pot && players[1].stack === 90 + pot);
  check('the penalty rides to the next pot, not this one',
    hand.results.carryOut === 25 && ctx.carried === 25);
  check('the beaten holder actually paid', players[2].stack === 90 - 25);
  conserve('lost to a player', players, before, hand);
}

// Losing to the dealer pays the same penalty, and the pot rides on top of it.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100)];
  const before = totalChips(players);
  const { hand, ctx } = make747({
    players,
    deck: [
      '2c', '3d', '9h', '8c', // seat 1 -> junk
      'Ts', 'Jd', '5h', '6c', // seat 0 — folds
      'As', 'Ah', 'Ad', 'Ac', // dealer -> quad aces
      '7d', '2s',             // fifths: seat 1, dealer
    ],
    penaltyCap: 25,
  });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  const pot = 20;
  check('nobody beats the dealer', hand.results.winners.length === 0);
  check('the challenger pays for losing to the dealer',
    hand.results.penalties.length === 1
    && hand.results.penalties[0].to === 'dealer'
    && hand.results.penalties[0].amount === 20); // pot < cap, so pay the pot
  check('pot plus penalty both ride', hand.results.carryOut === pot + 20);
  conserve('lost to the dealer', players, before, hand);
}

// A short stack pays only what it has, and penalties are off when the cap is 0.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 15)];
  const before = totalChips(players);
  const { hand, ctx } = make747({
    players,
    deck: [
      'As', 'Ah', 'Ad', 'Jc', // seat 1 -> quad aces
      'Ks', 'Kh', 'Kd', 'Qc', // seat 2 -> quad kings, only 5 chips left after the ante
      '2c', '3c', '9d', '8c', // seat 0 — folds
      '8d', '8s', '5s', '6d', // dealer
      'Ac', 'Kc', '2d',
    ],
    penaltyCap: 25,
  });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[2], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  check('a short stack pays what it has and no more',
    hand.results.penalties[0].amount === 5 && players[2].stack === 0);
  conserve('short-stack penalty', players, before, hand);
}
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  const before = totalChips(players);
  const { hand, ctx } = make747({
    players,
    deck: [
      'As', 'Ah', 'Ad', 'Jc',
      'Ks', 'Kh', 'Kd', 'Qc',
      '2c', '3c', '9d', '8c',
      '8d', '8s', '5s', '6d',
      'Ac', 'Kc', '2d',
    ],
    penaltyCap: 0, // penalties off
  });
  hand.handleDecision(players[1], true);
  hand.handleDecision(players[2], true);
  hand.handleDecision(players[0], false);
  ctx.fire();
  check('a zero cap turns penalties off',
    hand.results.penalties.length === 0 && players[2].stack === 90);
  conserve('penalties off', players, before, hand);
}

// A host-set ante replaces the big-blind alias.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100)];
  const { hand } = make747({ players, deck: null, bb: 10, ante: 3 });
  check('the host-set ante is what everyone posts',
    hand.ante === 3 && players.every((p) => p.stack === 97 && p.totalCommitted === 3));
}

// Timed table: the decision timer folds anyone still undecided.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100)];
  const { hand, ctx } = make747({ players, deck: null, actionTime: 30 });
  hand.handleDecision(players[0], true);
  ctx.fire(); // decision timeout — seat 1 never chose
  check('timeout folds the undecided', hand.phase === PHASES.COUNTDOWN_747 && players[1].decision747 === 'fold');
  ctx.fire(); // countdown
  check('timeout hand finishes', hand.finished);
}

// Untimed table: the fallback timer only folds the disconnected.
{
  const players = [makePlayer(0, 100), makePlayer(1, 100), makePlayer(2, 100)];
  players[2].connected = false;
  const { hand, ctx } = make747({ players, deck: null, actionTime: 0 });
  ctx.fire(); // fallback fires
  check('untimed: absent player folded', players[2].decision747 === 'fold');
  check('untimed: present players still deciding',
    hand.phase === PHASES.DECISION_747 && players[0].decision747 === null);
  check('untimed: timer re-armed', ctx.timer?.name === 'decision747');
}

// Guards.
{
  let threw = false;
  try {
    const many = Array.from({ length: 10 }, (_, i) => makePlayer(i, 100));
    new Hand747({
      handNo: 1, smallBlind: 5, bigBlind: 10, actionTime: 30,
      buttonSeat: 0, players: many, deck: null, ctx: makeCtx(),
    });
  } catch { threw = true; }
  check('ten players refused (deck limit)', threw);
}

console.log(`747: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
