// All-in equity: given everyone's hole cards and the board so far, what share
// of the pot does each player expect to win?
//
// Exact enumeration whenever the number of run-outs is small (which covers
// every flop and turn all-in), Monte Carlo sampling when it isn't (preflop,
// where C(48,5) is over 1.7 million). Pure and dependency-free.

import { freshDeck } from './deck.js';
import { best7, bestOmaha } from './evaluator.js';

// Above this many run-outs, sample instead of enumerating.
const EXACT_LIMIT = 40000;
const SAMPLES = 1500;

function combinations(items, k) {
  const out = [];
  const combo = new Array(k);
  (function pick(start, depth) {
    if (depth === k) {
      out.push(combo.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - depth); i++) {
      combo[depth] = items[i];
      pick(i + 1, depth + 1);
    }
  })(0, 0);
  return out;
}

function countCombinations(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

function scoreFor(holeCards, board, omaha) {
  return omaha ? bestOmaha(holeCards, board).score : best7([...holeCards, ...board]).score;
}

// hands: [{ seat, holeCards }]. Returns Map<seat, equity 0..1>.
// Equity splits ties evenly, which is what "share of the pot" means.
// `dead` is cards that are out of the deck but not part of THIS board — the
// other board when a hand is run twice. Without it board one's five cards are
// counted as live outs for board two, and a player drawing dead is shown with
// real equity.
export function equity(hands, board, { omaha = false, rng = Math.random, dead = [] } = {}) {
  const result = new Map();
  if (hands.length === 0) return result;
  if (hands.length === 1) {
    result.set(hands[0].seat, 1);
    return result;
  }

  const known = new Set([...board, ...dead, ...hands.flatMap((h) => h.holeCards)]);
  const remaining = freshDeck().filter((c) => !known.has(c));
  const toCome = 5 - board.length;

  const shares = new Map(hands.map((h) => [h.seat, 0]));

  if (toCome === 0) {
    tally(hands, board, omaha, shares);
    return normalize(shares, 1);
  }

  const total = countCombinations(remaining.length, toCome);
  if (total <= EXACT_LIMIT) {
    const runouts = combinations(remaining, toCome);
    for (const extra of runouts) {
      tally(hands, board.concat(extra), omaha, shares);
    }
    return normalize(shares, runouts.length);
  }

  // Monte Carlo: partial Fisher-Yates over a scratch copy per sample.
  const pool = remaining.slice();
  for (let s = 0; s < SAMPLES; s++) {
    for (let i = 0; i < toCome; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    tally(hands, board.concat(pool.slice(0, toCome)), omaha, shares);
  }
  return normalize(shares, SAMPLES);
}

function tally(hands, board, omaha, shares) {
  let best = -1;
  let winners = [];
  for (const hand of hands) {
    const score = scoreFor(hand.holeCards, board, omaha);
    if (score > best) {
      best = score;
      winners = [hand.seat];
    } else if (score === best) {
      winners.push(hand.seat);
    }
  }
  const share = 1 / winners.length;
  for (const seat of winners) shares.set(seat, shares.get(seat) + share);
}

function normalize(shares, runs) {
  const out = new Map();
  for (const [seat, won] of shares) out.set(seat, runs > 0 ? won / runs : 0);
  return out;
}
