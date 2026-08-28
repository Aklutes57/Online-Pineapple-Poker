// Seven Card Stud: no blinds, an ante from everyone, a forced bring-in from
// the lowest card showing, and — from fourth street on — position decided by
// the best hand showing rather than by the button.
// Usage: node test/test-stud.js

import { Hand } from '../server/hand.js';
import * as betting from '../server/betting.js';
import { availableActionsFor } from '../server/betting.js';

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
    log(t) { this.logs.push(t); }, changed() {}, finished() {},
    setTimer(n, ms, fn) { this.timer = { name: n, ms, fn }; }, clearTimer() { this.timer = null; },
    markAway(p) { p.sittingOut = true; },
    fire() { const t = this.timer; if (!t) throw new Error('no timer'); this.timer = null; t.fn(); },
    fireAll() { let g = 0; while (this.timer && g++ < 80) this.fire(); },
  };
}

function makeHand({ players, deck, buttonSeat = 0 }) {
  const ctx = makeCtx();
  const hand = new Hand({
    handNo: 1, variantKey: 'sevenCardStud', smallBlind: 1, bigBlind: 2,
    actionTime: 30, buttonSeat, players, deck, ctx, options: {},
  });
  return { hand, ctx };
}

const act = (hand, seat, a, amt = null) => {
  const r = hand.handleAction(hand.bySeat.get(seat), a, amt);
  if (!r.ok) throw new Error(`seat ${seat} ${a}: ${r.error}`);
};
const totalChips = (players) => players.reduce((a, p) => a + p.stack + p.totalCommitted, 0);

// Deal order is one card at a time from the button's left, so with two players
// and button 0: seat1 takes deck[0,2,4...], seat0 takes deck[1,3,5...].
// Seat 1's up card is deck[4]; seat 0's is deck[5].
const DECK = [
  'Ah', 'Kh',   // down 1  -> seat1 Ah, seat0 Kh
  'Ad', 'Kd',   // down 2  -> seat1 Ad, seat0 Kd
  '2c', 'Qs',   // up      -> seat1 2c (low: brings it in), seat0 Qs
  '3h', '4h',   // fourth
  '5h', '6h',   // fifth
  '7h', '8h',   // sixth
  '9h', 'Th',   // seventh (down)
  'Jc', 'Jd', 'Js', 'Qc', 'Qd', 'Tc', 'Td',
];

// ---- the deal, the ante and the bring-in ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand } = makeHand({ players, deck: DECK });
  hand.start();

  check('three cards each on third street',
    hand.bySeat.get(0).holeCards.length === 3 && hand.bySeat.get(1).holeCards.length === 3);
  check('exactly one of them is face up',
    hand.bySeat.get(0).upCards.length === 1 && hand.bySeat.get(1).upCards.length === 1);
  check('the up card is the last one dealt',
    hand.bySeat.get(1).upCards[0] === '2c' && hand.bySeat.get(0).upCards[0] === 'Qs');
  check('no board is dealt', hand.board.length === 0);

  check('everyone antes', hand.bySeat.get(0).totalCommitted >= 1
    && hand.bySeat.get(1).totalCommitted >= 1);
  check('the lowest card showing brings it in', hand.bringInSeat === 1);
  check('the bring-in is a real bet', hand.currentBet === 2);
  check('the ante is dead money, not part of the bet',
    hand.bySeat.get(0).betThisRound === 0);
  check('the pot holds both antes and the bring-in', betting.potTotal(hand) === 1 + 1 + 2);
  check('action opens to the left of the bring-in', hand.toActSeat === 0);
}

// ---- suits break a tie for the bring-in ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  // Both show a five; clubs is the lowest suit, so seat 1 brings it in.
  const deck = ['Ah','Kh','Ad','Kd', '5c','5s', '2h','3h','4h','6h','7h','8h','9h','Th','Jc','Jd','Js'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  check('clubs is lower than spades for the bring-in', hand.bringInSeat === 1);
}

// ---- from fourth street, the best board speaks first ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand } = makeHand({ players, deck: DECK });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  check('fourth street is reached', hand.street === 'fourth');
  check('two cards showing each now',
    hand.bySeat.get(0).upCards.length === 2 && hand.bySeat.get(1).upCards.length === 2);
  // seat0 shows Qs 4h, seat1 shows 2c 3h — queen high is the better board.
  check('the best board showing acts first', hand.toActSeat === 0);
}

// ---- a pair showing outranks a high card ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  //                down1      down2      up(3rd)    up(4th)
  const deck = ['Ah','Kh', 'Ad','Kd', '9c','Qs', '9d','2h',
                '5h','6h','7h','8h','3c','4c','Jc','Jd','Js'];
  const { hand } = makeHand({ players, deck });
  hand.start();
  act(hand, hand.toActSeat, 'call');
  act(hand, hand.toActSeat, 'check');
  // seat1 shows 9c 9d (a pair), seat0 shows Qs 2h (queen high).
  check('a pair showing beats a queen high board', hand.toActSeat === 1);
}

