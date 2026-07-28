// One hand of poker, from blinds to payout. Pure engine: no sockets, no
// global timers — everything external goes through ctx callbacks:
//   ctx.log(text)                — append a log line
//   ctx.changed()                — state changed, broadcast
//   ctx.finished()               — hand over (schedule next hand)
//   ctx.setTimer(name, ms, fn)   — schedule the game's single pending timer
//   ctx.clearTimer()             — cancel it
//   ctx.markAway(player)         — player timed out and is now sitting out

import { VARIANTS, PHASES, TIMINGS } from '../shared/constants.js';
import * as betting from './betting.js';
import { buildPots, payoutPots } from './pots.js';
import { best7, bestOmaha, describe } from './evaluator.js';
import { shuffledDeck } from './deck.js';

const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
const BOARD_CARDS = { flop: 3, turn: 1, river: 1 };

export class Hand {
  constructor({ handNo, variantKey, smallBlind, bigBlind, actionTime, buttonSeat, players, deck, ctx }) {
    this.handNo = handNo;
    this.handId = `h${handNo}`;
    this.variant = VARIANTS[variantKey];
    if (!this.variant) throw new Error(`unknown variant ${variantKey}`);
    this.potLimit = !!this.variant.potLimit;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.actionTime = actionTime;
    this.buttonSeat = buttonSeat;
    this.players = players;
    this.bySeat = new Map(players.map((p) => [p.seatIndex, p]));
    this.seatOrder = players.map((p) => p.seatIndex).sort((a, b) => a - b);
    this.deck = deck || shuffledDeck();
    this.deckIndex = 0;
    this.board = [];
    this.phase = null;
    this.street = null;
    this.currentBet = 0;
    this.lastFullRaiseSize = bigBlind;
    this.toActSeat = null;
    this.runOut = false;
    this.revealed = false;
    this.discardsDone = !this.variant.discardAfter;
    this.finished = false;
    this.lastAction = null;
    this.results = null; // { pots, winners: [{seat, amount}], uncalledReturn }
    this.sbSeat = null;
    this.bbSeat = null;
    this.ctx = ctx;

    if (players.length < 2) throw new Error('need at least 2 players');
  }

  // ---- lifecycle ----

  start() {
    for (const p of this.players) {
      p.holeCards = [];
      p.folded = false;
      p.allIn = false;
      p.betThisRound = 0;
      p.totalCommitted = 0;
      p.hasActed = false;
      p.hasDiscarded = false;
      p.showedCards = false;
      p.handResult = null;
    }

    // Heads-up: the button posts the small blind.
    if (this.players.length === 2) {
      this.sbSeat = this.buttonSeat;
      this.bbSeat = this.seatAfter(this.buttonSeat);
    } else {
      this.sbSeat = this.seatAfter(this.buttonSeat);
      this.bbSeat = this.seatAfter(this.sbSeat);
    }
    const sb = this.bySeat.get(this.sbSeat);
    const bb = this.bySeat.get(this.bbSeat);
    betting.pay(sb, this.smallBlind);
    betting.pay(bb, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.lastFullRaiseSize = this.bigBlind;
    this.ctx.log(
      `Hand #${this.handNo} (${this.variant.label}) — ${sb.nickname} posts small blind ${this.smallBlind}, ` +
      `${bb.nickname} posts big blind ${this.bigBlind}`
    );

    // Deal hole cards, starting left of the button.
    let seat = this.seatAfter(this.buttonSeat);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.bySeat.get(seat);
      p.holeCards = this.draw(this.variant.holeCards);
      seat = this.seatAfter(seat);
    }

    this.enterStreet('preflop', true);
  }

  seatAfter(seat) {
    const i = this.seatOrder.indexOf(seat);
    return this.seatOrder[(i + 1) % this.seatOrder.length];
  }

  draw(n) {
    const cards = this.deck.slice(this.deckIndex, this.deckIndex + n);
    this.deckIndex += n;
    if (cards.length < n) throw new Error('deck exhausted');
    return cards;
  }

  livePlayers() {
    return this.players.filter((p) => !p.folded);
  }

  // ---- streets ----

  enterStreet(street, isFirst = false) {
    this.street = street;
    this.phase = PHASES[street.toUpperCase()];
    if (!isFirst) betting.resetStreet(this);

    const dealt = BOARD_CARDS[street];
    if (dealt) {
      this.board.push(...this.draw(dealt));
      this.ctx.log(`${cap(street)}: ${this.board.join(' ')}`);
    }

    if (this.runOut) {
      this.afterStreetComplete();
      return;
    }

    this.toActSeat = betting.firstToActSeat(this, street === 'preflop');
    if (this.toActSeat === null) {
      this.afterStreetComplete();
    } else {
      this.beginTurn();
      this.ctx.changed();
    }
  }

