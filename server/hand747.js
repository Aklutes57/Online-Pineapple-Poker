// The 747 Poker engine: an ante-based dealer game that plugs into the same
// seam as the community-card engine (hand.js). It implements the identical
// ctx contract — log/changed/finished/setTimer/clearTimer — and the same
// player per-hand fields, so Game, sockets, views, the ledger, stats and
// the replayer all work unchanged.
//
// Flow: antes → four cards each (plus a hidden dealer hand) → simultaneous
// stay/fold decisions → 3-2-1 countdown → reveal → fifth card to stayers
// and dealer → Natural Seven check (original four cards only) → wildcard
// evaluation (fours are wild) → each stayer compared against the dealer.
// Winners split the pot; ties lose to the dealer; if the dealer beats
// everyone, the pot rides to the next 747 hand (carryOut → Game.carryPot).
// Chips only ever move through betting.pay and the pot — conservation holds.

import { PHASES, TIMINGS } from '../shared/constants.js';
import * as betting from './betting.js';
import { payoutPots } from './pots.js';
import { shuffledDeck } from './deck.js';
import {
  evaluate747, isNaturalSeven, describe747, NATURAL_SEVEN_SCORE,
} from './evaluator747.js';

export class Hand747 {
  constructor({ handNo, smallBlind, bigBlind, actionTime, buttonSeat, players, deck, fairness = null, ctx, carryIn = 0 }) {
    this.handNo = handNo;
    this.handId = `h${handNo}`;
    this.variant = { key: '747', label: '747 Poker', engine: '747' };
    this.ante = bigBlind; // the table's big-blind setting is the 747 ante
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.actionTime = actionTime;
    this.buttonSeat = buttonSeat;
    this.players = players;
    this.bySeat = new Map(players.map((p) => [p.seatIndex, p]));
    this.seatOrder = players.map((p) => p.seatIndex).sort((a, b) => a - b);
    this.deck = deck || shuffledDeck();
    this.deckIndex = 0;
    // Public provably-fair proof for this hand (never holds the server seed).
    this.fairness = fairness || null;
    this.carryIn = carryIn;

    // Interface surface shared with the community engine.
    this.phase = null;
    this.street = null;
    this.board = []; // holds the dealer's revealed cards at showdown
    this.board2 = null;
    this.rabbit = null;
    this.rabbitHuntEnabled = false;
    this.toActSeat = null; // decisions are simultaneous; nobody is "to act"
    this.currentBet = 0;
    this.lastAction = null;
    this.runOut = false;
    this.revealed = false;
    this.finished = false;
    this.results = null;
    this.sbSeat = null; // no blinds in a dealer game
    this.bbSeat = null;
    this.straddleSeat = null;
    this.bombPot = false;
    this.timeline = [];
    this.startedAt = Date.now();

    this.dealerCards = []; // SECRET until showdown
    this.dealerRevealed = false;
    this.ctx = ctx;

    if (players.length < 2) throw new Error('need at least 2 players');
    // 9 players + dealer × 5 cards = 50 of 52; a tenth would bust the deck.
    if (players.length > 9) throw new Error('747 deals at most 9 players');
  }

  pushEvent(event) {
    this.timeline.push({ i: this.timeline.length, street: this.phase, ...event });
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

  seatsFromButton() {
    const out = [];
    let seat = this.seatAfter(this.buttonSeat);
    for (let i = 0; i < this.players.length; i++) {
      out.push(this.bySeat.get(seat));
      seat = this.seatAfter(seat);
    }
    return out;
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
      p.preAction = null;
      p.decision747 = null; // 'stay' | 'fold', SECRET until the countdown ends
      p.originalFour = null; // Natural Seven is judged on these, not the final five
      p.handStartStack = p.stack;
      p.handStats = {
        vpip: false, pfr: false, threeBet: false, threeBetOp: false,
        sawFlop: false, wtsd: false, wsd: false,
        aggressive: 0, passive: 0, showdownScore: 0,
      };
    }

    // Antes. Game only deals in players who can cover it, so nobody antes
    // short — and every chip goes through betting.pay into totalCommitted.
    for (const p of this.seatsFromButton()) {
      betting.pay(p, this.ante);
      this.pushEvent({ type: 'post', seat: p.seatIndex, kind: 'ante', amount: this.ante });
    }
    this.ctx.log(
      `Hand #${this.handNo} (747 Poker) — everyone antes ${this.ante}` +
      (this.carryIn > 0 ? `, plus ${this.carryIn} riding from the last pot` : '')
    );

    // Four cards to every player, then four to the dealer.
    for (const p of this.seatsFromButton()) {
      p.holeCards = this.draw(4);
      p.originalFour = [...p.holeCards];
    }
    this.dealerCards = this.draw(4);
    this.pushEvent({ type: 'deal', cards: 4, dealer: true });

    this.phase = PHASES.DECISION_747;
    this.ctx.log('Stay or fold — choices stay hidden until everyone locks in');
    this.armDecisionTimer();
    this.ctx.changed();
  }

