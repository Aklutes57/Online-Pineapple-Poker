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
import { best7, bestAny, bestOmaha, describe, describePartial } from './evaluator.js';
import { shuffledDeck } from './deck.js';
import { equity } from './equity.js';
import { detectCooler } from './cooler.js';

const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
const BOARD_CARDS = { flop: 3, turn: 1, river: 1 };
const VERBS = { fold: 'folds', check: 'checks', call: 'calls', bet: 'bets', raise: 'raises' };

export const PRE_ACTIONS = ['fold', 'checkFold', 'check', 'callAny'];

export class Hand {
  constructor({ handNo, variantKey, smallBlind, bigBlind, actionTime, buttonSeat, players, deck, fairness = null, ctx, options = {} }) {
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
    // Run it twice deals the boards one after the other, never side by side.
    // The cards are still DRAWN street by street at their own deck positions
    // (that is what the integrity proof is over), but the second row stays
    // face down until the first board has reached the river — board2Shown is
    // how many of its cards the table is allowed to see so far.
    this.board2Shown = 0;
    this.board2Steps = [];   // how many cards each of board two's streets added
    this.ritPrefix = 0;      // cards the two boards share (dealt before the vote)
    this.board2Reveal = 0;   // which reveal checkpoint we are on
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
    // Public provably-fair proof for this hand (never holds the server seed).
    this.fairness = fairness || null;
    this.board = [];
    this.phase = null;
    this.street = null;
    this.currentBet = 0;
    this.lastFullRaiseSize = bigBlind;
    this.toActSeat = null;
    this.runOut = false;
    this.revealed = false;
    this.allInEquity = null;
    this.allInEquityCards = -1;
    // Live equity for the board currently being dealt, published only while
    // every remaining hand is already face up. See refreshEquity().
    this.equityNow = null;
    // Structured record of the hand, used by the replayer. Deliberately
    // separate from ctx.log, which is prose for humans and will drift.
    this.timeline = [];
    this.startedAt = Date.now();
    this.discardsDone = !this.variant.discardBefore;
    this.afterDiscard = 'bet';
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
        // The best five-card hand this player actually held, whether or not it
        // was ever shown down — "best hand ever made" on the profile means the
        // quads you took down uncontested too, not just the ones you tabled.
        madeScore: 0,
        madeDesc: null,
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
    // the small blind and is the only candidate seat. The table option makes
    // the straddle available; each player opts in or out for themselves
    // (default in), so an opted-out UTG just plays a normal hand.
    if (this.straddleEnabled && this.players.length >= 3
        && this.bySeat.get(this.seatAfter(this.bbSeat))?.straddleOptIn !== false) {
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
    // A bomb pot skips the preflop round, but a Pineapple player still has to
    // pitch a card before the flop is dealt — discard, then carry on.
    if (this.variant.discardBefore === 'preflop' && !this.discardsDone && this.discardPending().length) {
      this.enterDiscard('proceed');
      return;
    }
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
      // The second board's cards for this street are drawn now, at the deck
      // positions they have always occupied, but they are not shown yet — the
      // table sees them once the first board is finished (revealSecondBoard).
      if (this.runItTwice) {
        this.board2.push(...this.draw(dealt));
        this.board2Steps.push(dealt);
      }
      this.ctx.log(`${cap(street)}: ${this.board.join(' ')}`);
      this.pushEvent({
        type: 'board', cards: this.board.slice(-dealt), board: [...this.board],
        board2: this.runItTwice ? [...this.board2] : null,
      });
      this.refreshEquity();
    }
    if (street === 'flop') {
      for (const p of this.livePlayers()) {
        if (p.handStats) p.handStats.sawFlop = true;
      }
    }

    // Pineapple discards happen BEFORE this street's betting: regular
    // Pineapple throws a card away and then plays the preflop round with two,
    // and Crazy Pineapple bets preflop holding three then discards the moment
    // the flop lands. Checked ahead of the run-out branch because an all-in
    // player still has to pitch a card before any showdown.
    if (this.variant.discardBefore === street && !this.discardsDone && this.discardPending().length) {
      this.enterDiscard();
      return;
    }

    if (this.runOut) {
      this.afterStreetComplete();
      return;
    }

    this.beginBetting();
  }

  // Opens the betting round for whatever street we're on.
  beginBetting() {
    this.phase = PHASES[this.street.toUpperCase()];
    this.toActSeat = betting.firstToActSeat(this, this.street === 'preflop');
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
    // Nobody is to act: the table is waiting on everyone at once, or a caller
    // reached here with a seat that is not in this hand. Arming a turn for a
    // player who does not exist is how a stray reconnect used to crash the
    // whole process, so this is the last line rather than the only one.
    if (!player) return;
    let ms = null;
    if (player.sittingOut) ms = TIMINGS.AWAY_GRACE;
    // An offline player folds (or checks) on the short disconnect clock no
    // matter what the table's action timer is — the table never waits a full
    // turn clock for somebody who is gone.
    else if (!player.connected) ms = TIMINGS.DISCONNECT_GRACE;
    else if (this.actionTime > 0) ms = this.actionTime * 1000;
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
    this.proceedFromStreet();
  }

