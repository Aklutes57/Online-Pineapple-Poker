// The privacy boundary. buildViews(game) returns the public view plus a
// forPlayer(playerId) tailored `you` block. Hole cards appear in the public
// view ONLY once revealed (all-in run-out, showdown, or a voluntary show).

import { SEAT_COUNT, PHASES, DEFAULT_NAME_FONT } from '../shared/constants.js';
import { availableActionsFor } from './betting.js';
import { bestAny, bestOmaha, describe, describePartial } from './evaluator.js';
import { evaluate747, describe747, describePartial747, isNaturalSeven, NATURAL_SEVEN_SCORE } from './evaluator747.js';

// The live "what do I have" readout, computed ONLY for the player's own
// cards inside the private view. Best-effort: any surprise shape returns
// null rather than risking the broadcast.
function handNowFor(hand, p) {
  try {
    if (hand.variant.engine === '747') {
      if (p.holeCards.length === 4) return describePartial747(p.holeCards);
      if (p.holeCards.length === 5) {
        const score = isNaturalSeven(p.originalFour || p.holeCards.slice(0, 4))
          ? NATURAL_SEVEN_SCORE
          : evaluate747(p.holeCards);
        return describe747(score);
      }
      return null;
    }
    const board = hand.board || [];
    if (hand.variant.omaha) {
      if (board.length >= 3) return describe(bestOmaha(p.holeCards, board).score);
      return describePartial(p.holeCards);
    }
    const cards = [...p.holeCards, ...board];
    if (cards.length < 5) return describePartial(cards);
    return describe(bestAny(cards).score);
  } catch {
    return null;
  }
}

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
    // Face-up when revealed by the hand itself, or voluntarily shown — a
    // folded player's cards go public ONLY on their own explicit show.
    const showCards = inHand && (p.folded ? p.showedCards : hand.revealed || p.showedCards);
    seats.push({
      playerId: p.id,
      nickname: p.nickname,
      registered: !!p.accountId,
      stack: p.stack,
      connected: p.connected,
      // In the A/V session (webcam + mic shared with the table).
      mediaOn: !!p.mediaOn && p.connected,
      camFrame: p.camFrame || null,
      // Shown in the pod whenever this player's webcam isn't. Public by
      // design — everyone at the table needs to see who they're playing.
      avatarUrl: p.avatarUrl || null,
      nameFont: p.nameFont || DEFAULT_NAME_FONT,
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
      // 747: only THAT a choice is locked is public — never which one.
      decided: inHand && hand.phase === PHASES.DECISION_747 ? p.decision747 !== null : null,
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
          : hand.players.reduce((a, p) => a + p.totalCommitted, 0) + (hand.carryIn || 0),
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
        dealer: hand.variant.engine === '747' ? hand.dealerView() : null,
        naturalSevenSeats: hand.finished ? hand.results?.naturalSevenSeats ?? null : null,
        sixTwo: hand.finished ? hand.results?.sixTwo ?? null : null,
        carryOut: hand.finished ? hand.results?.carryOut ?? 0 : 0,
        uncalledReturn: hand.finished ? hand.results?.uncalledReturn ?? null : null,
        finished: hand.finished,
        // Run it twice is put to the table each time; this is who has answered.
        ritVote: hand.phase === PHASES.RIT_VOTE
          ? hand.livePlayers().map((p) => ({ seat: p.seatIndex, voted: p.ritVote !== null && p.ritVote !== undefined }))
          : null,
        runItTwice: !!hand.runItTwice,
        // Provably-fair proof for this hand: the committed hash and a [0,1)
        // float, visible while the hand is live. The server seed is NOT here —
        // it is revealed only after the table closes.
        fairness: hand.fairness ? { ...hand.fairness } : null,
      }
    : null;

  const pub = {
    seq: ++game.seq,
    gameId: game.id,
    status: game.status,
    pauseRequested: game.pauseRequested,
    settings: { ...game.settings },
    // Tournament clock. Null on a cash game, which is every table by default.
    tournament: game.isTournament()
      ? {
        level: game.level + 1,
        started: !!game.tournamentStartedAt,
        msToNextLevel: game.msToNextLevel(),
        rebuysOpen: game.rebuysOpen(),
        levelMinutes: game.settings.levelMinutes,
      }
      : null,
    hostId: game.hostId,
    hostName: game.players.get(game.hostId)?.nickname ?? null,
    seats,
    seatRequests,
    waitlist,
    hand: handView,
    // Table-level fairness: the session-long commitment (safe to show always)
    // and the current client seed players can steer. Server seed stays secret.
    fairness: {
      algo: game.fairness.algo,
      serverCommit: game.fairness.serverCommit,
      clientSeed: game.fairness.clientSeed,
    },
    carryPot: game.carryPot || 0,
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
      nameFont: p.nameFont || DEFAULT_NAME_FONT,
      spectator: p.status !== 'seated',
      status: p.status,
      seatIndex: p.seatIndex,
      stack: p.stack,
      sittingOut: p.sittingOut,
      pendingBuyIn: p.status === 'requesting' ? p.pendingBuyIn : 0,
      holeCards: inHand ? [...p.holeCards] : null,
      handNow: inHand && !p.folded && !hand.finished ? handNowFor(hand, p) : null,
      hasDiscarded: inHand ? p.hasDiscarded : false,
      canDiscard: inHand && isDiscardPhase && !p.folded && !p.hasDiscarded && p.holeCards.length === 3,
      canDecide747:
        inHand && hand.phase === PHASES.DECISION_747 && !p.folded && p.decision747 === null,
      decided747: inHand && hand.variant.engine === '747' && p.decision747 != null,
      availableActions: myTurn ? availableActionsFor(hand, p) : null,
      canVoteRunItTwice:
        inHand && !p.folded && hand.phase === PHASES.RIT_VOTE
        && (p.ritVote === null || p.ritVote === undefined),
      // Busted: offer a re-buy (or standing up) rather than leaving them stuck.
      canRebuy: p.status === 'seated' && p.stack <= 0,
      // True once the host has let this player in: sitting back down after a
      // bust is instant, so the client must not promise a wait that won't come.
      seatOnRequest: game.seatsItself(p),
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
      // Show is offered whenever the hand is over and these cards are still
      // face down: any folded player, or the winner of an uncalled pot.
      // (Showdown non-folders are already face up; 747 stayers auto-reveal.)
      canShow:
        inHand &&
        !!hand.finished &&
        !p.showedCards &&
        (p.folded || !!hand.results?.byFold),
    };
  }

  return { pub, forPlayer };
}
