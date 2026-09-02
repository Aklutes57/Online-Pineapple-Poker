// Hand evaluation for 747 Poker: fours are fully wild (any rank, any suit),
// and a Natural Seven — two or more REAL sevens among the ORIGINAL four cards
// — beats everything. Anything else is simply the best ordinary five-card hand
// the wilds can build.
//
// There is deliberately no "five of a kind": with four wild cards in the deck
// it is common enough to stop being a hand and start being an artefact, so
// five sevens is scored as the quads-plus-kicker it can also be read as.
//
// Scores extend the standard packed integer from evaluator.js
// (category << 20 | tiebreakers), with one category above straight flush:
//   10 natural seven
// so every 747 score compares directly against every standard score.

import { rank5 } from './evaluator.js';
import { describe as describeStandard } from './evaluator.js';
import { RANK_CHARS, SUIT_CHARS } from './deck.js';

export const CATEGORY_747 = {
  NATURAL_SEVEN: 10,
};

const RANK_PLURALS = [
  'Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines',
  'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];
const RANK_NAMES = [
  'Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Jack', 'Queen', 'King', 'Ace',
];

export const NATURAL_SEVEN_SCORE = CATEGORY_747.NATURAL_SEVEN << 20;

// The Natural Seven is judged on the four ORIGINAL cards only, before the
// fifth card: two or more REAL sevens and you hold the best hand in the game.
// Wilds neither help nor hurt — 7♠ 7♥ Q♦ 5♣ and 7♦ 4♣ 7♠ K♦ are both Natural
// Sevens — and a third or fourth seven is still just a Natural Seven, which
// is why this counts rather than compares. The only hand that beats one is
// another one, and a tie goes to the house.
export function isNaturalSeven(originalFour) {
  return originalFour.filter((c) => c[0] === '7').length >= 2;
}

function isWild(card) {
  return card[0] === '4';
}

// Evaluates five cards with every four treated as a fully wild card.
// Enumeration is split in two, which keeps it exact and fast:
//  - rank-only: wilds get deliberately clashing suits, covering five of a
//    kind, quads, boats, trips, straights, pairs;
//  - suited: only possible when every natural card shares one suit, wilds
//    join that suit, covering flushes and straight flushes.
// 13^k rank choices per pass (k = wild count, at most 4), so the worst case
// is a few tens of thousands of cheap evaluations.
export function evaluate747(cards5) {
  const naturals = cards5.filter((c) => !isWild(c));
  const wildCount = cards5.length - naturals.length;

  if (wildCount === 0) return rank5(cards5);

  // Five wilds is physically impossible — there are only four fours — but the
  // suit lookups below would read off the end if it ever happened.
  if (naturals.length === 0) return rank5(['As', 'Ks', 'Qs', 'Js', 'Ts']);

  // Note there is no shortcut for four wilds + one natural. It looks like it
  // ought to be quads of that rank, but the wilds can just as well take the
  // suit and the ranks around it: A♥ + four fours is a royal flush, which
  // beats quad aces. Enumeration is the only thing that gets that right —
  // 13^4 assignments, about 50ms, which is worth paying for a hand that turns
  // up once in fifty thousand deals (you have to hold all four fours).

  let best = -1;

  // Pass 1: ranks only. Assign each wild a suit that cannot complete a
  // flush by cycling suits different from the first natural's.
  const clashSuits = SUIT_CHARS.split('').filter((s) => s !== naturals[0][1]);
  best = Math.max(best, enumerate(naturals, wildCount, null, clashSuits));

  // Pass 2: flushes, only reachable when the naturals are already one suit.
  const suit = naturals[0][1];
  if (naturals.every((c) => c[1] === suit)) {
    best = Math.max(best, enumerate(naturals, wildCount, suit, null));
  }

  return best;
}

function enumerate(naturals, wildCount, flushSuit, clashSuits) {
  let best = -1;
  const chosen = new Array(wildCount);

  (function pick(depth) {
    if (depth === wildCount) {
      const cards = [...naturals];
      for (let i = 0; i < wildCount; i++) {
        const suitChar = flushSuit ?? clashSuits[i % clashSuits.length];
        cards.push(RANK_CHARS[chosen[i]] + suitChar);
      }
      // Straight from rank5: an assignment that makes all five the same rank
      // scores as a high card there, so the maximiser simply never picks it —
      // which is exactly how five of a kind stops being a hand.
      const score = rank5(cards);
      if (score > best) best = score;
      return;
    }
    for (let r = 0; r < 13; r++) {
      chosen[depth] = r;
      pick(depth + 1);
    }
  })(0);

  return best;
}

// Mid-hand readout for a four-card 747 hand: Natural Seven outranks all,
// then the best rank-multiple wilds can complete. Straights and flushes
// aren't callable from four cards, so this stays deliberately simple.
export function describePartial747(cards4) {
  if (isNaturalSeven(cards4)) return 'NATURAL SEVEN';
  const wilds = cards4.filter(isWild).length;
  const naturals = cards4.filter((c) => !isWild(c));
  if (naturals.length === 0) return 'Four Wilds';
  let bestRank = -1;
  let bestCount = 0;
  const counts = new Map();
  for (const c of naturals) {
    const r = RANK_CHARS.indexOf(c[0]);
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  for (const [rank, count] of counts) {
    if (count > bestCount || (count === bestCount && rank > bestRank)) {
      bestCount = count;
      bestRank = rank;
    }
  }
  const total = Math.min(bestCount + wilds, 4);
  if (total >= 4) return `Four of a Kind, ${RANK_PLURALS[bestRank]}`;
  if (total === 3) return `Three of a Kind, ${RANK_PLURALS[bestRank]}`;
  if (total === 2) return `Pair of ${RANK_PLURALS[bestRank]}`;
  return `${RANK_NAMES[bestRank]} High`;
}

export function describe747(score) {
  const category = score >> 20;
  if (category === CATEGORY_747.NATURAL_SEVEN) return 'Natural Seven';
  return describeStandard(score);
}
