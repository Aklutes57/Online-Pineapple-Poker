// Decides when a finished hand deserves a callout: a bad beat, a cooler, or
// a monster shown down. Pure function of the showdown snapshot, so it is
// unit-testable without a game.
//
// The distinction that matters:
//  - a BAD BEAT is about the odds — someone was a heavy favourite when the
//    chips went in and still lost;
//  - a COOLER is about the cards — two big hands collided and the second-best
//    one was never getting away.

import { CATEGORY } from './evaluator.js';

export const THRESHOLDS = {
  // Equity the loser needed when the money went in for it to be a bad beat.
  badBeatEquity: 0.8,
  // How big the pot must be, in big blinds, before we make noise.
  minPotBB: 20,
  // The weakest losing hand that still counts as a cooler. Two pair is the
  // right floor: two pair running into a set is the everyday cooler, while
  // one pair losing is just poker.
  coolerLoserCategory: CATEGORY.TWO_PAIR,
  // Hands worth announcing regardless of who won.
  monsterCategory: CATEGORY.QUADS,
};

const CATEGORY_LABEL = {
  [CATEGORY.QUADS]: 'quads',
  [CATEGORY.STRAIGHT_FLUSH]: 'a straight flush',
};

// snapshot: {
//   players: [{ seat, nickname, score, desc, won, folded }],
//   potTotal, bigBlind, allInEquity: Map<seat, 0..1> | null
// }
// Returns null, or { trigger, headline, detail, seats }.
export function detectCooler(snapshot) {
  const { players = [], potTotal = 0, bigBlind = 1, allInEquity = null } = snapshot;
  const shown = players.filter((p) => !p.folded && typeof p.score === 'number');
  if (shown.length < 2) return null;

  const potInBB = bigBlind > 0 ? potTotal / bigBlind : 0;
  const sorted = [...shown].sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  const runnerUp = sorted[1];
  if (winner.score === runnerUp.score) return null; // a chop is nobody's disaster

  const winnerCategory = winner.score >> 20;
  const loserCategory = runnerUp.score >> 20;

  // 1. Bad beat — decided by the odds when the chips went in.
  if (allInEquity && potInBB >= THRESHOLDS.minPotBB) {
    const victim = shown
      .filter((p) => p.seat !== winner.seat)
      .map((p) => ({ player: p, eq: allInEquity.get(p.seat) ?? 0 }))
      .sort((a, b) => b.eq - a.eq)[0];
    if (victim && victim.eq >= THRESHOLDS.badBeatEquity) {
      return {
        trigger: 'badBeat',
        seats: [victim.player.seat, winner.seat],
        headline: 'Bad beat',
        detail:
          `${victim.player.nickname} was ${Math.round(victim.eq * 100)}% to win with ` +
          `${victim.player.desc} — ${winner.nickname} got there with ${winner.desc}`,
      };
    }
  }

  // 2. Monster — quads or better is worth a noise whatever the pot.
  if (winnerCategory >= THRESHOLDS.monsterCategory) {
    return {
      trigger: 'quads',
      seats: [winner.seat],
      headline: winnerCategory === CATEGORY.STRAIGHT_FLUSH ? 'Straight flush!' : 'Quads!',
      detail: `${winner.nickname} shows ${winner.desc}`,
    };
  }

  // 3. Cooler — a big second-best hand losing a big pot.
  if (loserCategory >= THRESHOLDS.coolerLoserCategory && potInBB >= THRESHOLDS.minPotBB) {
    return {
      trigger: 'cooler',
      seats: [runnerUp.seat, winner.seat],
      headline: 'Cooler',
      detail: `${runnerUp.nickname}'s ${runnerUp.desc} ran into ${winner.nickname}'s ${winner.desc}`,
    };
  }

  return null;
}

export { CATEGORY_LABEL };
