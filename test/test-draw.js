// Five Card Draw: two betting rounds around an exchange, no board at all.
// The property that matters most here is that the deck is consumed in one
// fixed order no matter what order the players answer the draw in — that is
// what keeps the committed shuffle a proof rather than a race.
// Usage: node test/test-draw.js

import { Hand } from '../server/hand.js';
import { availableActionsFor } from '../server/betting.js';
import * as betting from '../server/betting.js';
import { PHASES } from '../shared/constants.js';

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}

const makePlayer = (s, stack, nick) =>
  ({ id: `p${s}`, nickname: nick || `p${s}`, seatIndex: s, stack, sittingOut: false, connected: true });

function makeCtx() {
  return {
    logs: [], timer: null,
    log(t) { this.logs.push(t); }, changed() {}, finished() { this.finishedFlag = true; },
    setTimer(n, ms, fn) { this.timer = { name: n, ms, fn }; }, clearTimer() { this.timer = null; },
    markAway(p) { p.sittingOut = true; },
    fire() { const t = this.timer; if (!t) throw new Error('no timer'); this.timer = null; t.fn(); },
    fireAll() { let g = 0; while (this.timer && g++ < 60) this.fire(); },
  };
}

function makeHand({ players, deck, buttonSeat = 0, options = {} }) {
  const ctx = makeCtx();
  const hand = new Hand({
    handNo: 1, variantKey: 'fiveCardDraw', smallBlind: 1, bigBlind: 2,
    actionTime: 30, buttonSeat, players, deck, ctx, options,
  });
  return { hand, ctx };
}

const act = (hand, seat, a, amt = null) => {
  const r = hand.handleAction(hand.bySeat.get(seat), a, amt);
  if (!r.ok) throw new Error(`seat ${seat} ${a}: ${r.error}`);
};
const totalChips = (players) => players.reduce((a, p) => a + p.stack + p.totalCommitted, 0);

// A deck with recognisable ranks so a swap is obvious.
const DECK = [
  '2c', '3c', '4c', '5c', '6c',      // first player from the button
  '7d', '8d', '9d', 'Td', 'Jd',      // second
  'Qh', 'Kh', 'Ah', '2s', '3s',      // replacements pool starts here
  '4s', '5s', '6s', '7s', '8s',
  '9s', 'Ts', 'Js', 'Qs', 'Ks',
];

// ---- the shape of the game ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand } = makeHand({ players, deck: DECK });
  hand.start();
  check('five cards each', hand.bySeat.get(0).holeCards.length === 5
    && hand.bySeat.get(1).holeCards.length === 5);
  check('no board is dealt', hand.board.length === 0);
  check('the opening street is the pre-draw round', hand.street === 'predraw');
  check('blinds are still posted', betting.potTotal(hand) === 3);
}

// ---- betting, draw, betting, showdown ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand, ctx } = makeHand({ players, deck: DECK });
  hand.start();
  act(hand, hand.toActSeat, 'call');
  act(hand, hand.toActSeat, 'check');
  check('the draw opens after the first betting round', hand.phase === PHASES.DRAW);
  check('nobody is on the clock during the draw', hand.toActSeat === null);

  const before = [...hand.bySeat.get(0).holeCards];
  check('drawing two is accepted', hand.handleDraw(hand.bySeat.get(0), [0, 1]).ok === true);
  check('cards are not swapped until everyone has answered',
    hand.bySeat.get(0).holeCards.join('') === before.join(''));
  check('standing pat is accepted', hand.handleDraw(hand.bySeat.get(1), []).ok === true);

  const after = hand.bySeat.get(0).holeCards;
  check('the draw still leaves five cards', after.length === 5);
  check('the kept cards are kept', after.includes(before[2]) && after.includes(before[3]));
  check('the thrown cards are gone', !after.includes(before[0]) && !after.includes(before[1]));
  check('a player who stood pat keeps their hand', hand.bySeat.get(1).holeCards.length === 5);
  check('the second betting round opens', hand.street === 'postdraw' && hand.toActSeat !== null);

  act(hand, hand.toActSeat, 'check');
  act(hand, hand.toActSeat, 'check');
  ctx.fireAll();
  check('the hand reaches showdown', hand.finished === true);
  check('chips are conserved', totalChips(players) === 400);
}

