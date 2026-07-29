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
import { buildPots, payoutPots, splitPotsForBoards } from './pots.js';
import { best7, bestOmaha, describe } from './evaluator.js';
import { shuffledDeck } from './deck.js';
import { equity } from './equity.js';
import { detectCooler } from './cooler.js';

const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
const BOARD_CARDS = { flop: 3, turn: 1, river: 1 };
const VERBS = { fold: 'folds', check: 'checks', call: 'calls', bet: 'bets', raise: 'raises' };

export const PRE_ACTIONS = ['fold', 'checkFold', 'check', 'callAny'];

export class Hand {
  constructor({ handNo, variantKey, smallBlind, bigBlind, actionTime, buttonSeat, players, deck, ctx, options = {} }) {
    this.handNo = handNo;
    this.handId = `h${handNo}`;
    this.variant = VARIANTS[variantKey];
    if (!this.variant) throw new Error(`unknown variant ${variantKey}`);
    this.potLimit = !!this.variant.potLimit;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.actionTime = actionTime;
    this.buttonSeat = buttonSeat;
    this.straddleEnabled = !!options.straddle;
    this.rabbitHuntEnabled = !!options.rabbitHunt;
    this.runItTwiceEnabled = !!options.runItTwice;
    this.sevenDeuceBounty = options.sevenDeuceBounty || 0;
    this.bombPot = !!options.bombPot;
    this.ante = options.ante || 0;
    this.straddleSeat = null;
    this.board2 = null;
    this.runItTwice = false;
    this.rabbit = null;
    this.timeBankEngaged = false;
    this.timeBankStartedAt = 0;
    // One turn push per decision point: beginTurn is re-entered by reconnect
    // re-arms and host nudges, and none of those should re-notify.
    this.turnPushSent = new Set();
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
    this.allInEquity = null;
    // Structured record of the hand, used by the replayer. Deliberately
    // separate from ctx.log, which is prose for humans and will drift.
    this.timeline = [];
    this.startedAt = Date.now();
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
      p.preAction = null;
      // Per-hand stat flags, rolled into account aggregates when the hand ends.
      p.handStartStack = p.stack;
      p.handStats = {
        vpip: false,
        pfr: false,
        threeBet: false,
        threeBetOp: false,
        sawFlop: false,
        wtsd: false,
        wsd: false,
        aggressive: 0,
        passive: 0,
        showdownScore: 0,
      };
    }
    this.preflopRaises = 0;

    // Bomb pot: no blinds, everyone antes, straight to the flop.
    if (this.bombPot && this.ante > 0) {
      this.startBombPot();
      return;
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
    this.street = 'preflop';
    this.pushEvent({ type: 'post', seat: this.sbSeat, kind: 'sb', amount: sb.betThisRound });
    this.pushEvent({ type: 'post', seat: this.bbSeat, kind: 'bb', amount: bb.betThisRound });
    this.ctx.log(
      `Hand #${this.handNo} (${this.variant.label}) — ${sb.nickname} posts small blind ${this.smallBlind}, ` +
      `${bb.nickname} posts big blind ${this.bigBlind}`
    );

    // Straddle: UTG posts double the big blind before the deal, and action
    // starts to their left. Skipped heads-up, where the button already posts
    // the small blind and is the only candidate seat.
    if (this.straddleEnabled && this.players.length >= 3) {
      const seat = this.seatAfter(this.bbSeat);
      const straddler = this.bySeat.get(seat);
      const want = this.bigBlind * 2;
      const paid = betting.pay(straddler, want);
      this.straddleSeat = seat;
      this.currentBet = Math.max(this.currentBet, straddler.betThisRound);
      // Only a full straddle resets the raise size; a short all-in straddle
      // follows the same rule as any other undersized all-in.
      if (paid >= want) this.lastFullRaiseSize = want;
      this.pushEvent({ type: 'post', seat, kind: 'straddle', amount: paid });
      this.ctx.log(`${straddler.nickname} straddles ${paid}${straddler.allIn ? ' (all-in)' : ''}`);
    }

    this.dealHoleCards();
    this.enterStreet('preflop', true);
  }