// ---- seven streets, four up and three down ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  const { hand, ctx } = makeHand({ players, deck: DECK });
  hand.start();
  act(hand, 0, 'call');
  act(hand, 1, 'check');
  for (const street of ['fourth', 'fifth', 'sixth', 'seventh']) {
    check(`${street} street is reached`, hand.street === street);
    if (hand.finished) break;
    act(hand, hand.toActSeat, 'check');
    act(hand, hand.toActSeat, 'check');
  }
  ctx.fireAll();
  const p0 = hand.bySeat.get(0);
  check('seven cards each by the end', p0.holeCards.length === 7);
  check('four of them ended face up', p0.upCards.length === 4);
  check('the last card is dealt face down',
    !p0.upCards.includes(p0.holeCards[6]));
  check('the hand finished', hand.finished === true);
  check('chips are conserved', totalChips(players) === 400);
}

// ---- the showdown reads the best five of seven ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b')];
  //             down1       down2       3rd up      4th        5th        6th        7th down
  const deck = ['2d','Ac', '7s','Ah', '8c','As', '9h','Ad', 'Jd','3c', 'Qd','4c', 'Kd','5c'];
  // seat1 = 2d 7s 8c 9h Jd Qd Kd (nothing), seat0 = Ac Ah As Ad 3c 4c 5c (quad aces)
  const { hand, ctx } = makeHand({ players, deck });
  hand.start();
  // Only three aces are out on third street; the fourth arrives on fourth.
  check('seat 0 starts with three aces',
    ['Ac','Ah','As'].every((c) => hand.bySeat.get(0).holeCards.includes(c)));
  let guard = 0;
  while (!hand.finished && guard++ < 30) {
    const seat = hand.toActSeat;
    if (seat === null) { if (ctx.timer) { ctx.fire(); continue; } break; }
    const av = availableActionsFor(hand, hand.bySeat.get(seat));
    act(hand, seat, av.canCheck ? 'check' : 'call');
  }
  ctx.fireAll();
  check('the fourth ace arrived on fourth street',
    hand.bySeat.get(0).holeCards.includes('Ad'));
  check('the four aces win', hand.results.winners.some((w) => w.seat === 0));
  check('and are described from the best five of seven',
    /Four of a Kind/.test(hand.bySeat.get(0).handResult.desc));
  check('chips conserved through the showdown', totalChips(players) === 400);
}

// ---- everyone all in on third street ----
{
  // The riskiest path in the game: no betting decisions are left, so the last
  // four streets have to deal themselves out on the run-out clock and still
  // reach a scored showdown with the chips intact.
  const players = [makePlayer(0, 60, 'a'), makePlayer(1, 60, 'b')];
  const { hand, ctx } = makeHand({ players, deck: DECK });
  hand.start();
  // The ante is already out, so shove for whatever is actually left.
  const shove = availableActionsFor(hand, hand.bySeat.get(hand.toActSeat)).maxRaiseTo;
  act(hand, hand.toActSeat, 'raise', shove);
  act(hand, hand.toActSeat, 'call');
  check('both players are all in on third street',
    hand.bySeat.get(0).allIn && hand.bySeat.get(1).allIn);
  ctx.fireAll();
  check('the run-out deals the remaining streets', hand.finished === true);
  check('seven cards each were dealt',
    hand.bySeat.get(0).holeCards.length === 7 && hand.bySeat.get(1).holeCards.length === 7);
  check('somebody won the pot', (hand.results.winners || []).length >= 1);
  check('chips are conserved through an all-in run-out',
    totalChips(players) === 120);
  check('a boardless game publishes no run-out odds', hand.equityNow === null);
}

// ---- a folded player's cards go back down ----
{
  const players = [makePlayer(0, 200, 'a'), makePlayer(1, 200, 'b'), makePlayer(2, 200, 'c')];
  const deck = [
    'Ah','Kh','Qh', 'Ad','Kd','Qd', '2c','3d','4h',   // third street, one at a time
    '5c','6d','7h', '8c','9d','Th', 'Jc','Qc','Kc', 'Ac','2d','3c',
    '4d','5d','6c','7d','8d','9c','Td','Jh','Js','Qs',
  ];
  const { hand } = makeHand({ players, deck });
  hand.start();
  const folder = hand.bySeat.get(hand.toActSeat);
  act(hand, folder.seatIndex, 'fold');
  check('a folded stud player keeps their cards on the server',
    folder.holeCards.length === 3);
  check('but they are dead and no longer dealt to',
    folder.folded === true);
}

console.log(`stud: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
