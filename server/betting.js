// Betting-round logic. Operates on a Hand's street state and its Player objects.
// All amounts are integer chips. Raise amounts are "raise TO" totals for the
// current street, never increments.
//
// Key rules encoded here:
// - Min bet = big blind. Min raise-to = currentBet + lastFullRaiseSize.
// - A full raise reopens action (clears everyone else's hasActed).
// - An all-in for less than a full raise does NOT reopen action and does NOT
//   update lastFullRaiseSize: players who already acted may only call or fold.
// - Pot-limit (PLO): max raise-to = currentBet + (pot after the call).

export function pay(player, amount) {
  const actual = Math.min(amount, player.stack);
  player.stack -= actual;
  player.betThisRound += actual;
  player.totalCommitted += actual;
  if (player.stack === 0) player.allIn = true;
  return actual;
}

// Chips put into the pot that are NOT a bet. They buy no action: they call
// nothing, they do not raise the current bet, and they leave whose turn it is
// exactly as it was. They still go through totalCommitted, because that is the
// only thing the pot is ever built from — moving chips any other way would
// break chip conservation and strand them outside the payout.
export function payDead(player, amount) {
  const actual = Math.max(0, Math.min(amount, player.stack));
  player.stack -= actual;
  player.totalCommitted += actual;
  if (player.stack === 0) player.allIn = true;
  return actual;
}

export function resetStreet(hand) {
  for (const p of hand.players) {
    p.betThisRound = 0;
    p.hasActed = false;
  }
  hand.currentBet = 0;
  hand.lastFullRaiseSize = hand.bigBlind;
}

function seatAfter(hand, seat) {
  const order = hand.seatOrder;
  const i = order.indexOf(seat);
  return order[(i + 1) % order.length];
}

// Next seat (strictly after fromSeat) that still owes a decision this street.
export function nextActorSeat(hand, fromSeat) {
  let seat = fromSeat;
  for (let i = 0; i < hand.seatOrder.length; i++) {
    seat = seatAfter(hand, seat);
    const p = hand.bySeat.get(seat);
    if (!p || p.folded || p.allIn) continue;
    if (!p.hasActed || p.betThisRound < hand.currentBet) return seat;
  }
  return null;
}

// The first player to act starting AT `seat` rather than after it. Stud needs
// this: from fourth street on, the best hand showing speaks first, and that
// player is the one who acts — not the one to their left.
export function actorFromSeat(hand, seat) {
  const p = hand.bySeat.get(seat);
  if (p && !p.folded && !p.allIn && (!p.hasActed || p.betThisRound < hand.currentBet)) {
    return seat;
  }
  return nextActorSeat(hand, seat);
}

export function firstToActSeat(hand, isPreflop) {
  // Preflop action starts left of the last forced bet — the straddle when
  // there is one, otherwise the big blind. A bomb pot has neither, so it
  // falls through to button-relative order like any postflop street.
  const from = isPreflop
    ? (hand.straddleSeat ?? hand.bbSeat ?? hand.buttonSeat)
    : hand.buttonSeat;
  return nextActorSeat(hand, from);
}

export function isRoundComplete(hand) {
  for (const p of hand.players) {
    if (p.folded || p.allIn) continue;
    if (!p.hasActed || p.betThisRound < hand.currentBet) return false;
  }
  return true;
}

export function potTotal(hand) {
  return hand.players.reduce((a, p) => a + p.totalCommitted, 0);
}

export function availableActionsFor(hand, player) {
  const toCall = Math.max(0, hand.currentBet - player.betThisRound);
  const callAmount = Math.min(toCall, player.stack);
  const canCheck = toCall === 0;

  // A player may raise if they haven't had a full-options turn since the last
  // full raise (hasActed=false), and they have chips beyond the call.
  let canRaise = !player.hasActed && player.stack > callAmount;
  // Nothing to raise against yourself: if everyone else is folded or all-in
  // with no chips behind, raising is pointless but still legal; keep it legal.

  let minRaiseTo = hand.currentBet + hand.lastFullRaiseSize;
  let maxRaiseTo;
  if (hand.potLimit) {
    maxRaiseTo = hand.currentBet + potTotal(hand) + toCall;
  } else {
    maxRaiseTo = Infinity;
  }
  // Cap at the player's all-in total.
  const allInTo = player.betThisRound + player.stack;
  maxRaiseTo = Math.min(maxRaiseTo, allInTo);
  // Short all-in "raise" below the min is allowed if it's the player's whole stack.
  if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo;
  // Must actually exceed the current bet to be a raise at all.
  if (maxRaiseTo <= hand.currentBet) canRaise = false;

  return {
    canFold: true,
    canCheck,
    callAmount,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
  };
}

// Validates and applies. Returns { ok: true } or { ok: false, error }.
export function applyAction(hand, player, action, amount) {
  const av = availableActionsFor(hand, player);

  if (action === 'fold') {
    player.folded = true;
    player.hasActed = true;
    return { ok: true };
  }

  if (action === 'check') {
    if (!av.canCheck) return { ok: false, error: 'cannot check facing a bet' };
    player.hasActed = true;
    return { ok: true };
  }

  if (action === 'call') {
    if (av.canCheck) {
      player.hasActed = true; // calling nothing is a check
      return { ok: true };
    }
    pay(player, av.callAmount);
    player.hasActed = true;
    return { ok: true };
  }

  if (action === 'bet' || action === 'raise') {
    if (!av.canRaise) return { ok: false, error: 'raising not allowed' };
    if (!Number.isInteger(amount)) return { ok: false, error: 'bad amount' };
    if (amount < av.minRaiseTo || amount > av.maxRaiseTo) {
      return { ok: false, error: `raise must be between ${av.minRaiseTo} and ${av.maxRaiseTo}` };
    }
    const raiseSize = amount - hand.currentBet;
    const isFullRaise = raiseSize >= hand.lastFullRaiseSize;
    pay(player, amount - player.betThisRound);
    hand.currentBet = amount;
    if (isFullRaise) {
      hand.lastFullRaiseSize = raiseSize;
      for (const p of hand.players) {
        if (p !== player && !p.folded && !p.allIn) p.hasActed = false;
      }
    }
    player.hasActed = true;
    return { ok: true };
  }

  return { ok: false, error: 'unknown action' };
}