  armDecisionTimer() {
    const ms = this.actionTime > 0 ? this.actionTime * 1000 : TIMINGS.DISCARD_NO_CLOCK;
    this.ctx.setTimer('decision747', ms, () => this.decisionTimeout());
  }

  undecided() {
    return this.livePlayers().filter((p) => p.decision747 === null);
  }

  // ---- stay / fold ----

  handleDecision(player, stay) {
    if (this.phase !== PHASES.DECISION_747) return { ok: false, error: 'no decision to make right now' };
    if (player.folded || this.bySeat.get(player.seatIndex) !== player) {
      return { ok: false, error: 'you are not in this hand' };
    }
    if (player.decision747 !== null) return { ok: false, error: 'you already locked in' };
    player.decision747 = stay ? 'stay' : 'fold';
    this.ctx.log(`${player.nickname} locked in`); // never says which way
    if (this.undecided().length === 0) {
      this.enterCountdown();
    } else {
      this.ctx.changed();
    }
    return { ok: true };
  }

  decisionTimeout() {
    // Timed tables: no decision means fold. Untimed tables only fold the
    // absent, and keep waiting for everyone present (mirrors the discard
    // fallback that stops a vanished player freezing the table).
    const targets = this.actionTime > 0
      ? this.undecided()
      : this.undecided().filter((p) => !p.connected || p.sittingOut);
    for (const p of targets) {
      p.decision747 = 'fold';
      this.ctx.log(`${p.nickname} locked in (time)`);
    }
    if (this.undecided().length === 0) {
      this.enterCountdown();
    } else {
      this.armDecisionTimer();
      this.ctx.changed();
    }
  }

  enterCountdown() {
    this.phase = PHASES.COUNTDOWN_747;
    this.ctx.log('3… 2… 1…');
    this.ctx.setTimer('countdown747', TIMINGS.COUNTDOWN_747, () => this.reveal());
    this.ctx.changed();
  }

  // ---- reveal, fifth card, showdown ----

  reveal() {
    for (const p of this.seatsFromButton()) {
      this.pushEvent({ type: 'decision', seat: p.seatIndex, stay: p.decision747 === 'stay' });
      if (p.decision747 !== 'stay') {
        p.folded = true; // ante stays in the pot
      }
    }
    const stayers = this.livePlayers();
    this.ctx.log(
      stayers.length
        ? `Staying: ${stayers.map((p) => p.nickname).join(', ')}`
        : 'Everyone folded — the dealer sweeps'
    );

    if (stayers.length === 0) {
      this.finishShowdown([], new Map());
      return;
    }

    // Fifth card to each stayer, then the dealer's fifth.
    for (const p of this.seatsFromButton()) {
      if (!p.folded) p.holeCards.push(...this.draw(1));
    }
    this.dealerCards.push(...this.draw(1));

    // Natural Seven first (original four cards, wilds never count), then
    // full wildcard evaluation for everyone else and the dealer.
    const scores = new Map();
    for (const p of stayers) {
      scores.set(
        p.seatIndex,
        isNaturalSeven(p.originalFour) ? NATURAL_SEVEN_SCORE : evaluate747(p.holeCards)
      );
    }
    const dealerScore = evaluate747(this.dealerCards);

    // Each player plays the dealer, not each other. Ties lose to the house.
    const winners = stayers.filter((p) => scores.get(p.seatIndex) > dealerScore);
    this.finishShowdown(winners, scores, dealerScore);
  }

