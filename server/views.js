// The privacy boundary. buildViews(game) returns the public view plus a
// forPlayer(playerId) tailored `you` block. Hole cards appear in the public
// view ONLY once revealed (all-in run-out, showdown, or a voluntary show).

import { SEAT_COUNT, PHASES } from '../shared/constants.js';
import { availableActionsFor } from './betting.js';

export function buildViews(game) {
  const hand = game.currentHand;

  const seats = [];
  for (let i = 0; i < SEAT_COUNT; i++) {
    const id = game.seats[i];
    if (!id) {
      seats.push(null);
      continue;
    }
    const p = game.players.get(id);
    const inHand = !!hand && hand.bySeat.get(i) === p;
    const showCards = inHand && !p.folded && (hand.revealed || p.showedCards);
    seats.push({
      playerId: p.id,
      nickname: p.nickname,
      registered: !!p.accountId,
      stack: p.stack,
      connected: p.connected,
      sittingOut: p.sittingOut,
      inHand,
      folded: inHand ? p.folded : false,
      allIn: inHand ? p.allIn : false,
      betThisRound: inHand ? p.betThisRound : 0,
      cardCount: inHand && !p.folded ? p.holeCards.length : 0,
      cards: showCards ? [...p.holeCards] : null,
      isDealer: !!hand && hand.buttonSeat === i,
      isSB: !!hand && hand.sbSeat === i,
      isBB: !!hand && hand.bbSeat === i,
      handResult: inHand && hand.finished ? p.handResult : null,
    });
  }

  const seatRequests = [...game.players.values()]
    .filter((p) => p.status === 'requesting')
    .map((p) => ({
      playerId: p.id,
      nickname: p.nickname,
      buyIn: p.pendingBuyIn,
      seatIndex: p.requestedSeat,
    }));

  const handView = hand
    ? {
        handId: hand.handId,
        handNo: hand.handNo,
        phase: hand.phase,
        board: [...hand.board],
        collectedPot: hand.collectedPot(),
        potTotal: hand.finished
          ? (hand.results?.pots.reduce((a, p) => a + p.amount, 0) ?? 0)
          : hand.players.reduce((a, p) => a + p.totalCommitted, 0),
        pots: hand.finished ? hand.results?.pots ?? null : null,
        toActSeat: hand.toActSeat,
        currentBet: hand.currentBet,
        deadline: game.timer ? game.timer.deadline : null,
        timerName: game.timer ? game.timer.name : null,
        lastAction: hand.lastAction,
        winners: hand.finished ? hand.results?.winners ?? null : null,
        cooler: hand.finished ? hand.results?.cooler ?? null : null,
        uncalledReturn: hand.finished ? hand.results?.uncalledReturn ?? null : null,
        finished: hand.finished,
      }
    : null;

  const pub = {
    seq: ++game.seq,
    gameId: game.id,
    status: game.status,
    pauseRequested: game.pauseRequested,
    settings: { ...game.settings },
    hostId: game.hostId,
    seats,
    seatRequests,
    hand: handView,
    chatTail: game.chat.slice(-30),
    logTail: game.logs.slice(-80),
    ledger: game.ledgerRows(),
  };

  function forPlayer(playerId) {
    const p = game.players.get(playerId);
    if (!p) return { playerId, spectator: true };
    const inHand = !!hand && p.seatIndex !== null && hand.bySeat.get(p.seatIndex) === p;
    const isDiscardPhase =
      !!hand && (hand.phase === PHASES.DISCARD_PREFLOP || hand.phase === PHASES.DISCARD_POSTFLOP);
    const myTurn = inHand && !hand.finished && hand.toActSeat === p.seatIndex && hand.isBettingPhase();
    return {
      playerId: p.id,
      nickname: p.nickname,
      accountId: p.accountId ?? null,
      isHost: game.hostId === p.id,
      spectator: p.status !== 'seated',
      status: p.status,
      seatIndex: p.seatIndex,
      stack: p.stack,
      sittingOut: p.sittingOut,
      pendingBuyIn: p.status === 'requesting' ? p.pendingBuyIn : 0,
      holeCards: inHand ? [...p.holeCards] : null,
      hasDiscarded: inHand ? p.hasDiscarded : false,
      canDiscard: inHand && isDiscardPhase && !p.folded && !p.hasDiscarded && p.holeCards.length === 3,
      availableActions: myTurn ? availableActionsFor(hand, p) : null,
      canShow:
        inHand &&
        !!hand.finished &&
        !!hand.results?.byFold &&
        !p.folded &&
        !p.showedCards,
    };
  }

  return { pub, forPlayer };
}
