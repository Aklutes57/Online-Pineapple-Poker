import { rank5, best7, bestOmaha, describe, CATEGORY } from '../server/evaluator.js';

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
function cat(score) {
  return score >> 20;
}

// --- Category detection ---
check('straight flush', cat(rank5(['9h', '8h', '7h', '6h', '5h'])) === CATEGORY.STRAIGHT_FLUSH);
check('royal flush described', describe(rank5(['Ah', 'Kh', 'Qh', 'Jh', 'Th'])) === 'Royal Flush');
check('wheel straight flush', cat(rank5(['Ah', '2h', '3h', '4h', '5h'])) === CATEGORY.STRAIGHT_FLUSH);
check('quads', cat(rank5(['9h', '9c', '9d', '9s', '2h'])) === CATEGORY.QUADS);
check('full house', cat(rank5(['9h', '9c', '9d', '2s', '2h'])) === CATEGORY.FULL_HOUSE);
check('flush', cat(rank5(['Ah', 'Jh', '9h', '6h', '2h'])) === CATEGORY.FLUSH);
check('straight', cat(rank5(['9h', '8c', '7d', '6s', '5h'])) === CATEGORY.STRAIGHT);
check('wheel straight', cat(rank5(['Ah', '2c', '3d', '4s', '5h'])) === CATEGORY.STRAIGHT);
check('ace-high straight', cat(rank5(['Ah', 'Kc', 'Qd', 'Js', 'Th'])) === CATEGORY.STRAIGHT);
check('trips', cat(rank5(['9h', '9c', '9d', 'Ks', '2h'])) === CATEGORY.TRIPS);
check('two pair', cat(rank5(['9h', '9c', '2d', '2s', 'Kh'])) === CATEGORY.TWO_PAIR);
check('pair', cat(rank5(['9h', '9c', 'Qd', '7s', '2h'])) === CATEGORY.PAIR);
check('high card', cat(rank5(['Ah', 'Jc', '9d', '6s', '2h'])) === CATEGORY.HIGH_CARD);

// --- Not-straights that look close ---
check('K-A-2-3-4 is not a straight', cat(rank5(['Kh', 'Ac', '2d', '3s', '4h'])) === CATEGORY.HIGH_CARD);
check('QJT98 straight beats wheel', rank5(['Qh', 'Jc', 'Td', '9s', '8h']) > rank5(['Ah', '2c', '3d', '4s', '5h']));
check('six-high straight beats wheel', rank5(['6h', '5c', '4d', '3s', '2h']) > rank5(['Ah', '2c', '3d', '4s', '5h']));

// --- Kicker and tiebreaker ordering ---
check('AKQJ9 > AKQJ8', rank5(['Ah', 'Kc', 'Qd', 'Js', '9h']) > rank5(['Ad', 'Ks', 'Qh', 'Jc', '8d']));
check('pair kickers', rank5(['9h', '9c', 'Ad', 'Ks', '2h']) > rank5(['9d', '9s', 'Ah', 'Qc', 'Jd']));
check('two pair: high pair dominates', rank5(['Ah', 'Ac', '2d', '2s', '3h']) > rank5(['Kh', 'Kc', 'Qd', 'Qs', 'Ah']));
check('two pair kicker', rank5(['9h', '9c', '2d', '2s', 'Ah']) > rank5(['9d', '9s', '2h', '2c', 'Kh']));
check('full house: trips dominate', rank5(['9h', '9c', '9d', '2s', '2h']) > rank5(['8h', '8c', '8d', 'As', 'Ah']));
check('quads kicker', rank5(['9h', '9c', '9d', '9s', 'Ah']) > rank5(['9h', '9c', '9d', '9s', 'Kh']));
check('flush tiebreak on 2nd card', rank5(['Ah', 'Qh', '9h', '6h', '2h']) > rank5(['Ac', 'Jc', 'Tc', '9c', '8c']));
check('trips kicker', rank5(['9h', '9c', '9d', 'As', '3h']) > rank5(['9h', '9c', '9d', 'Ks', 'Qh']));

// --- Exact ties ---
check('identical ranks tie across suits', rank5(['Ah', 'Kc', 'Qd', 'Js', '9h']) === rank5(['As', 'Kh', 'Qc', 'Jd', '9c']));
check('straight ties across suits', rank5(['9h', '8c', '7d', '6s', '5h']) === rank5(['9c', '8d', '7s', '6h', '5c']));

// --- Category boundaries ---
check('trips beat two pair', rank5(['2h', '2c', '2d', '4s', '3h']) > rank5(['Ah', 'Ac', 'Kd', 'Ks', 'Qh']));
check('straight beats trips', rank5(['6h', '5c', '4d', '3s', '2h']) > rank5(['Ah', 'Ac', 'Ad', 'Ks', 'Qh']));
check('flush beats straight', rank5(['7h', '5h', '4h', '3h', '2h']) > rank5(['Ah', 'Kc', 'Qd', 'Js', 'Th']));
check('full house beats flush', rank5(['2h', '2c', '2d', '3s', '3h']) > rank5(['Ah', 'Kh', 'Qh', 'Jh', '9h']));
check('quads beat full house', rank5(['2h', '2c', '2d', '2s', '3h']) > rank5(['Ah', 'Ac', 'Ad', 'Ks', 'Kh']));
check('straight flush beats quads', rank5(['6h', '5h', '4h', '3h', '2h']) > rank5(['Ah', 'Ac', 'Ad', 'As', 'Kh']));