  dealHoleCards() {
    let seat = this.seatAfter(this.buttonSeat);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.bySeat.get(seat);
      p.holeCards = this.draw(this.variant.holeCards);
      seat = this.seatAfter(seat);
    }
    this.pushEvent({ type: 'deal', cards: this.variant.holeCards });
  }

  // Everyone antes and the flop comes straight out. The antes go through
  // betting.pay so they land in totalCommitted and therefore in the pot —
  // moving chips any other way would break chip conservation.
  startBombPot() {
    for (const p of this.players) betting.pay(p, this.ante);
    this.sbSeat = null;
    this.bbSeat = null;
    this.pushEvent({ type: 'bombPot', amount: this.ante });
    this.ctx.log(`Bomb pot — everyone antes ${this.ante}, straight to the flop`);
    this.dealHoleCards();
    // Zero betThisRound/hasActed but keep totalCommitted, then let the normal
    // street machinery handle the pineapple discard and any all-in run-out.
    betting.resetStreet(this);
    this.street = 'preflop';
    this.phase = PHASES.PREFLOP;
    this.afterStreetComplete();
  }

  pushEvent(event) {
    this.timeline.push({ i: this.timeline.length, street: this.street, ...event });
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
      if (this.runItTwice) this.board2.push(...this.draw(dealt));
      this.ctx.log(
        `${cap(street)}: ${this.board.join(' ')}` +
        (this.runItTwice ? ` | ${this.board2.join(' ')}` : '')
      );
      this.pushEvent({
        type: 'board', cards: this.board.slice(-dealt), board: [...this.board],
        board2: this.runItTwice ? [...this.board2] : null,
      });
    }
    if (street === 'flop') {
      for (const p of this.livePlayers()) {
        if (p.handStats) p.handStats.sawFlop = true;
      }
    }

    if (this.runOut) {
      this.afterStreetComplete();
      return;
    }

    this.toActSeat = betting.firstToActSeat(this, street === 'preflop');
    if (this.toActSeat === null) {
      this.afterStreetComplete();
    } else if (this.armOrAutoAct()) {
      this.afterAction();
    }
  }

  // Either a queued pre-action fires immediately (return true, so the caller
  // keeps advancing) or the turn is armed normally (return false).
  // Doing it this way instead of calling beginTurn recursively keeps a chain
  // of pre-actions to a single broadcast and out of the call stack.
  armOrAutoAct() {
    const player = this.bySeat.get(this.toActSeat);
    const choice = this.takePreAction(player);
    if (choice === null) {
      this.beginTurn();
      this.ctx.changed();
      return false;
    }
    this.noteActionStats(player, choice);
    betting.applyAction(this, player, choice, null);
    if (this.street === 'preflop' && (choice === 'bet' || choice === 'raise')) this.preflopRaises++;
    this.lastAction = { seat: player.seatIndex, action: choice, amount: player.betThisRound };
    this.pushEvent({
      type: 'action', seat: player.seatIndex, action: choice,
      amount: player.betThisRound, preSelected: true, pot: betting.potTotal(this),
    });
    this.ctx.log(`${player.nickname} ${VERBS[choice]} (pre-selected)`);
    return true;
  }

  // Pre-actions are resolved against live state at the moment they fire, not
  // eagerly when someone bets. That is what makes "Check" cancel harmlessly
  // when a bet appears, while "Check/Fold" folds.
  takePreAction(player) {
    const pre = player.preAction;
    player.preAction = null; // always one-shot
    if (!pre || pre.street !== this.street || this.finished) return null;
    const toCall = this.currentBet - player.betThisRound;
    switch (pre.kind) {
      case 'fold': return 'fold';
      case 'checkFold': return toCall > 0 ? 'fold' : 'check';
      case 'check': return toCall > 0 ? null : 'check';
      case 'callAny': return 'call';
      default: return null;
    }
  }

  beginTurn() {
    const player = this.bySeat.get(this.toActSeat);
    let ms = null;
    if (player.sittingOut) ms = TIMINGS.AWAY_GRACE;
    else if (this.actionTime > 0) ms = this.actionTime * 1000;
    else if (!player.connected) ms = TIMINGS.DISCONNECT_GRACE; // no-limit timer can't wait forever for a gone player
    if (ms !== null) {
      this.timeBankEngaged = false;
      this.ctx.setTimer('action', ms, () => this.handleTimeout());
    } else {
      this.ctx.clearTimer();
    }

    // Push "it's your turn" to a player who isn't here to see it.
    if (!player.connected && this.ctx.notifyTurn) {
      const key = `${this.toActSeat}:${this.street}:${this.currentBet}`;
      if (!this.turnPushSent.has(key)) {
        this.turnPushSent.add(key);
        this.ctx.notifyTurn(player);
      }
    }
  }

  canUseTimeBank(player) {
    return (
      this.actionTime > 0 &&
      (player.timeBank || 0) > 0 &&
      !player.sittingOut &&
      player.connected
    );
  }

  // markAway is false when the host forces a decision — nudging someone who
  // is present shouldn't also sit them out.
  handleTimeout({ markAway = true } = {}) {
    const player = this.bySeat.get(this.toActSeat);
    if (!player || this.finished) return;

    // The clock runs out into the time bank first, sequentially, so the
    // game still only ever has one pending timer.
    if (!this.timeBankEngaged && this.canUseTimeBank(player)) {
      this.timeBankEngaged = true;
      this.timeBankStartedAt = Date.now();
      this.ctx.log(`${player.nickname} is into their time bank`);
      this.ctx.setTimer('timebank', player.timeBank, () => this.handleTimeout({ markAway }));
      this.ctx.changed();
      return;
    }
    if (this.timeBankEngaged) {
      player.timeBank = 0;
      this.timeBankEngaged = false;
    }

    const av = betting.availableActionsFor(this, player);
    const action = av.canCheck ? 'check' : 'fold';
    if (!player.sittingOut && markAway) {
      this.ctx.markAway(player);
      this.ctx.log(`${player.nickname} didn't act in time and is now away`);
    }
    betting.applyAction(this, player, action, null);
    this.lastAction = { seat: player.seatIndex, action, amount: null };
    this.pushEvent({
      type: 'action', seat: player.seatIndex, action,
      amount: player.betThisRound, timedOut: true, pot: betting.potTotal(this),
    });
    this.ctx.log(`${player.nickname} ${action === 'check' ? 'checks' : 'folds'} (time)`);
    this.afterAction();
  }

  // Queue an action to fire automatically when the turn reaches this player.
  setPreAction(player, kind) {
    if (this.finished || !this.isBettingPhase()) return { ok: false, error: 'no betting right now' };
    if (player.folded || player.allIn) return { ok: false, error: 'you are not acting in this hand' };
    if (player.seatIndex === this.toActSeat) return { ok: false, error: "it's your turn — just act" };
    if (kind === null) {
      player.preAction = null;
      return { ok: true };
    }
    if (!PRE_ACTIONS.includes(kind)) return { ok: false, error: 'unknown pre-action' };
    player.preAction = { kind, street: this.street };
    return { ok: true };
  }

  // Entry point from sockets. Returns { ok, error? }.
  handleAction(player, action, amount) {
    if (this.finished) return { ok: false, error: 'hand is over' };
    if (!this.isBettingPhase()) return { ok: false, error: 'no betting right now' };
    if (player.seatIndex !== this.toActSeat) return { ok: false, error: 'not your turn' };

    // Time spent in the bank is deducted on use, not granted up front.
    if (this.timeBankEngaged) {
      player.timeBank = Math.max(0, player.timeBank - (Date.now() - this.timeBankStartedAt));
      this.timeBankEngaged = false;
    }

    const before = this.currentBet;
    this.noteActionStats(player, action);
    const result = betting.applyAction(this, player, action, amount);
    if (!result.ok) return result;
    if (this.street === 'preflop' && (action === 'bet' || action === 'raise')) {
      this.preflopRaises++;
    }

    this.ctx.clearTimer();
    const shown =
      action === 'fold' ? 'folds'
      : action === 'check' ? 'checks'
      : action === 'call' ? `calls ${player.betThisRound}`
      : before === 0 ? `bets ${player.betThisRound}`
      : `raises to ${player.betThisRound}`;
    this.lastAction = { seat: player.seatIndex, action, amount: player.betThisRound };
    this.pushEvent({
      type: 'action', seat: player.seatIndex, action,
      amount: player.betThisRound, allIn: player.allIn,
      pot: betting.potTotal(this),
    });
    this.ctx.log(`${player.nickname} ${shown}${player.allIn ? ' (all-in)' : ''}`);
    this.afterAction();
    return { ok: true };
  }

  // Records the standard poker stats. Called before the action is applied so
  // preflop raise counts still describe the state the player faced.
  noteActionStats(player, action) {
    const s = player.handStats;
    if (!s) return;
    const isPreflop = this.street === 'preflop';
    const raising = action === 'bet' || action === 'raise';

    if (raising) s.aggressive++;
    else if (action === 'call') s.passive++;

    if (!isPreflop) return;
    if (this.preflopRaises >= 1) s.threeBetOp = true;
    // Blinds are posted, not chosen — only a call or raise is voluntary.
    if (action === 'call' || raising) s.vpip = true;
    if (raising) {
      s.pfr = true;
      if (this.preflopRaises >= 1) s.threeBet = true;
    }
  }

  // A loop rather than recursion, so a run of queued pre-actions resolves in
  // one pass and produces a single broadcast at the end.
  afterAction() {
    for (;;) {
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
      if (!this.armOrAutoAct()) return;
    }
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
      // Run it twice: both boards share every card dealt before the all-in,
      // and draw from the same cursor so they can never duplicate a card.
      if (this.runItTwiceEnabled && NEXT_STREET[this.street] !== 'showdown') {
        this.runItTwice = true;
        this.board2 = [...this.board];
        this.ctx.log('Running it twice');
      }
      // Snapshot the odds at the moment the chips went in — that is what
      // makes a later loss a bad beat rather than just a loss.
      try {
        this.allInEquity = equity(
          live.map((p) => ({ seat: p.seatIndex, holeCards: p.holeCards })),
          this.board,
          { omaha: !!this.variant.omaha }
        );
      } catch {
        this.allInEquity = null;
      }
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
    // Untimed tables still need a fallback here: the discard phase has no
    // seat to act, so nothing else can rescue a table whose player vanished.
    const ms = this.actionTime > 0 ? TIMINGS.DISCARD_TIME : TIMINGS.DISCARD_NO_CLOCK;
    this.phase = this.variant.discardAfter === 'preflop'
      ? PHASES.DISCARD_PREFLOP
      : PHASES.DISCARD_POSTFLOP;
    this.toActSeat = null;
    this.ctx.log('Discard: each player throws away one card');
    this.ctx.setTimer('discard', ms, () => this.discardTimeout());
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
    this.pushEvent({ type: 'discard', seat: player.seatIndex });
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
    // Untimed tables only auto-discard for people who aren't there; everyone
    // else keeps thinking, and the fallback re-arms.
    const targets = this.actionTime > 0
      ? this.discardPending()
      : this.discardPending().filter((p) => !p.connected || p.sittingOut);
    for (const p of targets) {
      p.holeCards.pop();
      p.hasDiscarded = true;
      this.ctx.log(`${p.nickname} auto-discards (${this.actionTime > 0 ? 'time' : 'away'})`);
    }
    if (this.discardPending().length === 0) {
      this.finishDiscard();
      return;
    }
    this.ctx.setTimer('discard', TIMINGS.DISCARD_NO_CLOCK, () => this.discardTimeout());
    this.ctx.changed();
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
    this.results.bounty = this.applySevenDeuce(winner);
    this.pushEvent({ type: 'payout', seat: winner.seatIndex, amount: pot, byFold: true });
    this.ctx.log(`${winner.nickname} wins ${pot}`);
    this.ctx.changed();
    this.ctx.finished();
  }

  showdown() {
    this.ctx.clearTimer();
    const uncalledReturn = this.returnUncalledBet();
    const live = this.livePlayers();

    const pots = buildPots(this.players);
    const boards = this.runItTwice ? [this.board, this.board2] : [this.board];
    const potSets = this.runItTwice ? splitPotsForBoards(pots, 2) : [pots];

    const totals = new Map();
    const boardResults = [];
    let firstBoardScores = null;

    for (let b = 0; b < boards.length; b++) {
      const scores = new Map();
      for (const p of live) {
        const { score } = this.variant.omaha
          ? bestOmaha(p.holeCards, boards[b])
          : best7([...p.holeCards, ...boards[b]]);
        scores.set(p.seatIndex, score);
      }
      if (b === 0) firstBoardScores = scores;
      const { winnings } = payoutPots(potSets[b], scores, this.buttonSeat);
      for (const [seat, amount] of winnings) {
        totals.set(seat, (totals.get(seat) || 0) + amount);
      }
      boardResults.push({
        index: b,
        board: [...boards[b]],
        winners: [...winnings].map(([seat, amount]) => ({ seat, amount })),
        descs: Object.fromEntries(live.map((p) => [p.seatIndex, describe(scores.get(p.seatIndex))])),
      });
    }

    // Chip conservation across boards. A mismatch voids the hand and pauses
    // the table rather than silently corrupting the ledger.
    const paid = [...totals.values()].reduce((a, b) => a + b, 0);
    const owed = pots.reduce((a, p) => a + p.amount, 0);
    if (paid !== owed) throw new Error(`showdown payout mismatch: paid ${paid}, pots ${owed}`);

    const winners = [];
    for (const [seat, amount] of totals) {
      this.bySeat.get(seat).stack += amount;
      winners.push({ seat, amount });
    }
    const scores = firstBoardScores;
    for (const p of live) {
      const won = totals.get(p.seatIndex) || 0;
      p.handResult = {
        desc: describe(scores.get(p.seatIndex)),
        descs: boardResults.map((r) => r.descs[p.seatIndex]),
        won,
      };
      if (p.handStats) {
        // Only a contested showdown counts — an all-in run-out still shows
        // cards down, which is exactly what "went to showdown" means.
        p.handStats.wtsd = true;
        p.handStats.wsd = won > 0;
        p.handStats.showdownScore = scores.get(p.seatIndex);
      }
    }
    const potTotal = pots.reduce((a, p) => a + p.amount, 0);
    let cooler = null;
    try {
      cooler = detectCooler({
        players: live.map((p) => ({
          seat: p.seatIndex,
          nickname: p.nickname,
          score: scores.get(p.seatIndex),
          desc: p.handResult.desc,
          won: p.handResult.won,
          folded: false,
        })),
        potTotal,
        bigBlind: this.bigBlind,
        allInEquity: this.allInEquity,
      });
    } catch {
      cooler = null;
    }

    this.clearCommitments();
    this.revealed = true;
    this.phase = PHASES.SHOWDOWN;
    this.toActSeat = null;
    this.finished = true;
    const outrightWinner = winners.length === 1 ? this.bySeat.get(winners[0].seat) : null;
    const bounty = this.applySevenDeuce(outrightWinner);
    this.results = {
      pots, winners, uncalledReturn, byFold: false, cooler, bounty,
      runItTwice: this.runItTwice,
      boards: this.runItTwice ? boardResults : null,
    };
    if (cooler) this.ctx.log(`${cooler.headline}: ${cooler.detail}`);

    for (const p of live) {
      this.pushEvent({
        type: 'reveal', seat: p.seatIndex, cards: [...p.holeCards], desc: p.handResult.desc,
      });
      this.ctx.log(
        `${p.nickname} shows ${p.holeCards.join(' ')} — ${p.handResult.desc}` +
        (p.handResult.won ? `, wins ${p.handResult.won}` : '')
      );
    }
    for (const w of winners) {
      this.pushEvent({ type: 'payout', seat: w.seat, amount: w.amount, byFold: false });
    }
    this.ctx.changed();
    this.ctx.finished();
  }

  // Seven-deuce bounty: winning with the worst starting hand collects from
  // everyone else. Strictly zero-sum and capped at each payer's stack — a
  // flat payout would mint chips against a short stack and break the ledger.
  applySevenDeuce(winner) {
    if (!this.sevenDeuceBounty || !winner || !hasSevenDeuce(winner.holeCards)) return null;
    const transfers = [];
    let collected = 0;
    for (const p of this.players) {
      if (p === winner) continue;
      const paid = Math.min(this.sevenDeuceBounty, p.stack);
      if (paid <= 0) continue;
      p.stack -= paid;
      collected += paid;
      transfers.push({ seat: p.seatIndex, amount: -paid });
    }
    if (collected === 0) return null;
    winner.stack += collected;
    // The table is owed an explanation for the transfer, so the winning
    // hand is turned face up.
    winner.showedCards = true;
    this.pushEvent({ type: 'bounty', seat: winner.seatIndex, amount: collected });
    this.ctx.log(`${winner.nickname} wins the 7-2 bounty: ${collected}`);
    return { winnerSeat: winner.seatIndex, total: collected, transfers };
  }

  // Rabbit hunt: after a hand ends early, show what would have come. Only
  // ever legal once the hand is over — dealing these out mid-hand would
  // expose the deck to live players.
  handleRabbitHunt(player) {
    if (!this.rabbitHuntEnabled) return { ok: false, error: 'rabbit hunting is off at this table' };
    if (!this.finished || !this.results?.byFold) return { ok: false, error: 'nothing to hunt' };
    if (this.board.length >= 5) return { ok: false, error: 'the board already ran out' };
    if (this.rabbit) return { ok: false, error: 'already revealed' };
    if (this.bySeat.get(player.seatIndex) !== player) {
      return { ok: false, error: 'you were not in this hand' };
    }
    this.rabbit = this.draw(5 - this.board.length);
    this.ctx.log(`${player.nickname} rabbit hunts: ${this.rabbit.join(' ')}`);
    this.ctx.changed();
    return { ok: true };
  }

  // Voluntary reveal after winning by fold.
  handleShowCards(player) {
    if (!this.finished || !this.results?.byFold) return { ok: false, error: 'nothing to show' };
    if (this.bySeat.get(player.seatIndex) !== player) {
      return { ok: false, error: 'you were not in this hand' };
    }
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

// Qualifies on the cards still held — for the pineapple variants that is
// correctly the hand after the discard.
function hasSevenDeuce(cards) {
  const ranks = new Set(cards.map((c) => c[0]));
  return ranks.has('7') && ranks.has('2');
}
