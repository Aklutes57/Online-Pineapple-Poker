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

console.log(`evaluator: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