  finishShowdown(winners, scores, dealerScore = null) {
    this.ctx.clearTimer();
    const pot = this.players.reduce((a, p) => a + p.totalCommitted, 0) + this.carryIn;
    const winnerSeats = winners.map((p) => p.seatIndex);
    const naturalSevenSeats = winners
      .filter((p) => scores.get(p.seatIndex) === NATURAL_SEVEN_SCORE)
      .map((p) => p.seatIndex);

    let winnersOut = [];
    let carryOut = 0;
    if (winnerSeats.length > 0) {
      // Equal shares via the existing pot machinery (odd chips clockwise
      // from the button) by scoring every winner identically.
      const flat = new Map(winnerSeats.map((s) => [s, 1]));
      const { winnings } = payoutPots(
        [{ amount: pot, eligibleSeats: winnerSeats }], flat, this.buttonSeat
      );
      for (const [seat, amount] of winnings) {
        this.bySeat.get(seat).stack += amount;
        winnersOut.push({ seat, amount });
      }
    } else {
      carryOut = pot; // the dealer swept — the pot rides
      this.carryIn = 0; // consumed into the ride, not refundable twice
      this.ctx.carryOut(carryOut);
    }

    for (const p of this.players) {
      p.totalCommitted = 0;
      p.betThisRound = 0;
    }

    this.dealerRevealed = true;
    this.board = [...this.dealerCards]; // saved hands show the dealer as the "board"
    const dealerDesc = dealerScore !== null ? describe747(dealerScore) : null;
    // street 'dealer' so the replayer titles the line "Dealer: …".
    this.pushEvent({ type: 'board', street: 'dealer', cards: [...this.dealerCards], board: [...this.dealerCards], dealer: true });

    for (const p of this.livePlayers()) {
      const score = scores.get(p.seatIndex) ?? 0;
      const won = winnersOut.find((w) => w.seat === p.seatIndex)?.amount || 0;
      p.handResult = { desc: describe747(score), won };
      p.handStats.vpip = true;
      p.handStats.sawFlop = true;
      p.handStats.wtsd = true;
      p.handStats.wsd = won > 0;
      p.handStats.showdownScore = score;
      this.pushEvent({ type: 'reveal', seat: p.seatIndex, cards: [...p.holeCards], desc: p.handResult.desc });
      this.ctx.log(
        `${p.nickname} shows ${p.holeCards.join(' ')} — ${p.handResult.desc}` +
        (won ? `, beats the dealer for ${won}` : dealerScore !== null ? ', loses to the dealer' : '')
      );
    }
    for (const w of winnersOut) {
      this.pushEvent({ type: 'payout', seat: w.seat, amount: w.amount, byFold: false });
    }
    if (dealerDesc) {
      this.ctx.log(`Dealer shows ${this.dealerCards.join(' ')} — ${dealerDesc}`);
    } else {
      this.ctx.log(`Dealer had ${this.dealerCards.join(' ')}`);
    }
    if (naturalSevenSeats.length) {
      for (const seat of naturalSevenSeats) {
        this.ctx.log(`🎉 NATURAL SEVEN — ${this.bySeat.get(seat).nickname} wins automatically!`);
      }
    }
    if (carryOut > 0) {
      this.ctx.log(`Nobody beat the dealer — ${carryOut} rides to the next 747 hand`);
    }

    this.revealed = true;
    this.phase = PHASES.SHOWDOWN;
    this.finished = true;
    this.results = {
      pots: [{ amount: pot, eligibleSeats: winnerSeats }],
      winners: winnersOut,
      uncalledReturn: null,
      byFold: false,
      cooler: null,
      bounty: null,
      runItTwice: false,
      boards: null,
      dealer: { cards: [...this.dealerCards], desc: dealerDesc },
      naturalSevenSeats,
      carryOut,
    };
    this.ctx.changed();
    this.ctx.finished();
  }

  // ---- shared engine interface: everything betting-shaped is refused ----

  isBettingPhase() {
    return false;
  }

  handleAction() {
    return { ok: false, error: 'there is no betting in 747 — stay or fold' };
  }

  setPreAction() {
    return { ok: false, error: 'pre-actions do not apply to 747' };
  }

  handleDiscard() {
    return { ok: false, error: 'there is no discard in 747' };
  }

  // Stayers' hands reveal automatically; the only voluntary show left is a
  // folder proving what they threw away, once the hand is over.
  handleShowCards(player) {
    if (!this.finished) return { ok: false, error: 'the hand is not over' };
    if (this.bySeat.get(player.seatIndex) !== player) {
      return { ok: false, error: 'you were not in this hand' };
    }
    if (!player.folded) return { ok: false, error: 'your hand was shown automatically' };
    if (player.showedCards) return { ok: false, error: 'already shown' };
    player.showedCards = true;
    this.ctx.log(`${player.nickname} shows ${player.holeCards.join(' ')}`);
    this.ctx.changed();
    return { ok: true };
  }

  handleRabbitHunt() {
    return { ok: false, error: 'no rabbit hunting in 747' };
  }

  // Dealer's public face: card backs while play is live, the full hand once
  // the showdown reveals it.
  dealerView() {
    return {
      cardCount: this.dealerCards.length,
      cards: this.dealerRevealed ? [...this.dealerCards] : null,
      desc: this.finished ? this.results?.dealer?.desc ?? null : null,
    };
  }

  collectedPot() {
    return (
      this.players.reduce((a, p) => a + p.totalCommitted, 0) + this.carryIn
    );
  }
}