// --- best7 ---
{
  // Board plays: everyone's best five is the board straight.
  const { score, bestFive } = best7(['2h', '2c', 'Th', '9c', '8d', '7s', '6h']);
  check('best7 finds board straight over pair', cat(score) === CATEGORY.STRAIGHT);
  check('best7 bestFive has 5 cards', bestFive.length === 5);
}
{
  // Counterfeited two pair: 2s and 3s on A-A board -> aces up with best kicker.
  const a = best7(['3h', '3c', 'Ah', 'Ac', 'Kd', 'Qs', 'Jh']);
  check('best7 counterfeit picks better two pair', describe(a.score) === 'Two Pair, Aces and Threes');
}
{
  // Flush hidden in 7 cards.
  const { score } = best7(['Ah', '2h', 'Kh', '7h', '3h', '9c', '9d']);
  check('best7 finds flush over pair', cat(score) === CATEGORY.FLUSH);
}
{
  // 7-card straight uses the top 5.
  const a = best7(['9h', '8c', '7d', '6s', '5h', '4c', '3d']);
  check('best7 takes highest straight', describe(a.score) === 'Straight, Nine high');
}

// --- Omaha traps ---
{
  // Four hearts on board, only ONE heart in hand: no flush (must use exactly 2 hole cards).
  const { score } = bestOmaha(['Ah', 'Kc', 'Qd', 'Js'], ['2h', '5h', '9h', 'Th', '3c']);
  check('omaha: one hole heart is not a flush', cat(score) !== CATEGORY.FLUSH);
}
{
  // Two hearts in hand + three on board IS a flush.
  const { score } = bestOmaha(['Ah', '7h', 'Qd', 'Js'], ['2h', '5h', '9h', 'Tc', '3c']);
  check('omaha: two hole hearts make a flush', cat(score) === CATEGORY.FLUSH);
}
{
  // Board quads, no pocket pair: cannot play quads (only 3 board cards usable).
  const { score } = bestOmaha(['Ah', 'Kc', 'Qd', 'Js'], ['9h', '9c', '9d', '9s', '3c']);
  check('omaha: board quads unusable', cat(score) < CATEGORY.QUADS);
}
{
  // Must-use-2 straight: hand A2 with board 3-4-5-x-y makes a wheel.
  const { score } = bestOmaha(['Ah', '2c', 'Kd', 'Ks'], ['3h', '4c', '5d', 'Ts', 'Jc']);
  check('omaha: A2 wheel', cat(score) === CATEGORY.STRAIGHT);
}
{
  // Board straight but hand can't use two cards of it.
  const { score } = bestOmaha(['Ah', 'Ac', '2d', '2s'], ['9h', '8c', '7d', '6s', '5c']);
  check('omaha: board straight not playable without 2 connecting', cat(score) === CATEGORY.PAIR);
}

// --- describe() spot checks ---
check('describe two pair', describe(rank5(['Ah', 'Ac', '8d', '8s', '3h'])) === 'Two Pair, Aces and Eights');
check('describe full house', describe(rank5(['9h', '9c', '9d', '2s', '2h'])) === 'Full House, Nines full of Deuces');
check('describe high card', describe(rank5(['Ah', 'Jc', '9d', '6s', '2h'])) === 'Ace High');
check('describe wheel', describe(rank5(['Ah', '2c', '3d', '4s', '5h'])) === 'Straight, Five high');

// --- Omaha on a board that is not five cards yet ---
// The live "what do I have" readout asks on the flop and the turn too. Indexing
// fixed board positions 0-4 used to read past the end of a short board and rank
// the empty slots as cards, inventing pairs and trips: a flop readout would
// claim three of a kind on a hand that was ace high.
{
  const hole = ['Ah', 'Kh', '2c', '7d'];
  check('omaha flop uses only the three board cards',
    describe(bestOmaha(hole, ['3s', '4d', '9c']).score) === 'Ace High');
  check('omaha flop picks a legal five',
    bestOmaha(hole, ['3s', '4d', '9c']).bestFive.every((c) => typeof c === 'string'));
  check('omaha turn chooses three of the four board cards',
    describe(bestOmaha(hole, ['3s', '4d', '9c', 'Ks']).score) === 'Pair of Kings');
  check('omaha river is unchanged',
    describe(bestOmaha(hole, ['3s', '4d', '9c', 'Ks', '2d']).score) === 'Two Pair, Kings and Deuces');

  // Exactly two hole cards, always — a board that pairs up cannot borrow a
  // third card from the hand, and a hand that pairs up cannot play all four.
  check('omaha never plays three hole cards',
    describe(bestOmaha(['As', 'Ac', 'Ad', '7d'], ['Ah', '4d', '9c', 'Ks', '2d']).score)
      === 'Three of a Kind, Aces');
  // ...and exactly three board cards. Quads on the board are only trips in
  // Omaha, because the fourth king cannot be played.
  check('omaha never plays four board cards',
    describe(bestOmaha(['As', '2c', '3d', '4h'], ['Kh', 'Kc', 'Kd', 'Ks', '9c']).score)
      === 'Three of a Kind, Kings');

  // Not enough cards for a legal Omaha five: score -1, which callers read as
  // "nothing to describe yet" rather than as a real hand.
  check('omaha preflop cannot be scored', bestOmaha(hole, []).score === -1);
  check('omaha with two board cards cannot be scored', bestOmaha(hole, ['3s', '4d']).score === -1);
  check('omaha with one hole card cannot be scored',
    bestOmaha(['Ah'], ['3s', '4d', '9c', 'Ks', '2d']).score === -1);
  check('omaha survives a missing hand', bestOmaha(null, ['3s', '4d', '9c']).score === -1);

  // A short Pineapple-shaped hand must not be scored as if it were Omaha.
  check('omaha with three hole cards still plays exactly two',
    describe(bestOmaha(['Ah', 'Kh', '2c'], ['3s', '4d', '9c', 'Ks', '2d']).score)
      === 'Two Pair, Kings and Deuces');
}

console.log(`evaluator: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