  proceedFromStreet() {
    // All-in run-out check: at least 2 live, at most 1 of them not all-in.
    const live = this.livePlayers();
    const actors = live.filter((p) => !p.allIn);
    if (!this.runOut && live.length >= 2 && actors.length <= 1) {
      this.runOut = true;
      // Snapshot the odds at the moment the chips went in — that is what
      // makes a later loss a bad beat rather than just a loss.
      try {
        this.allInEquity = equity(
          live.map((p) => ({ seat: p.seatIndex, holeCards: p.holeCards })),
          this.board,
          { omaha: !!this.variant.omaha }
        );
        // What it was computed over, so refreshEquity can tell whether it is
        // still the right answer instead of enumerating it all over again.
        this.allInEquityCards = this.board.length;
      } catch {
        this.allInEquity = null;
        this.allInEquityCards = -1;
      }
      // Running it twice is never automatic: everyone still in the hand has to
      // agree, every time. Ask them, and carry on once the answers are in.
      if (this.runItTwiceEnabled && NEXT_STREET[this.street] !== 'showdown') {
        this.enterRitVote();
        return;
      }
    }
    this.continueStreet();
  }

  // ---- run it twice: unanimous, per hand ----

  enterRitVote() {
    const live = this.livePlayers();
    for (const p of live) p.ritVote = null;
    this.phase = PHASES.RIT_VOTE;
    this.toActSeat = null;
    this.ctx.log('All-in — run it twice? Everyone in the hand has to agree.');
    this.ctx.setTimer('ritvote', TIMINGS.RIT_VOTE_TIME, () => this.resolveRitVote(true));
    this.ctx.changed();
  }

  handleRitVote(player, yes) {
    if (this.phase !== PHASES.RIT_VOTE) return { ok: false, error: 'no vote right now' };
    if (player.folded) return { ok: false, error: 'you are not in this hand' };
    if (player.ritVote !== null && player.ritVote !== undefined) return { ok: true };
    player.ritVote = !!yes;
    this.ctx.log(`${player.nickname} wants to run it ${yes ? 'twice' : 'once'}`);
    // One "no" settles it — no point asking the rest.
    const live = this.livePlayers();
    if (!yes || live.every((p) => p.ritVote !== null && p.ritVote !== undefined)) {
      this.ctx.clearTimer();
      this.resolveRitVote();
    } else {
      this.ctx.changed();
    }
    return { ok: true };
  }

  resolveRitVote(timedOut = false) {
    const live = this.livePlayers();
    // Unanimous or it does not happen: every player still in the hand has to
    // have said yes. A single no, or anyone who never answered, runs it once.
    const unanimous = live.length > 0 && live.every((p) => p.ritVote === true);
    this.runItTwice = unanimous;
    if (unanimous) {
      // Both boards share every card dealt before the all-in, and draw from
      // the same cursor so they can never duplicate a card.
      this.board2 = [...this.board];
      this.ritPrefix = this.board.length;
      this.ctx.log(`Running it twice — all ${live.length} players agreed`);
    } else {
      const refused = live.filter((p) => p.ritVote === false).map((p) => p.nickname);
      const silent = live.filter((p) => p.ritVote === null || p.ritVote === undefined);
      this.ctx.log(
        refused.length
          ? `Running it once — ${refused.join(', ')} said once`
          : timedOut && silent.length
            ? `Running it once — ${silent.map((p) => p.nickname).join(', ')} did not answer`
            : 'Running it once'
      );
    }
    this.phase = PHASES[this.street.toUpperCase()];
    this.continueStreet();
  }

  // ---- run it twice: the second board, dealt after the first ----

  // How many of board two's cards are face up at each step of its reveal: the
  // shared cards land together (they are already face up on the first row),
  // then one street at a time, matching how the first board was dealt.
  board2Checkpoints() {
    const out = [];
    let shown = this.ritPrefix;
    if (shown > 0) out.push(shown);
    for (const step of this.board2Steps) {
      shown += step;
      out.push(shown);
    }
    return out;
  }

