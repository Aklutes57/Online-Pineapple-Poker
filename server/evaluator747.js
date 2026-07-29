// Hand evaluation for 747 Poker: fours are fully wild (any rank, any suit),
// Five of a Kind outranks everything except a Natural Seven, and a Natural
// Seven — exactly two real sevens among the ORIGINAL four cards — beats all.
//
// Scores extend the standard packed integer from evaluator.js
// (category << 20 | tiebreakers), with two categories above straight flush:
//   9  five of a kind
//   10 natural seven
// so every 747 score compares directly against every standard score.

import { rank5 } from './evaluator.js';
import { describe as describeStandard } from './evaluator.js';
import { RANK_CHARS, SUIT_CHARS } from './deck.js';

export const CATEGORY_747 = {
  FIVE_OF_A_KIND: 9,
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

function fiveOfAKindScore(rankIndex) {
  return (CATEGORY_747.FIVE_OF_A_KIND << 20) | (rankIndex << 16);
}

// The Natural Seven is judged on the four ORIGINAL cards only, before the
// fifth card: exactly two real sevens, and no wildcard fours involved —
// per the rules, 7♠ 7♥ Q♦ 5♣ qualifies but 7♦ 4♣ 7♠ K♦ does not.
export function isNaturalSeven(originalFour) {
  const sevens = originalFour.filter((c) => c[0] === '7').length;
  const fours = originalFour.filter((c) => c[0] === '4').length;
  return sevens === 2 && fours === 0;
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

  // All wilds would be physically impossible past four, but guard anyway:
  // four wilds + one natural is always five of a kind of the natural's rank.
  if (naturals.length <= 1) {
    const rankIndex = naturals.length ? RANK_CHARS.indexOf(naturals[0][0]) : 12;
    return fiveOfAKindScore(rankIndex);
  }

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
      // rank5 has no concept of five of a kind, so count ranks first.
      const counts = new Map();
      for (const c of cards) {
        counts.set(c[0], (counts.get(c[0]) || 0) + 1);
      }
      let score;
      if (counts.size === 1) {
        score = fiveOfAKindScore(RANK_CHARS.indexOf(cards[0][0]));
      } else {
        score = rank5(cards);
      }
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
  if (category === CATEGORY_747.FIVE_OF_A_KIND) {
    return `Five of a Kind, ${RANK_PLURALS[(score >> 16) & 0xf]}`;
  }
  return describeStandard(score);
}
