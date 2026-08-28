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
      // Omaha plays exactly two hole cards and three board cards, so there is
      // nothing to describe until the flop — and bestOmaha reports -1 when a
      // legal five cannot be formed, which is the same "not yet" answer.
      if (board.length >= 3) {
        // Two boards, two hands: half the pot rides on each, so the readout
        // has to say what you have on both rather than pick one.
        if (hand.doubleBoard && hand.board2?.length >= 3) {
          const a = bestOmaha(p.holeCards, board).score;
          const b = bestOmaha(p.holeCards, hand.board2).score;
          if (a >= 0 && b >= 0) return `${describe(a)} / ${describe(b)}`;
        }
        const { score } = bestOmaha(p.holeCards, board);
        if (score >= 0) return describe(score);
      }
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
      // Whether the camera itself is live. A player in voice-only, or one who
      // switched their camera off, still holds a (disabled) video track, so
      // receivers need telling or they show a black tile instead of the picture.
      camOn: !!p.mediaOn && !!p.camOn && p.connected,
      // Changes whenever this player's outgoing tracks change. Peers key their
      // connection on it, so both ends rebuild together when it moves.
      mediaEpoch: p.mediaEpoch || 0,
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
      // Stud deals part of every hand face up, and those cards are public by
      // the rules — reading the other boards IS the game. The invariant this
      // file exists to hold is unchanged for everything else: holeCards is the
      // complete hand and still only ever reaches its owner, or the whole
      // table at a showdown through `cards` above. A folded player's cards are
      // dead, so they go back face down with the rest of their hand.
      upCards: inHand && !p.folded ? [...(p.upCards || [])] : [],
      isDealer: !!hand && hand.buttonSeat === i,
      isSB: !!hand && hand.sbSeat === i,
      isBB: !!hand && hand.bbSeat === i,
      // Every straddler is flagged, not just the last: a double or triple
      // straddle is a chain, and the table should see who is in it.
      isStraddle: !!hand && !!hand.straddleSeats?.includes(i),
      straddleLevel: hand?.straddleSeats?.indexOf(i) >= 0 ? hand.straddleSeats.indexOf(i) + 1 : 0,
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
        // Only as much of the second board as the table has been shown: run it
        // twice deals one board at a time, so this stays empty (null) until the
        // first board has finished running out. A finished hand shows it whole.
        board2: hand.board2 && (hand.finished || hand.board2Shown > 0)
          ? hand.board2.slice(0, hand.finished ? hand.board2.length : hand.board2Shown)
          : null,
        rabbit: hand.rabbit ? [...hand.rabbit] : null,
        bombPot: !!hand.bombPot,
        doubleBoard: !!hand.doubleBoard,
        // What everyone put in to be dealt this bomb pot — the badge says so,
        // because the table's blinds are not what this hand cost.
        ante: hand.bombPot ? hand.ante : 0,
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
        // The riding pot this hand was dealt with (public — it's in the pot
        // readout already). The ledger's books-balance line needs it while
        // the hand is live, because game.carryPot is zero at that moment.
        carryIn: hand.carryIn || 0,
        uncalledReturn: hand.finished ? hand.results?.uncalledReturn ?? null : null,
        finished: hand.finished,
        // Run it twice is put to the table each time; this is who has answered.
        // `yes` is public as it comes in so the table can see the agreement
        // being built — it decides nothing on its own (unanimity does) and a
        // vote is not a card, so there is nothing to hide.
        ritVote: hand.phase === PHASES.RIT_VOTE
          ? hand.livePlayers().map((p) => ({
            seat: p.seatIndex,
            voted: p.ritVote !== null && p.ritVote !== undefined,
            yes: p.ritVote === true,
          }))
          : null,
        runItTwice: !!hand.runItTwice,
        // Live equity for the board being dealt, while the hand runs out with
        // every remaining hand already face up. Null at every other moment —
        // see Hand.refreshEquity(), which is what keeps this from being a leak.
        equity: hand.equityNow ?? null,
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
    // What the table is playing, and when it started, so each browser can
    // seek its own player to the same place. Nothing here is audio.
    music: {
      queue: game.music.queue.map((t) => ({ ...t })),
      index: game.music.index,
      // How long the current track has been running, not when it started.
      // An absolute timestamp would be read against the client's own clock,
      // and a browser a few minutes out would seek to the wrong place.
      startedAgo: game.music.startedAt ? Date.now() - game.music.startedAt : null,
      paused: game.music.paused,
      pausedAt: game.music.pausedAt,
    },
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
      // Your own ledger name, so the settings form can show what is set. The
      // table sees it only through the ledger, never on the felt.
      realName: p.realName || null,
      nameFont: p.nameFont || DEFAULT_NAME_FONT,
      spectator: p.status !== 'seated',
      // Straddling is opt-IN, twice over: the first straddle and re-straddling
      // behind someone else are separate choices, and you are out of both
      // until you ask to be in.
      straddleOptIn: p.straddleOptIn === true,
      straddleDeepOptIn: p.straddleDeepOptIn === true,
      status: p.status,
      seatIndex: p.seatIndex,
      stack: p.stack,
      sittingOut: p.sittingOut,
      pendingBuyIn: p.status === 'requesting' ? p.pendingBuyIn : 0,
      holeCards: inHand ? [...p.holeCards] : null,
      handNow: inHand && !p.folded && !hand.finished ? handNowFor(hand, p) : null,
      hasDiscarded: inHand ? p.hasDiscarded : false,
      canDiscard: inHand && isDiscardPhase && !p.folded && !p.hasDiscarded && p.holeCards.length === 3,
      // The draw. An all-in player still draws — they have no chips left, but
      // their cards still have to win the pot.
      canDraw: inHand && hand.phase === PHASES.DRAW && !p.folded && !p.hasDrawn,
      hasDrawn: inHand ? !!p.hasDrawn : false,
      canDecide747:
        inHand && hand.phase === PHASES.DECISION_747 && !p.folded && p.decision747 === null,
      decided747: inHand && hand.variant.engine === '747' && p.decision747 != null,
      availableActions: myTurn ? availableActionsFor(hand, p) : null,
      canVoteRunItTwice:
        inHand && !p.folded && hand.phase === PHASES.RIT_VOTE
        && (p.ritVote === null || p.ritVote === undefined),
      // Busted: offer a re-buy (or standing up) rather than leaving them
      // stuck — but never while their hand is still being played out. An
      // all-in player has a stack of zero the moment the chips go in, and
      // being offered a buy-in mid-run-out reads as "you already lost".
      canRebuy: p.status === 'seated' && p.stack <= 0 && !(inHand && !hand.finished),
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
      // Dead money into the pot: any live hand you have not folded out of, as
      // long as the action is not on you — on your turn the betting controls
      // are the right tool. 747 is excluded: it has no betting rounds, and a
      // pot that rides between hands.
      canPost:
        inHand && !hand.finished && hand.variant.engine !== '747' &&
        hand.toActSeat !== p.seatIndex && !p.folded && p.stack > 0,
      // Tipping only needs chips and a seat; whether it lands now or after the
      // hand is the server's business, not the button's.
      canTip: p.status === 'seated' && p.stack > 0,
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