  // One tick of the second board's run-out. Called on the same cadence as the
  // first board's streets, so the table watches two run-outs in sequence
  // instead of two boards filling in at once.
  revealSecondBoard() {
    const checkpoints = this.board2Checkpoints();
    const next = checkpoints[this.board2Reveal];
    if (next === undefined) {
      this.showdown();
      return;
    }
    this.board2Reveal++;
    this.board2Shown = next;
    this.ctx.log(`Second board: ${this.board2.slice(0, this.board2Shown).join(' ')}`);
    this.refreshEquity();
    this.ctx.changed();
    this.ctx.setTimer('runout', TIMINGS.RUNOUT_STREET_DELAY, () => this.revealSecondBoard());
  }

  // ---- live equity ("what are my odds") ----

  // The board the table is currently watching: the second row once it has
  // started, the first one until then.
  visibleBoard() {
    if (this.runItTwice && this.board2 && this.board2Reveal > 0) {
      return this.board2.slice(0, this.board2Shown);
    }
    return this.board;
  }

  // Published equity for the hand in progress. Computed ONLY once every
  // remaining hand is already face up (an all-in run-out reveals them), so it
  // can never say anything about a card the table cannot already see.
  refreshEquity() {
    this.equityNow = null;
    if (!this.runOut || !this.revealed || this.finished) return;
    if (this.variant.engine === '747') return; // no community board to run out
    const live = this.livePlayers();
    if (live.length < 2) return;
    const board = this.visibleBoard();
    if (board.length > 5) return;
    // Running it twice, the first board's cards are gone from the deck: they
    // cannot come again on the second one. Counting them as live outs told a
    // player drawing dead that they still had a chance.
    const secondBoard = this.runItTwice && this.board2Reveal > 0;
    const dead = secondBoard ? this.board : [];
    try {
      // The odds at the moment the chips went in are already computed for the
      // cooler detector. When nothing about the board has moved since, reuse
      // that snapshot rather than paying for the same enumeration twice — a
      // multi-way all-in preflop in PLO is seconds of work, and this process
      // serves every table on the machine.
      if (!secondBoard && this.allInEquity && board.length === this.allInEquityCards) {
        this.equityNow = this.equityFrom(this.allInEquity, live, board);
        return;
      }
      const shares = equity(
        live.map((p) => ({ seat: p.seatIndex, holeCards: p.holeCards })),
        board,
        { omaha: !!this.variant.omaha, dead }
      );
      this.equityNow = this.equityFrom(shares, live, board);
    } catch {
      this.equityNow = null; // never let a readout take a hand down
    }
  }

  equityFrom(shares, live, board) {
    return {
      board: this.runItTwice && this.board2Reveal > 0 ? 2 : 1,
      cards: board.length,
      rows: live
        .map((p) => ({ seat: p.seatIndex, pct: Math.round((shares.get(p.seatIndex) ?? 0) * 1000) / 10 }))
        .sort((a, b) => b.pct - a.pct),
    };
  }

