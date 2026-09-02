// Dependency-free poker hand evaluator.
//
// rank5(cards) scores exactly five cards as a single comparable integer:
//   score = category<<20 | t1<<16 | t2<<12 | t3<<8 | t4<<4 | t5
// where category is 0 (high card) .. 8 (straight flush) and t1..t5 are
// tiebreaker ranks (0=deuce .. 12=ace) in order of significance.
// best7 picks the best 5 of 7; bestOmaha enforces exactly-2-hole-cards
// structurally by enumerating C(4,2) x C(5,3) combinations.

import { toInt, rankOf, suitOf, RANK_CHARS } from './deck.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

const RANK_NAMES = [
  'Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Jack', 'Queen', 'King', 'Ace',
];
const RANK_PLURALS = [
  'Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines',
  'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];

function pack(category, ranks) {
  let score = category << 20;
  for (let i = 0; i < 5; i++) score |= (ranks[i] ?? 0) << (16 - 4 * i);
  return score;
}

// Returns the top rank of a straight in this rank bitmask, or -1.
// The wheel (A-2-3-4-5) reports top rank 3 (the five).
function straightTop(mask) {
  for (let top = 12; top >= 3; top--) {
    let run = true;
    for (let k = 0; k < 5; k++) {
      const need = top - k;
      const bit = need === -1 ? 12 : need; // when top=3, the 5th card is the ace
      if (!((mask >> bit) & 1)) { run = false; break; }
    }
    if (run) return top;
  }
  return -1;
}

// cards: array of 5 card strings or ints.
export function rank5(cards) {
  const ints = cards.map((c) => (typeof c === 'string' ? toInt(c) : c));
  const ranks = ints.map(rankOf);
  const suits = ints.map(suitOf);

  const counts = new Array(13).fill(0);
  let mask = 0;
  for (const r of ranks) {
    counts[r]++;
    mask |= 1 << r;
  }
  const isFlush = suits.every((s) => s === suits[0]);
  const sTop = straightTop(mask);

  if (isFlush && sTop >= 0) return pack(CATEGORY.STRAIGHT_FLUSH, [sTop]);

  // Group ranks by count, then by rank, descending.
  const groups = [];
  for (let r = 12; r >= 0; r--) {
    if (counts[r] > 0) groups.push({ rank: r, count: counts[r] });
  }
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (groups[0].count === 4) {
    return pack(CATEGORY.QUADS, [groups[0].rank, groups[1].rank]);
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return pack(CATEGORY.FULL_HOUSE, [groups[0].rank, groups[1].rank]);
  }
  if (isFlush) {
    return pack(CATEGORY.FLUSH, groups.map((g) => g.rank));
  }
  if (sTop >= 0) return pack(CATEGORY.STRAIGHT, [sTop]);
  if (groups[0].count === 3) {
    return pack(CATEGORY.TRIPS, [groups[0].rank, groups[1].rank, groups[2].rank]);
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    return pack(CATEGORY.TWO_PAIR, [groups[0].rank, groups[1].rank, groups[2].rank]);
  }
  if (groups[0].count === 2) {
    return pack(CATEGORY.PAIR, groups.map((g) => g.rank));
  }
  return pack(CATEGORY.HIGH_CARD, groups.map((g) => g.rank));
}

// Precomputed C(7,5) index combinations.
const COMBOS_7C5 = (() => {
  const out = [];
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 4; b++)
      for (let c = b + 1; c < 5; c++)
        for (let d = c + 1; d < 6; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

// Index combinations of k from n, memoised. Omaha needs "choose 2 of the hole
// cards" and "choose 3 of the board", and the board is not always five cards:
// the live readout asks what you have on the flop and the turn too.
const comboCache = new Map();
function combos(n, k) {
  const key = `${n}:${k}`;
  const hit = comboCache.get(key);
  if (hit) return hit;
  const out = [];
  if (k >= 0 && k <= n) {
    const pick = new Array(k);
    (function walk(start, depth) {
      if (depth === k) {
        out.push(pick.slice());
        return;
      }
      for (let i = start; i <= n - (k - depth); i++) {
        pick[depth] = i;
        walk(i + 1, depth + 1);
      }
    })(0, 0);
  }
  comboCache.set(key, out);
  return out;
}

// Best five-card hand from any 5-7 cards (the live "what do I have" readout
// mid-hand, where the board may only be partial).
export function bestAny(cards) {
  if (cards.length === 5) return { score: rank5(cards), bestFive: [...cards] };
  if (cards.length === 7) return best7(cards);
  let best = -1;
  let bestFive = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = rank5(five);
            if (score > best) {
              best = score;
              bestFive = five;
            }
          }
  return { score: best, bestFive };
}

// Made-hand description for FEWER than five cards (preflop readouts):
// only pairs and better exist that early — straights and flushes can't.
export function describePartial(cards) {
  const counts = new Map();
  for (const c of cards) {
    const r = RANK_CHARS.indexOf(c[0]);
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  let bestRank = -1;
  let bestCount = 0;
  let pairs = 0;
  for (const [rank, count] of counts) {
    if (count >= 2) pairs++;
    if (count > bestCount || (count === bestCount && rank > bestRank)) {
      bestCount = count;
      bestRank = rank;
    }
  }
  if (bestCount >= 4) return `Four of a Kind, ${RANK_PLURALS[bestRank]}`;
  if (bestCount === 3) return `Three of a Kind, ${RANK_PLURALS[bestRank]}`;
  if (bestCount === 2 && pairs >= 2) {
    const pairRanks = [...counts.entries()].filter(([, n]) => n >= 2).map(([r]) => r).sort((a, b) => b - a);
    return `Two Pair, ${RANK_PLURALS[pairRanks[0]]} and ${RANK_PLURALS[pairRanks[1]]}`;
  }
  if (bestCount === 2) return `Pair of ${RANK_PLURALS[bestRank]}`;
  const high = Math.max(...[...counts.keys()]);
  return `${RANK_NAMES[high]} High`;
}

// cards7: array of 7 cards. Returns { score, bestFive }.
export function best7(cards7) {
  // Exactly seven, or the fixed index table below reads past the end and
  // rank5 scores the empty slots as if they were cards — which invents pairs
  // and trips out of nothing rather than failing. Callers with a hand of
  // unknown length want bestAny, which dispatches on the length it is given.
  if (!Array.isArray(cards7) || cards7.length !== 7) {
    throw new Error(`best7 needs exactly 7 cards, got ${cards7?.length}`);
  }
  let best = -1;
  let bestFive = null;
  for (const combo of COMBOS_7C5) {
    const five = combo.map((i) => cards7[i]);
    const score = rank5(five);
    if (score > best) {
      best = score;
      bestFive = five;
    }
  }
  return { score: best, bestFive };
}

// Omaha: exactly 2 hole cards + exactly 3 board cards, always.
//
// The board is NOT always five: the live "what do I have" readout asks on the
// flop and the turn as well, and the combinations have to come from the cards
// that are actually there. Indexing fixed positions 0-4 read past the end of a
// short board and ranked the empty slots as if they were cards, which invented
// pairs and trips out of nothing — a flop readout would claim three of a kind
// when the hand was ace high.
//
// Returns score -1 when a legal Omaha five cannot be formed at all (fewer than
// 2 hole cards or fewer than 3 board cards); every caller either guards for
// that or is only ever handed a complete hand.
export function bestOmaha(hole, board) {
  let best = -1;
  let bestFive = null;
  if (!Array.isArray(hole) || !Array.isArray(board)) return { score: best, bestFive };
  if (hole.length < 2 || board.length < 3) return { score: best, bestFive };
  for (const h of combos(hole.length, 2)) {
    for (const b of combos(board.length, 3)) {
      const five = [hole[h[0]], hole[h[1]], board[b[0]], board[b[1]], board[b[2]]];
      const score = rank5(five);
      if (score > best) {
        best = score;
        bestFive = five;
      }
    }
  }
  return { score: best, bestFive };
}

function tb(score, i) {
  return (score >> (16 - 4 * i)) & 0xf;
}

// Human-readable hand description for logs and showdown nameplates.
export function describe(score) {
  const cat = score >> 20;
  const t1 = tb(score, 0);
  const t2 = tb(score, 1);
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return t1 === 12 ? 'Royal Flush' : `Straight Flush, ${RANK_NAMES[t1]} high`;
    case CATEGORY.QUADS:
      return `Four of a Kind, ${RANK_PLURALS[t1]}`;
    case CATEGORY.FULL_HOUSE:
      return `Full House, ${RANK_PLURALS[t1]} full of ${RANK_PLURALS[t2]}`;
    case CATEGORY.FLUSH:
      return `Flush, ${RANK_NAMES[t1]} high`;
    case CATEGORY.STRAIGHT:
      return `Straight, ${RANK_NAMES[t1]} high`;
    case CATEGORY.TRIPS:
      return `Three of a Kind, ${RANK_PLURALS[t1]}`;
    case CATEGORY.TWO_PAIR:
      return `Two Pair, ${RANK_PLURALS[t1]} and ${RANK_PLURALS[t2]}`;
    case CATEGORY.PAIR:
      return `Pair of ${RANK_PLURALS[t1]}`;
    default:
      return `${RANK_NAMES[t1]} High`;
  }
}