  beginTurn() {
    const player = this.bySeat.get(this.toActSeat);
    let ms = null;
    if (player.sittingOut) ms = TIMINGS.AWAY_GRACE;
    else if (this.actionTime > 0) ms = this.actionTime * 1000;
    if (ms !== null) {
      this.ctx.setTimer('action', ms, () => this.handleTimeout());
    } else {
      this.ctx.clearTimer();
    }
  }

  handleTimeout() {
    const player = this.bySeat.get(this.toActSeat);
    if (!player || this.finished) return;
    const av = betting.availableActionsFor(this, player);
    const action = av.canCheck ? 'check' : 'fold';
    if (!player.sittingOut) {
      this.ctx.markAway(player);
      this.ctx.log(`${player.nickname} didn't act in time and is now away`);
    }
    betting.applyAction(this, player, action, null);
    this.lastAction = { seat: player.seatIndex, action, amount: null };
    this.ctx.log(`${player.nickname} ${action === 'check' ? 'checks' : 'folds'} (time)`);
    this.afterAction();
  }

  // Entry point from sockets. Returns { ok, error? }.
  handleAction(player, action, amount) {
    if (this.finished) return { ok: false, error: 'hand is over' };
    if (!this.isBettingPhase()) return { ok: false, error: 'no betting right now' };
    if (player.seatIndex !== this.toActSeat) return { ok: false, error: 'not your turn' };

    const before = this.currentBet;
    const result = betting.applyAction(this, player, action, amount);
    if (!result.ok) return result;

    this.ctx.clearTimer();
    const shown =
      action === 'fold' ? 'folds'
      : action === 'check' ? 'checks'
      : action === 'call' ? `calls ${player.betThisRound}`
      : before === 0 ? `bets ${player.betThisRound}`
      : `raises to ${player.betThisRound}`;
    this.lastAction = { seat: player.seatIndex, action, amount: player.betThisRound };
    this.ctx.log(`${player.nickname} ${shown}${player.allIn ? ' (all-in)' : ''}`);
    this.afterAction();
    return { ok: true };
  }

  afterAction() {
    const live = this.livePlayers();
    if (live.length === 1) {
      this.finishByFold(live[0]);
      return;
    }
    if (betting.isRoundComplete(this)) {
      this.toActSeat = null;
      this.afterStreetComplete();
      return;
    }
    this.toActSeat = betting.nextActorSeat(this, this.toActSeat);
    if (this.toActSeat === null) {
      // Nobody left who can act (everyone remaining is all-in).
      this.afterStreetComplete();
      return;
    }
    this.beginTurn();
    this.ctx.changed();
  }

  isBettingPhase() {
    return [PHASES.PREFLOP, PHASES.FLOP, PHASES.TURN, PHASES.RIVER].includes(this.phase);
  }

  afterStreetComplete() {
    if (this.variant.discardAfter === this.street && !this.discardsDone) {
      this.enterDiscard();
      return;
    }
    this.proceedFromStreet();
  }

  proceedFromStreet() {
    // All-in run-out check: at least 2 live, at most 1 of them not all-in.
    const live = this.livePlayers();
    const actors = live.filter((p) => !p.allIn);
    if (!this.runOut && live.length >= 2 && actors.length <= 1) {
      this.runOut = true;
    }
    if (this.runOut && !this.revealed && this.discardsDone) {
      this.revealed = true;
      for (const p of live) {
        this.ctx.log(`${p.nickname} shows ${p.holeCards.join(' ')}`);
      }
    }

    const next = NEXT_STREET[this.street];
    if (next === 'showdown') {
      if (this.runOut) {
        this.ctx.changed();
        this.ctx.setTimer('runout', TIMINGS.RUNOUT_STREET_DELAY, () => this.showdown());
      } else {
        this.showdown();
      }
      return;
    }
    if (this.runOut) {
      this.ctx.changed();
      this.ctx.setTimer('runout', TIMINGS.RUNOUT_STREET_DELAY, () => this.enterStreet(next));
    } else {
      this.enterStreet(next);
    }
  }

  // ---- discard phase (Pineapple / Crazy Pineapple) ----

  enterDiscard() {
    const pending = this.discardPending();
    if (pending.length === 0) {
      this.discardsDone = true;
      this.proceedFromStreet();
      return;
    }
    this.phase = this.variant.discardAfter === 'preflop'
      ? PHASES.DISCARD_PREFLOP
      : PHASES.DISCARD_POSTFLOP;
    this.toActSeat = null;
    this.ctx.log('Discard: each player throws away one card');
    this.ctx.setTimer('discard', TIMINGS.DISCARD_TIME, () => this.discardTimeout());
    this.ctx.changed();
  }