  continueStreet() {
    const live = this.livePlayers();
    if (this.runOut && !this.revealed && this.discardsDone) {
      this.revealed = true;
      for (const p of live) {
        this.ctx.log(`${p.nickname} shows ${p.holeCards.join(' ')}`);
      }
      // Cards just went face up, so the odds can be published now.
      this.refreshEquity();
    }

    const next = NEXT_STREET[this.street];
    if (next === 'showdown') {
      if (this.runOut) {
        this.ctx.changed();
        // The first board is finished. If the table agreed to run it twice,
        // the second board's run-out starts now — one board at a time.
        const second = this.runItTwice && this.board2 && this.board2Reveal === 0;
        this.ctx.setTimer('runout', TIMINGS.RUNOUT_STREET_DELAY, () =>
          second ? this.revealSecondBoard() : this.showdown());
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

  // `next` says what happens once everyone has pitched: 'bet' opens this
  // street's betting round (the normal case, since discards now come first),
  // 'proceed' skips straight on (a bomb pot, which has no preflop round).
  enterDiscard(next = 'bet') {
    this.afterDiscard = next;
    const pending = this.discardPending();
    if (pending.length === 0) {
      this.finishDiscard();
      return;
    }
    // Untimed tables still need a fallback here: the discard phase has no
    // seat to act, so nothing else can rescue a table whose player vanished.
    const ms = this.actionTime > 0 ? TIMINGS.DISCARD_TIME : TIMINGS.DISCARD_NO_CLOCK;
    this.phase = this.variant.discardBefore === 'preflop'
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
    // A bomb pot has no preflop round to open, and an all-in table has nobody
    // left to bet — both just carry on. Otherwise the betting round the
    // discard was holding up now begins.
    if (this.afterDiscard === 'proceed' || this.runOut) {
      this.proceedFromStreet();
      return;
    }
    this.beginBetting();
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
    // Nobody saw it, but they still made it. Recorded privately, on their own
    // stats row only — the table view and the saved hand stay untouched.
    this.recordMadeHand(winner);
    this.results.bounty = this.applySevenDeuce(winner);
    // The bounty turns the winning hand face up — if that reveal shows a
    // 6-2 as well, it gets its moment too. An unshown fold-win stays
    // private until the winner chooses to show (see handleShowCards).
    if (winner.showedCards) this.announceSixTwo(winner);
    this.pushEvent({ type: 'payout', seat: winner.seatIndex, amount: pot, byFold: true });
    this.ctx.log(`${winner.nickname} wins ${pot}`);
    this.ctx.changed();
    this.ctx.finished();
  }

  // Score a live player's best five against the final board and file it under
  // their private per-hand stats. A street that never reached five cards has no
  // made hand at all, so it records nothing.
  recordMadeHand(player) {
    if (!player || player.folded || !player.handStats) return;
    const cards = [...player.holeCards, ...this.board];
    if (cards.length < 5) return;
    try {
      const score = this.variant.omaha && this.board.length >= 5
        ? bestOmaha(player.holeCards, this.board)
        : bestAny(cards);
      if (score > player.handStats.madeScore) {
        player.handStats.madeScore = score;
        player.handStats.madeDesc = describe(score);
      }
    } catch {
      /* a hand this engine can't score is simply not recorded */
    }
  }

  showdown() {
    this.ctx.clearTimer();
    // Whatever the reveal got to, the finished hand shows both boards in full.
    if (this.runItTwice && this.board2) this.board2Shown = this.board2.length;
    this.equityNow = null; // the result replaces the odds
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
        if (scores.get(p.seatIndex) > p.handStats.madeScore) {
          p.handStats.madeScore = scores.get(p.seatIndex);
          p.handStats.madeDesc = describe(scores.get(p.seatIndex));
        }
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
    // Showdown cards are public, so a 6-2 scoop announces itself.
    this.announceSixTwo(outrightWinner);
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

  // The 6-2 gets glory instead of chips: whenever the whole pot goes to a
  // hand holding a six and a deuce — and those cards are face up — the
  // table hears about it. Never fires on hidden cards: a fold-win only
  // qualifies once the winner chooses to show.
  announceSixTwo(winner) {
    if (!winner || !hasSixDeuce(winner.holeCards)) return;
    if (this.results && !this.results.sixTwo) {
      this.results.sixTwo = { seat: winner.seatIndex, nickname: winner.nickname };
      this.ctx.log(`🎉 ${winner.nickname} wins with the 6-2!`);
    }
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

  // Voluntary reveal once the hand is over: a fold-winner showing the
  // bluff, or any folded player showing what they let go. Refused only
  // when the cards are already public (a showdown reveals non-folders).
  handleShowCards(player) {
    if (!this.finished) return { ok: false, error: 'the hand is not over' };
    if (this.bySeat.get(player.seatIndex) !== player) {
      return { ok: false, error: 'you were not in this hand' };
    }
    if (player.showedCards) return { ok: false, error: 'already shown' };
    if (!player.folded && !this.results?.byFold) {
      return { ok: false, error: 'your cards are already face up' };
    }
    player.showedCards = true;
    // Turning the cards over should say what they WERE. Without this the table
    // sees five cards and has to read the hand themselves, which is the one
    // moment nobody wants homework — you showed to make a point.
    const desc = this.describeShown(player);
    if (player.handResult) player.handResult.desc = player.handResult.desc || desc;
    else player.handResult = { desc, won: 0 };
    this.ctx.log(
      `${player.nickname} shows ${player.holeCards.join(' ')}${desc ? ` — ${desc}` : ''}`
    );
    // A fold-winner who shows a 6-2 earns the callout after the fact.
    if (this.results?.byFold && this.results.winners?.[0]?.seat === player.seatIndex) {
      this.announceSixTwo(player);
    }
    this.ctx.handShown?.();
    this.ctx.changed();
    return { ok: true };
  }

  // What a voluntarily shown hand actually is. The board may be short (a hand
  // that ended preflop has none at all), so a partial description is the honest
  // answer rather than no answer.
  describeShown(player) {
    try {
      if (this.variant.engine === '747') return null;
      const board = this.board || [];
      if (this.variant.omaha) {
        const { score } = bestOmaha(player.holeCards, board);
        return score >= 0 ? describe(score) : describePartial(player.holeCards);
      }
      const cards = [...player.holeCards, ...board];
      if (cards.length < 5) return describePartial(cards);
      return describe(bestAny(cards).score);
    } catch {
      return null; // a readout must never cost somebody their reveal
    }
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

function hasSixDeuce(cards) {
  const ranks = new Set(cards.map((c) => c[0]));
  return ranks.has('6') && ranks.has('2');
}
