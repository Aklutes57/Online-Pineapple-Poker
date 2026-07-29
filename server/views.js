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
      isStraddle: !!hand && hand.straddleSeat === i,
      // Public on every real site, and it makes the countdown honest.
      timeBank: Math.round((p.timeBank || 0) / 1000),
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

  const waitlist = game.waitlist
    .map((entry, index) => {
      const p = game.players.get(entry.playerId);
      return p
        ? { playerId: p.id, nickname: p.nickname, buyIn: entry.buyIn, approved: entry.approved, position: index + 1 }
        : null;
    })
    .filter(Boolean);

  const handView = hand
    ? {
        handId: hand.handId,
        handNo: hand.handNo,
        variant: hand.variant.key,
        phase: hand.phase,
        board: [...hand.board],
        board2: hand.board2 ? [...hand.board2] : null,
        rabbit: hand.rabbit ? [...hand.rabbit] : null,
        bombPot: !!hand.bombPot,
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
        bounty: hand.finished ? hand.results?.bounty ?? null : null,
        boards: hand.finished ? hand.results?.boards ?? null : null,
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
    waitlist,
    hand: handView,
    lastHandRecordId: game.lastHandRecordId || null,
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
      timeBank: Math.round((p.timeBank || 0) / 1000),
      // Private: broadcasting that a seat has Check/Fold armed would be a
      // genuine tell, worse than anything available at a live table.
      preAction: inHand ? p.preAction?.kind ?? null : null,
      canPreAct:
        inHand && !hand.finished && hand.isBettingPhase() &&
        hand.toActSeat !== p.seatIndex && !p.folded && !p.allIn,
      waitlistPosition:
        game.waitlist.findIndex((e) => e.playerId === p.id) + 1 || null,
      canRabbitHunt:
        inHand && !!hand.finished && !!hand.results?.byFold &&
        hand.rabbitHuntEnabled && !hand.rabbit && hand.board.length < 5,
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