  discardPending() {
    return this.livePlayers().filter((p) => p.holeCards.length === 3 && !p.hasDiscarded);
  }

  handleDiscard(player, cardIndex) {
    if (this.phase !== PHASES.DISCARD_PREFLOP && this.phase !== PHASES.DISCARD_POSTFLOP) {
      return { ok: false, error: 'not the discard phase' };
    }
    if (player.folded || player.hasDiscarded || player.holeCards.length !== 3) {
      return { ok: false, error: 'nothing to discard' };
    }
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= player.holeCards.length) {
      return { ok: false, error: 'bad card index' };
    }
    player.holeCards.splice(cardIndex, 1);
    player.hasDiscarded = true;
    this.ctx.log(`${player.nickname} discards a card`);
    if (this.discardPending().length === 0) {
      this.ctx.clearTimer();
      this.finishDiscard();
    } else {
      this.ctx.changed();
    }
    return { ok: true };
  }

  discardTimeout() {
    for (const p of this.discardPending()) {
      p.holeCards.pop();
      p.hasDiscarded = true;
      this.ctx.log(`${p.nickname} auto-discards (time)`);
    }
    this.finishDiscard();
  }

  finishDiscard() {
    this.discardsDone = true;
    this.proceedFromStreet();
  }

  // ---- endings ----

  returnUncalledBet() {
    const totals = this.players
      .map((p) => p.totalCommitted)
      .sort((a, b) => b - a);
    const excess = totals[0] - (totals[1] ?? 0);
    if (excess > 0) {
      const top = this.players.find((p) => p.totalCommitted === totals[0]);
      top.totalCommitted -= excess;
      top.stack += excess;
      return { seat: top.seatIndex, amount: excess };
    }
    return null;
  }

  finishByFold(winner) {
    this.ctx.clearTimer();
    const uncalledReturn = this.returnUncalledBet();
    const pot = betting.potTotal(this);
    winner.stack += pot;
    this.clearCommitments();
    this.phase = PHASES.COMPLETE;
    this.toActSeat = null;
    this.finished = true;
    this.results = {
      pots: [{ amount: pot, eligibleSeats: [winner.seatIndex] }],
      winners: [{ seat: winner.seatIndex, amount: pot }],
      uncalledReturn,
      byFold: true,
    };
    winner.handResult = { desc: null, won: pot };
    this.ctx.log(`${winner.nickname} wins ${pot}`);
    this.ctx.changed();
    this.ctx.finished();
  }

  showdown() {
    this.ctx.clearTimer();
    const uncalledReturn = this.returnUncalledBet();
    const live = this.livePlayers();

    const scores = new Map();
    for (const p of live) {
      const { score } = this.variant.omaha
        ? bestOmaha(p.holeCards, this.board)
        : best7([...p.holeCards, ...this.board]);
      scores.set(p.seatIndex, score);
    }

    const pots = buildPots(this.players);
    const { winnings } = payoutPots(pots, scores, this.buttonSeat);

    const winners = [];
    for (const [seat, amount] of winnings) {
      const p = this.bySeat.get(seat);
      p.stack += amount;
      winners.push({ seat, amount });
    }
    for (const p of live) {
      p.handResult = {
        desc: describe(scores.get(p.seatIndex)),
        won: winnings.get(p.seatIndex) || 0,
      };
    }
    this.clearCommitments();
    this.revealed = true;
    this.phase = PHASES.SHOWDOWN;
    this.toActSeat = null;
    this.finished = true;
    this.results = { pots, winners, uncalledReturn, byFold: false };

    for (const p of live) {
      this.ctx.log(
        `${p.nickname} shows ${p.holeCards.join(' ')} — ${p.handResult.desc}` +
        (p.handResult.won ? `, wins ${p.handResult.won}` : '')
      );
    }
    this.ctx.changed();
    this.ctx.finished();
  }

  // Voluntary reveal after winning by fold.
  handleShowCards(player) {
    if (!this.finished || !this.results?.byFold) return { ok: false, error: 'nothing to show' };
    if (player.folded) return { ok: false, error: 'you folded' };
    player.showedCards = true;
    this.ctx.log(`${player.nickname} shows ${player.holeCards.join(' ')}`);
    this.ctx.changed();
    return { ok: true };
  }

  clearCommitments() {
    for (const p of this.players) {
      p.totalCommitted = 0;
      p.betThisRound = 0;
    }
  }

  collectedPot() {
    return betting.potTotal(this) - this.players.reduce((a, p) => a + p.betThisRound, 0);
  }
}

function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}