// ---- the deck is consumed in ONE order, whoever answers first ----
{
  // Same deck, same draws, opposite answer order. The hands must come out
  // identical, or the committed shuffle would mean different cards depending
  // on who clicked quickest.
  function run(answerOrder) {
    const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
    const { hand } = makeHand({ players, deck: DECK });
    hand.start();
    act(hand, hand.toActSeat, 'call');
    act(hand, hand.toActSeat, 'call');
    act(hand, hand.toActSeat, 'check');
    for (const seat of answerOrder) hand.handleDraw(hand.bySeat.get(seat), [0, 1]);
    return [0, 1, 2].map((s) => hand.bySeat.get(s).holeCards.join(' '));
  }
  const forwards = run([0, 1, 2]);
  const backwards = run([2, 1, 0]);
  const jumbled = run([1, 0, 2]);
  check('the draw is served in seat order, not answer order',
    forwards.join('|') === backwards.join('|') && forwards.join('|') === jumbled.join('|'));
}

// ---- refusals ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand } = makeHand({ players, deck: DECK });
  hand.start();
  check('you cannot draw before the draw', hand.handleDraw(hand.bySeat.get(0), [0]).ok === false);
  act(hand, hand.toActSeat, 'call');
  act(hand, hand.toActSeat, 'check');

  const p0 = hand.bySeat.get(0);
  check('a card you do not have is refused', hand.handleDraw(p0, [9]).ok === false);
  check('a negative index is refused', hand.handleDraw(p0, [-1]).ok === false);
  check('a duplicate index is refused', hand.handleDraw(p0, [1, 1]).ok === false);
  check('a fractional index is refused', hand.handleDraw(p0, [1.5]).ok === false);
  check('asking for more than five is refused', hand.handleDraw(p0, [0, 1, 2, 3, 4, 5]).ok === false);
  check('a non-list is refused', hand.handleDraw(p0, 'all').ok === false);
  check('drawing the whole hand is allowed', hand.handleDraw(p0, [0, 1, 2, 3, 4]).ok === true);
  check('you cannot draw twice', hand.handleDraw(p0, [0]).ok === false);
}

// ---- the timer stands you pat rather than throwing your hand away ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand, ctx } = makeHand({ players, deck: DECK });
  hand.start();
  act(hand, hand.toActSeat, 'call');
  act(hand, hand.toActSeat, 'check');
  const held = [...hand.bySeat.get(0).holeCards];
  ctx.fire(); // the draw clock runs out for both
  check('running out of time stands you pat',
    hand.bySeat.get(0).holeCards.join('') === held.join(''));
  check('and the hand carries on', hand.street === 'postdraw');
}

// ---- the showdown reads five cards, not seven ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  // Seat 1 is dealt first from the button here; give seat 0 the winner.
  const deck = [
    '2c', '7d', '9h', 'Js', '4c',      // seat 1: nothing
    'Ah', 'Ad', 'Ac', 'As', 'Kd',      // seat 0: quad aces
    'Qh', 'Qd', 'Qc', 'Qs', 'Jh',
  ];
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  check('seat 0 holds the quads', hand.bySeat.get(0).holeCards.join('') === 'AhAdAcAsKd');
  act(hand, hand.toActSeat, 'call');
  act(hand, hand.toActSeat, 'check');
  hand.handleDraw(hand.bySeat.get(0), []);
  hand.handleDraw(hand.bySeat.get(1), []);
  act(hand, hand.toActSeat, 'check');
  act(hand, hand.toActSeat, 'check');
  ctx.fireAll();
  check('the best five-card hand wins',
    hand.results.winners.length === 1 && hand.results.winners[0].seat === 0);
  check('and it is described from five cards',
    /Four of a Kind/.test(hand.bySeat.get(0).handResult.desc));
  check('chips conserved through the showdown', totalChips(players) === 400);
}

console.log(`draw: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
