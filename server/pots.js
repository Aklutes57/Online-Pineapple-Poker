// Side-pot construction and payout. Pure functions, no game imports.

// players: array of { seatIndex, totalCommitted, folded }
// Returns [{ amount, eligibleSeats: [seatIndex...] }], main pot first.
// Folded players' chips stay in the pots but they are never eligible.
export function buildPots(players) {
  const committed = players.filter((p) => p.totalCommitted > 0);
  if (committed.length === 0) return [];

  const live = committed.filter((p) => !p.folded);
  const maxCommitted = Math.max(...committed.map((p) => p.totalCommitted));

  // Pot layers cut at each live player's total commitment level.
  const levels = [...new Set(live.map((p) => p.totalCommitted))].sort((a, b) => a - b);
  if (levels.length === 0 || levels[levels.length - 1] < maxCommitted) {
    levels.push(maxCommitted);
  }

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of committed) {
      amount += Math.max(0, Math.min(p.totalCommitted, level) - prev);
    }
    const eligibleSeats = live
      .filter((p) => p.totalCommitted >= level)
      .map((p) => p.seatIndex);
    if (amount > 0) pots.push({ amount, eligibleSeats });
    prev = level;
  }

  // Merge adjacent pots with identical eligibility (e.g. trailing dead-money layer).
  const merged = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && sameSeats(last.eligibleSeats, pot.eligibleSeats)) {
      last.amount += pot.amount;
    } else {
      merged.push({ amount: pot.amount, eligibleSeats: [...pot.eligibleSeats] });
    }
  }
  return merged;
}

function sameSeats(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

// pots: from buildPots. scores: Map<seatIndex, score>. buttonSeat: number.
// Returns Map<seatIndex, amountWon>. Odd chips go one at a time to winners
// clockwise starting left of the button.
export function payoutPots(pots, scores, buttonSeat, seatCount = 10) {
  const winnings = new Map();
  let potIndex = 0;
  const potWinners = [];
  for (const pot of pots) {
    const eligible = pot.eligibleSeats.filter((s) => scores.has(s));
    if (eligible.length === 0) {
      throw new Error(`pot ${potIndex} has no eligible scored players`);
    }
    const bestScore = Math.max(...eligible.map((s) => scores.get(s)));
    const winners = eligible.filter((s) => scores.get(s) === bestScore);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;

    for (const seat of winners) {
      winnings.set(seat, (winnings.get(seat) || 0) + share);
    }
    // Odd chips: clockwise from left of the button.
    if (remainder > 0) {
      const ordered = [...winners].sort(
        (a, b) => seatDistance(buttonSeat, a, seatCount) - seatDistance(buttonSeat, b, seatCount)
      );
      for (let i = 0; remainder > 0; i = (i + 1) % ordered.length, remainder--) {
        winnings.set(ordered[i], winnings.get(ordered[i]) + 1);
      }
    }
    potWinners.push({ potIndex, winners, amount: pot.amount });
    potIndex++;
  }

  // Chip conservation check — cheap insurance run on every hand.
  const paid = [...winnings.values()].reduce((a, b) => a + b, 0);
  const total = pots.reduce((a, p) => a + p.amount, 0);
  if (paid !== total) {
    throw new Error(`payout mismatch: paid ${paid}, pots ${total}`);
  }
  return { winnings, potWinners };
}

function seatDistance(fromSeat, toSeat, seatCount) {
  return ((toSeat - fromSeat + seatCount - 1) % seatCount) + 1;
}
