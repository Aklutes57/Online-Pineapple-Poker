// A table: seats, players, host, lobby, hand loop, chat/log/ledger.
// Owns the single pending flow timer (action / discard / run-out / next-hand).
// The sockets layer sets game.onChanged and calls the public methods here.

import {
  GAME_STATUS, DEFAULT_SETTINGS, SEAT_COUNT, TIMINGS, SETTINGS_LIMITS, PHASES, VARIANTS,
  MAX_CHIPS, NAME_FONTS, DEFAULT_NAME_FONT, blindsForLevel,
} from '../shared/constants.js';
import { Hand } from './hand.js';
import { Hand747 } from './hand747.js';
import { payoutPots } from './pots.js';
import { recordHandStats, syncSessionResults, closeTableSession } from './stats.js';
import { saveHand, updateHandShown } from './handStore.js';
import { notifyTurn, notifySeatApproved } from './push.js';
import {
  ALGO as FAIRNESS_ALGO, newServerSeed, newClientSeed, commitOf, seededShuffle,
  handProof, floatFromHex, buildCommitment,
} from './fairness.js';
import { AVATAR_URL_RE } from './accounts.js';
import { randomUUID, randomBytes } from 'node:crypto';

function shortId() {
  return randomBytes(6).toString('base64url');
}

export class Game {
  constructor(id, settings = {}) {
    this.id = id;
    this.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...settings });
    this.status = GAME_STATUS.LOBBY;
    this.hostId = null;
    // The player who created the table. Host can pass to someone else if the
    // creator drops, but the creator reclaims it automatically when they
    // return — so a brief disconnect never permanently strips their controls.
    this.creatorId = null;
    this.hostAccountId = null;
    this.tableSessionId = null;
    this.players = new Map(); // playerId -> player
    this.byToken = new Map(); // token -> player
    this.seats = new Array(SEAT_COUNT).fill(null); // playerId | null
    this.currentHand = null;
    this.handNo = 0;
    this.buttonSeat = null;
    // 747: when the dealer beats everyone, the pot rides here between hands.
    this.carryPot = 0;
    // Tournament clock. Null until the first hand is dealt, so a table that
    // sits waiting for players doesn't burn through its blind levels.
    this.tournamentStartedAt = null;
    this.level = 0;
    this.tournamentOver = false;
    this.rebuysClosedLogged = false;
    // The blinds the ladder is measured from — captured when the clock starts,
    // so a later settings change can't retroactively rewrite the structure.
    this.startingBigBlind = null;
    this.chat = [];
    this.logs = [];
    this.ledger = new Map(); // playerId -> { nickname, buyIns, cashOuts }
    this.pendingOps = []; // ops queued while a hand is live, applied at hand end
    this.waitlist = []; // queue for a full table, drained between hands
    this.pauseRequested = false;
    this.timer = null; // { name, deadline, handle }
    this.hostTransferTimeout = null;
    this.seq = 0;
    this.lastActivity = Date.now();
    this.closed = false;
    // Provably-fair RNG. The server seed is committed up front and kept secret
    // until the table closes; the client seed is public and any seated player
    // can change it (taking effect the next hand). Persisted lazily by
    // ensureTableSession so the record survives a restart.
    const serverSeed = newServerSeed();
    this.fairness = {
      algo: FAIRNESS_ALGO,
      serverSeed,
      serverCommit: commitOf(serverSeed),
      clientSeed: newClientSeed(),
    };
    this.onChanged = null; // () => broadcast, set by sockets layer
    this.onClosed = null; // (reason) => notify + destroy, set by sockets layer
  }

  touch() {
    this.lastActivity = Date.now();
  }

  emitChanged() {
    if (this.onChanged) this.onChanged();
  }

  // ---- timers (one pending flow timer at a time) ----

  setTimer(name, ms, fn) {
    this.clearTimer();
    const deadline = Date.now() + ms;
    this.timer = {
      name,
      deadline,
      handle: setTimeout(() => {
        this.timer = null;
        try {
          fn();
        } catch (err) {
          this.recoverFromError(err);
        }
      }, ms),
    };
  }

  // Containment for engine invariant failures: never let one table's bad hand
  // crash the process. Void the hand (bets returned), pause, and let the host
  // resume.
  recoverFromError(err) {
    console.error(`game ${this.id} internal error:`, err);
    try {
      const hand = this.currentHand;
      if (hand && !hand.finished) {
        for (const p of hand.players) {
          p.stack += p.totalCommitted;
          p.totalCommitted = 0;
          p.betThisRound = 0;
        }
        // A voided 747 hand hands its riding pot back to the game.
        if (hand.carryIn > 0) {
          this.carryPot += hand.carryIn;
          hand.carryIn = 0;
        }
        hand.finished = true;
        hand.phase = PHASES.COMPLETE;
        hand.toActSeat = null;
        this.addLog('Something went wrong — the hand was voided and all bets returned');
      }
      this.clearTimer();
      this.pauseRequested = false;
      if (this.status === GAME_STATUS.RUNNING) {
        this.status = GAME_STATUS.PAUSED;
        this.addLog('Game paused — the host can resume from the Host menu');
      }
      this.applyPendingOps();
      this.emitChanged();
    } catch (recoveryErr) {
      console.error(`game ${this.id} recovery failed:`, recoveryErr);
    }
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer.handle);
      this.timer = null;
    }
  }

  // ---- players ----

  addPlayer(nickname, accountId = null) {
    const player = {
      id: shortId(),
      token: randomUUID(),
      nickname,
      accountId,
      seatIndex: null,
      stack: 0,
      status: 'spectating', // spectating | requesting | seated
      sittingOut: false,
      connected: false,
      sockets: new Set(),
      pendingBuyIn: 0,
      requestedSeat: null,
      seatedAt: null,
      avatarUrl: null,
      // Once the host has let you in, you don't queue again for a re-buy —
      // this survives standing up, so busting out and coming back is one tap.
      boughtInHere: false,
      // …unless the host removed you. `kicked` is cleared the moment the kick
      // completes, so the ban has to be recorded separately or an auto-seat
      // would walk a kicked player straight back past the host.
      bannedFromSeat: false,
      createdAt: Date.now(),
      disconnectedAt: null,
      lastChatAt: 0,
      lastReactAt: 0,
      kicked: false,
      handsPlayed: 0,
      lastHandDelta: 0,
      // per-hand fields, managed by Hand:
      holeCards: [],
      folded: false,
      allIn: false,
      betThisRound: 0,
      totalCommitted: 0,
      hasActed: false,
      hasDiscarded: false,
      showedCards: false,
      handResult: null,
    };
    this.players.set(player.id, player);
    this.byToken.set(player.token, player);
    return player;
  }

  playerByToken(token) {
    return this.byToken.get(token) || null;
  }

  nicknameTaken(nickname) {
    const lower = nickname.toLowerCase();
    return [...this.players.values()].some(
      (p) => p.nickname.toLowerCase() === lower && (p.connected || p.status !== 'spectating')
    );
  }

  // ---- seating ----

  requestSeat(player, buyIn, seatIndex = null) {
    if (player.status === 'seated') return { ok: false, error: 'already seated' };
    const { minBuyIn, maxBuyIn } = this.settings;
    if (!Number.isInteger(buyIn) || buyIn < minBuyIn || buyIn > maxBuyIn) {
      return { ok: false, error: `buy-in must be ${minBuyIn}-${maxBuyIn}` };
    }
    if (seatIndex !== null) {
      if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= SEAT_COUNT) {
        return { ok: false, error: 'bad seat' };
      }
      if (this.seats[seatIndex] !== null) return { ok: false, error: 'seat taken' };
    }
    // Checked before the full-table diversion below: a closed tournament turns
    // people away, it does not quietly park them in a queue they can never come
    // off. Nothing has been mutated yet at this point, so there is nothing to
    // unwind either.
    if (!this.rebuysOpen()) {
      return { ok: false, error: 'registration is closed — this one plays out' };
    }
    // Table full: join the queue instead of being turned away.
    if (!this.seats.includes(null)) {
      return this.joinWaitlist(player, buyIn, seatIndex);
    }
    player.status = 'requesting';
    player.pendingBuyIn = buyIn;
    player.requestedSeat = seatIndex;
    // The host approves a player once. After that — busting out, standing up,
    // buying back in — they seat themselves. Every bound above (buy-in range,
    // seat free, table not full, registration open) has already run, so this
    // path is validated exactly as the approved one is.
    if (player.id === this.hostId || this.seatsItself(player)) {
      return this.approveSeat(player.id, true);
    }
    this.addLog(`${player.nickname} wants to join with ${buyIn}`);
    return { ok: true };
  }

  // A returning player skips the queue; a first-timer and anyone the host
  // removed does not.
  seatsItself(player) {
    return !!player.boughtInHere && !player.bannedFromSeat;
  }

  cancelSeatRequest(player) {
    if (player.status !== 'requesting') return { ok: false, error: 'no pending request' };
    player.status = 'spectating';
    player.pendingBuyIn = 0;
    player.requestedSeat = null;
    return { ok: true };
  }

  approveSeat(playerId, approve) {
    const player = this.players.get(playerId);
    if (!player || player.status !== 'requesting') return { ok: false, error: 'no such request' };
    if (!approve) {
      player.status = 'spectating';
      player.pendingBuyIn = 0;
      player.requestedSeat = null;
      this.addLog(`${player.nickname}'s seat request was declined`);
      return { ok: true };
    }
    let seat = player.requestedSeat;
    if (seat === null || this.seats[seat] !== null) {
      seat = this.seats.indexOf(null);
      if (seat === -1) return { ok: false, error: 'table is full' };
    }
    this.seats[seat] = player.id;
    player.seatIndex = seat;
    player.status = 'seated';
    player.stack = player.pendingBuyIn;
    player.seatedAt = Date.now();
    player.sittingOut = false;
    // The single choke point every legitimate seating funnels through: host
    // approval, the host self-seat, and the waitlist drain all land here.
    player.boughtInHere = true;
    this.creditLedger(player, player.pendingBuyIn);
    this.addLog(`${player.nickname} takes seat ${seat + 1} with ${player.stack}`);
    player.pendingBuyIn = 0;
    player.requestedSeat = null;
    // An absent requester gets a push; the connected (including the host
    // self-seat path) see it live.
    if (!player.connected) notifySeatApproved(this, player);
    this.maybeStartHand();
    return { ok: true };
  }

  // Voluntary leave or host kick. Mid-hand: queue removal, auto-fold soon via away.
  removeFromSeat(player, reason) {
    if (player.status !== 'seated') return { ok: false, error: 'not seated' };
    if (this.playerInLiveHand(player)) {
      player.sittingOut = true;
      player.kicked = true;
      this.queueOp({ type: 'unseat', playerId: player.id, reason });
      this.addLog(`${player.nickname} will leave after this hand`);
      this.nudgeCurrentTurn(player);
      return { ok: true, queued: true };
    }
    this.unseatNow(player, reason);
    return { ok: true };
  }

  // If this player is the one to act in a live betting round, re-arm the turn
  // timer so an away/kicked/disconnected player can't freeze the table (with
  // actionTime=0 there is otherwise no pending timer at all).
  nudgeCurrentTurn(player) {
    const hand = this.currentHand;
    if (
      hand &&
      !hand.finished &&
      hand.isBettingPhase() &&
      hand.toActSeat === player.seatIndex &&
      this.playerInLiveHand(player)
    ) {
      hand.beginTurn();
    }
  }

  unseatNow(player, reason) {
    if (player.seatIndex !== null) this.seats[player.seatIndex] = null;
    this.cashOutLedger(player, player.stack);
    this.addLog(
      reason === 'kick'
        ? `${player.nickname} was removed from the table (${player.stack} cashed out)`
        : `${player.nickname} leaves the table (${player.stack} cashed out)`
    );
    player.stack = 0;
    player.seatIndex = null;
    player.status = 'spectating';
    player.sittingOut = false;
    // Remember the kick before the transient flag is cleared — otherwise a
    // removed player would look exactly like a voluntary leaver and re-seat
    // themselves without the host.
    if (reason === 'kick') player.bannedFromSeat = true;
    player.kicked = false;
  }

  sitOut(player) {
    if (player.status !== 'seated') return { ok: false, error: 'not seated' };
    player.sittingOut = true;
    this.addLog(`${player.nickname} is away`);
    this.nudgeCurrentTurn(player);
    return { ok: true };
  }

  sitIn(player) {
    if (player.status !== 'seated') return { ok: false, error: 'not seated' };
    if (player.stack <= 0) return { ok: false, error: 'no chips — ask the host for a top-up' };
    player.sittingOut = false;
    this.addLog(`${player.nickname} is back`);
    this.maybeStartHand();
    return { ok: true };
  }

  // Each player chooses the face their own name is set in. Validated against
  // the shared list so a client can't inject arbitrary CSS through it.
  setNameFont(player, key) {
    if (!player || !this.players.has(player.id)) return { ok: false, error: 'not at this table' };
    if (!Object.prototype.hasOwnProperty.call(NAME_FONTS, key)) {
      return { ok: false, error: 'unknown font' };
    }
    player.nameFont = key;
    return { ok: true };
  }

  // Any player at the table can change the felt picture — it is a shared table,
  // not the host's alone. Applies immediately for everyone.
  // A player's profile picture: shown in their seat pod whenever their webcam
  // isn't. Guests get one too — it lives on the in-memory player, and the
  // client re-asserts it on every reconnect from its own device storage.
  setAvatar(player, url) {
    if (!player || !this.players.has(player.id)) return { ok: false, error: 'not at this table' };
    if (url === null || url === '') {
      player.avatarUrl = null;
      this.emitChanged();
      return { ok: true };
    }
    if (typeof url !== 'string' || !AVATAR_URL_RE.test(url)) {
      return { ok: false, error: 'bad picture' };
    }
    if (player.avatarUrl === url) return { ok: true };
    player.avatarUrl = url;
    this.emitChanged();
    return { ok: true };
  }

  setTableImage(player, url) {
    if (!player || !this.players.has(player.id)) return { ok: false, error: 'not at this table' };
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) {
      return { ok: false, error: 'bad image' };
    }
    this.settings.tableTheme = { ...(this.settings.tableTheme || {}), feltImage: url };
    this.addLog(`${player.nickname} changed the table picture`);
    this.emitChanged();
    return { ok: true };
  }

  // A busted player topping themselves back up, without needing the host.
  // Same buy-in limits as taking a seat, and it lands as a fresh buy-in on the
  // ledger so the books still balance.
  rebuy(player, amount) {
    if (player.status !== 'seated') return { ok: false, error: 'not seated' };
    if (!this.rebuysOpen()) {
      return { ok: false, error: 'the re-buy period is over — this one plays out' };
    }
    const { minBuyIn, maxBuyIn } = this.settings;
    const want = Number.isInteger(amount) ? amount : this.settings.defaultBuyIn;
    if (!Number.isInteger(want) || want < minBuyIn || want > maxBuyIn) {
      return { ok: false, error: `re-buy must be ${minBuyIn}-${maxBuyIn}` };
    }
    if (player.stack + want > maxBuyIn) {
      return { ok: false, error: `a stack can't go past ${maxBuyIn}` };
    }
    if (this.playerInLiveHand(player)) {
      this.queueOp({ type: 'adjustStack', playerId: player.id, delta: want });
      this.addLog(`${player.nickname} re-buys ${want} — lands after this hand`);
      return { ok: true, queued: true };
    }
    this.applyStackAdjust(player, want);
    this.addLog(`${player.nickname} re-buys ${want}`);
    if (player.stack > 0 && !player.kicked) player.sittingOut = false;
    this.maybeStartHand();
    return { ok: true };
  }

  adjustStack(playerId, delta) {
    const player = this.players.get(playerId);
    if (!player || player.status !== 'seated') return { ok: false, error: 'not seated' };
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_CHIPS) {
      return { ok: false, error: 'bad amount' };
    }
    if (this.playerInLiveHand(player)) {
      this.queueOp({ type: 'adjustStack', playerId, delta });
      this.addLog(`Stack change for ${player.nickname} queued for next hand`);
      return { ok: true, queued: true };
    }
    this.applyStackAdjust(player, delta);
    this.maybeStartHand();
    return { ok: true };
  }

  applyStackAdjust(player, delta) {
    // Bounded below by the stack (can't go negative) and above by MAX_CHIPS
    // (keeps every sum the ledger ever does in exact integers). A stack that
    // grew past MAX_CHIPS by winning pots must never make a top-up turn into
    // a reduction — a positive delta can only ever add or do nothing.
    const applied = delta > 0
      ? Math.min(delta, Math.max(0, MAX_CHIPS - player.stack))
      : Math.max(delta, -player.stack);
    if (applied === 0) return;
    player.stack += applied;
    if (applied > 0) this.creditLedger(player, applied);
    else this.cashOutLedger(player, -applied);
    this.addLog(
      applied > 0
        ? `${player.nickname} gets a ${applied} top-up`
        : `${player.nickname}'s stack reduced by ${-applied}`
    );
    if (player.stack > 0 && player.sittingOut && !player.kicked) {
      // Broke players are auto-away; a top-up brings them back next hand.
      player.sittingOut = false;
    }
  }

  // Drop spectators who disconnected long ago and never bought in, so a
  // long-lived table's player map can't grow without bound.
  pruneStalePlayers(maxIdleMs = 10 * 60 * 1000) {
    const now = Date.now();
    for (const [id, p] of this.players) {
      if (
        id !== this.hostId &&
        p.status === 'spectating' &&
        !p.connected &&
        !this.ledger.has(id) &&
        p.disconnectedAt &&
        now - p.disconnectedAt > maxIdleMs
      ) {
        this.players.delete(id);
        this.byToken.delete(p.token);
      }
    }
  }

  // ---- ledger ----

  creditLedger(player, amount) {
    const row = this.ledger.get(player.id) || { nickname: player.nickname, buyIns: 0, cashOuts: 0 };
    row.buyIns += amount;
    this.ledger.set(player.id, row);
  }

  cashOutLedger(player, amount) {
    const row = this.ledger.get(player.id) || { nickname: player.nickname, buyIns: 0, cashOuts: 0 };
    row.cashOuts += amount;
    this.ledger.set(player.id, row);
  }

  ledgerRows() {
    return [...this.ledger.entries()].map(([playerId, row]) => {
      const player = this.players.get(playerId);
      const stack = player && player.status === 'seated'
        ? player.stack + (player.totalCommitted || 0)
        : 0;
      return {
        playerId,
        nickname: row.nickname,
        buyIns: row.buyIns,
        cashOuts: row.cashOuts,
        stack,
        net: row.cashOuts + stack - row.buyIns,
        lastHandDelta: player?.lastHandDelta || 0,
        handsPlayed: player?.handsPlayed || 0,
        seated: player?.status === 'seated',
        payments: player?.payments || null,
      };
    });
  }

  // ---- chat & log ----

  addChat(player, text) {
    const now = Date.now();
    if (now - player.lastChatAt < 500) return { ok: false, error: 'slow down' };
    if (typeof text !== 'string') return { ok: false, error: 'bad message' };
    const trimmed = text.trim().slice(0, SETTINGS_LIMITS.chatLength);
    if (!trimmed) return { ok: false, error: 'empty message' };
    player.lastChatAt = now;
    const msg = { from: player.nickname, text: trimmed, ts: now };
    this.chat.push(msg);
    if (this.chat.length > 100) this.chat.shift();
    return { ok: true, msg };
  }

  addLog(text) {
    const entry = { handNo: this.handNo, ts: Date.now(), text };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    return entry;
  }

  // ---- hand loop ----

  eligiblePlayers() {
    return this.seats
      .map((id) => (id ? this.players.get(id) : null))
      .filter((p) => p && p.status === 'seated' && p.stack > 0 && !p.sittingOut);
  }

  // Everyone still holding chips, awake or not. eligiblePlayers() answers "who
  // is in the next hand"; this answers "who is still in the tournament".
  seatedPlayersWithChips() {
    return this.seats
      .map((id) => (id ? this.players.get(id) : null))
      .filter((p) => p && p.status === 'seated' && p.stack > 0);
  }

  playerInLiveHand(player) {
    return !!(
      this.currentHand &&
      !this.currentHand.finished &&
      player.seatIndex !== null &&
      this.currentHand.bySeat.has(player.seatIndex) &&
      this.currentHand.bySeat.get(player.seatIndex) === player
    );
  }

  startGame(hostPlayer) {
    if (this.status !== GAME_STATUS.LOBBY) return { ok: false, error: 'already started' };
    if (this.eligiblePlayers().length < 2) return { ok: false, error: 'need at least 2 players with chips' };
    this.status = GAME_STATUS.RUNNING;
    this.addLog(`${hostPlayer.nickname} starts the game`);
    this.startHand();
    return { ok: true };
  }

  setPaused(paused) {
    if (paused) {
      if (this.status !== GAME_STATUS.RUNNING) return { ok: false, error: 'not running' };
      if (this.currentHand && !this.currentHand.finished) {
        this.pauseRequested = true;
        this.addLog('Game will pause after this hand');
      } else {
        this.status = GAME_STATUS.PAUSED;
        this.clearTimer();
        this.addLog('Game paused');
      }
      return { ok: true };
    }
    if (this.status !== GAME_STATUS.PAUSED && !this.pauseRequested) {
      return { ok: false, error: 'not paused' };
    }
    this.pauseRequested = false;
    if (this.status === GAME_STATUS.PAUSED) {
      this.status = GAME_STATUS.RUNNING;
      this.addLog('Game resumed');
      this.maybeStartHand();
    }
    return { ok: true };
  }

  updateSettings(patch) {
    const next = { ...this.settings };
    if (patch.smallBlind !== undefined) next.smallBlind = patch.smallBlind;
    if (patch.bigBlind !== undefined) next.bigBlind = patch.bigBlind;
    if (patch.actionTime !== undefined) next.actionTime = patch.actionTime;
    if (patch.minBuyIn !== undefined) next.minBuyIn = patch.minBuyIn;
    if (patch.maxBuyIn !== undefined) next.maxBuyIn = patch.maxBuyIn;
    if (patch.defaultBuyIn !== undefined) next.defaultBuyIn = patch.defaultBuyIn;
    if (patch.tableTheme !== undefined) next.tableTheme = patch.tableTheme;
    for (const key of ['timeBank', 'straddle', 'rabbitHunt', 'runItTwice', 'bombPotEvery',
      'sevenDeuceBounty', 'ante747', 'penaltyCap747',
      'tournament', 'levelMinutes', 'rebuyMinutes']) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    // The game can change mid-session; an unknown variant keeps the current
    // one rather than falling back to sanitizeSettings' default. Each Hand
    // snapshots its variant at start, so a live hand always finishes under
    // the rules it was dealt with.
    const variantChanged =
      typeof patch.variant === 'string' &&
      VARIANTS[patch.variant] !== undefined &&
      patch.variant !== this.settings.variant;
    next.variant = variantChanged ? patch.variant : this.settings.variant;
    const clean = sanitizeSettings(next);
    this.settings = clean;
    this.addLog(
      `Settings updated: blinds ${clean.smallBlind}/${clean.bigBlind}, ` +
      `timer ${clean.actionTime ? clean.actionTime + 's' : 'off'}`
    );
    if (variantChanged) {
      const inHand = this.currentHand && !this.currentHand.finished;
      this.addLog(
        `Game changes to ${VARIANTS[clean.variant].label}${inHand ? ' after this hand' : ' next hand'}`
      );
      // A pot can only ride between 747 hands; switching away cashes it out.
      if (VARIANTS[clean.variant].engine !== '747' && !inHand) {
        this.liquidateCarryPot('game change');
      } else if (VARIANTS[clean.variant].engine !== '747') {
        this.queueOp({ type: 'liquidateCarry' });
      }
    }
    return { ok: true };
  }

  queueOp(op) {
    this.pendingOps.push(op);
  }

  applyPendingOps() {
    const ops = this.pendingOps;
    this.pendingOps = [];
    for (const op of ops) {
      const player = this.players.get(op.playerId);
      if (!player) continue;
      if (op.type === 'unseat' && player.status === 'seated') {
        this.unseatNow(player, op.reason);
      } else if (op.type === 'adjustStack' && player.status === 'seated') {
        this.applyStackAdjust(player, op.delta);
      } else if (op.type === 'liquidateCarry') {
        if (VARIANTS[this.settings.variant].engine !== '747') {
          this.liquidateCarryPot('game change');
        }
      }
    }
    // After unseats have freed any seats, pull people off the queue.
    this.seatFromWaitlist();
  }

  nextButtonSeat() {
    const eligible = this.eligiblePlayers().map((p) => p.seatIndex).sort((a, b) => a - b);
    if (this.buttonSeat === null) return eligible[0];
    for (let i = 1; i <= SEAT_COUNT; i++) {
      const seat = (this.buttonSeat + i) % SEAT_COUNT;
      if (eligible.includes(seat)) return seat;
    }
    return eligible[0];
  }

  // ---- tournament clock ----

  isTournament() {
    return !!this.settings.tournament;
  }

  // Which blind level the clock is on right now. Levels only ever advance
  // between hands: a hand always finishes on the blinds it was dealt with.
  levelNow() {
    if (!this.isTournament() || !this.tournamentStartedAt) return 0;
    const minutes = this.settings.levelMinutes;
    if (minutes <= 0) return 0;
    return Math.floor((Date.now() - this.tournamentStartedAt) / (minutes * 60_000));
  }

  // Re-buys close once the re-buy period is up. 0 minutes means a freezeout:
  // one bullet, from the very first hand.
  rebuysOpen() {
    if (!this.isTournament()) return true;
    // Before the first hand nothing has started, so registration is open —
    // including for a freezeout, where the window shuts the moment cards fly.
    if (!this.tournamentStartedAt) return true;
    return Date.now() - this.tournamentStartedAt < this.settings.rebuyMinutes * 60_000;
  }

  // Milliseconds until the blinds go up; null when there is no clock running.
  msToNextLevel() {
    if (!this.isTournament() || !this.tournamentStartedAt) return null;
    const each = this.settings.levelMinutes * 60_000;
    if (each <= 0) return null;
    const elapsed = Date.now() - this.tournamentStartedAt;
    return each - (elapsed % each);
  }

  // Called between hands only. Starts the clock on the first hand, then raises
  // the blinds whenever the level has ticked over.
  advanceTournamentClock() {
    if (!this.isTournament()) return;
    if (!this.tournamentStartedAt) {
      this.tournamentStartedAt = Date.now();
      this.startingBigBlind = this.settings.bigBlind;
      this.level = 0;
      this.addLog(
        `Tournament clock started — level 1, blinds ${this.settings.smallBlind}/${this.settings.bigBlind}, ` +
        `${this.settings.levelMinutes} minutes a level`
      );
      return;
    }
    const now = this.levelNow();
    if (now === this.level) return;
    this.level = now;
    const { smallBlind, bigBlind } = blindsForLevel(this.startingBigBlind, now);
    this.settings = { ...this.settings, smallBlind, bigBlind };
    this.addLog(`Level ${now + 1} — blinds up to ${smallBlind}/${bigBlind}`);
    if (!this.rebuysOpen() && !this.rebuysClosedLogged) {
      this.rebuysClosedLogged = true;
      this.addLog('Re-buy period is over — from here it plays out to one winner');
    }
  }

  // The end of a tournament: nobody else can buy in, so the last player with
  // chips has won it. The table pauses rather than closing, so the ledger and
  // the hand history stay right there to look at.
  declareTournamentWinner(winner) {
    if (this.tournamentOver) return;
    this.tournamentOver = true;
    this.status = GAME_STATUS.PAUSED;
    this.clearTimer();
    this.addLog(
      winner
        ? `${winner.nickname} wins the tournament with ${winner.stack} chips`
        : 'The tournament is over'
    );
    this.emitChanged();
  }

  startHand() {
    if (this.status !== GAME_STATUS.RUNNING || this.closed) return;
    if (this.currentHand && !this.currentHand.finished) return;
    this.advanceTournamentClock();
    const s = this.settings;
    const is747 = VARIANTS[s.variant]?.engine === '747';

    let players = this.eligiblePlayers();
    // 747: you must cover the ante to be dealt in, and the deck fits at
    // most 9 players plus the dealer — the overflow seat is skipped this
    // hand and picked up as the button moves.
    const ante747 = s.ante747 > 0 ? s.ante747 : s.bigBlind;
    if (is747) {
      players = players.filter((p) => p.stack >= ante747);
    }
    if (players.length < 2) {
      this.currentHand = null;
      // A tournament past its re-buy window can't refill, so one player left
      // with chips is the finish. Measured on chips, never on who happens to be
      // dealt in — two people stepping away must not end the tournament for the
      // rest of the table.
      if (this.isTournament() && !this.rebuysOpen() && this.tournamentStartedAt) {
        const withChips = this.seatedPlayersWithChips();
        if (withChips.length < 2) {
          this.declareTournamentWinner(withChips[0] ?? null);
          return;
        }
      }
      this.addLog(
        is747
          ? 'Waiting for at least 2 players who can cover the ante…'
          : 'Waiting for at least 2 players with chips…'
      );
      this.emitChanged();
      return;
    }
    this.buttonSeat = this.nextButtonSeat();
    this.handNo++;
    for (const p of players) {
      p.timeBank = s.timeBank > 0 ? s.timeBank * 1000 : 0;
    }

    if (is747) {
      if (players.length > 9) {
        players.sort((a, b) => a.seatIndex - b.seatIndex);
        const ordered = [];
        let seat = this.buttonSeat;
        for (let i = 0; i < SEAT_COUNT && ordered.length < 9; i++) {
          seat = (seat + 1) % SEAT_COUNT;
          const p = players.find((x) => x.seatIndex === seat);
          if (p) ordered.push(p);
        }
        const skipped = players.find((p) => !ordered.includes(p));
        if (skipped) this.addLog(`${skipped.nickname} sits this 747 hand out (nine-player deal)`);
        players = ordered;
      }
      const carryIn = this.carryPot;
      this.carryPot = 0;
      const fair747 = this.fairnessForHand();
      this.currentHand = new Hand747({
        handNo: this.handNo,
        smallBlind: s.smallBlind,
        bigBlind: s.bigBlind,
        actionTime: s.actionTime,
        ante: ante747,
        penaltyCap: s.penaltyCap747,
        buttonSeat: this.buttonSeat,
        players: players.sort((a, b) => a.seatIndex - b.seatIndex),
        carryIn,
        deck: fair747.deck,
        fairness: fair747.meta,
        ctx: this.handCtx(),
      });
      this.currentHand.fairnessSeed = fair747.serverSeed;
      this.currentHand.start();
      this.emitChanged();
      return;
    }

    // Top the time bank back up each hand so it is a per-decision reserve
    // rather than a per-session one.
    const bombPot = s.bombPotEvery > 0 && this.handNo % s.bombPotEvery === 0;
    const fair = this.fairnessForHand();
    this.currentHand = new Hand({
      handNo: this.handNo,
      variantKey: s.variant,
      smallBlind: s.smallBlind,
      bigBlind: s.bigBlind,
      actionTime: s.actionTime,
      buttonSeat: this.buttonSeat,
      players: players.sort((a, b) => a.seatIndex - b.seatIndex),
      deck: fair.deck,
      fairness: fair.meta,
      options: {
        straddle: s.straddle,
        rabbitHunt: s.rabbitHunt,
        runItTwice: s.runItTwice,
        sevenDeuceBounty: s.sevenDeuceBounty,
        bombPot,
        ante: bombPot ? s.bigBlind : 0,
      },
      ctx: this.handCtx(),
    });
    this.currentHand.fairnessSeed = fair.serverSeed;
    this.currentHand.start();
    this.emitChanged();
  }

  // Builds the deck and the public per-hand fairness proof for the hand about
  // to start. The server seed never leaves this object — only the commitment
  // (already public), the client seed, the nonce, and hashes of them do.
  fairnessForHand() {
    const nonce = this.handNo;
    const { clientSeed, algo } = this.fairness;
    // Every hand is dealt from its own fresh randomness: 32 new bytes straight
    // from the OS random source, per deal. Nothing about one hand's shuffle can
    // be derived from another's, and no stored seed decides the night's cards.
    // The seed still anchors the integrity proof for THIS hand — it is
    // committed before the deal and never leaves the server.
    const serverSeed = newServerSeed();
    const deck = seededShuffle(serverSeed, clientSeed, nonce);
    const proof = handProof(serverSeed, clientSeed, nonce);
    // deckCommit locks all 52 positions the instant the hand starts, so the
    // server cannot change a card after seeing the action. It reveals nothing.
    const { deckCommit } = buildCommitment(serverSeed, nonce, deck);
    return {
      deck,
      serverSeed,
      meta: {
        algo, commit: commitOf(serverSeed), clientSeed, nonce,
        proof, float: floatFromHex(proof), deckCommit,
      },
    };
  }

  // Any seated player can steer the client seed; the change is public and takes
  // effect on the next hand (never mid-hand, so it can't be used to peek).
  setClientSeed(player, raw) {
    if (!player || player.status !== 'seated') return { ok: false, error: 'Take a seat to set the client seed' };
    if (typeof raw !== 'string') return { ok: false, error: 'bad client seed' };
    const seed = raw.trim().slice(0, 64).replace(/[^\x20-\x7E]/g, '');
    if (seed.length < 1) return { ok: false, error: 'Client seed cannot be empty' };
    if (seed === this.fairness.clientSeed) return { ok: true };
    this.fairness.clientSeed = seed;
    this.addLog(`${player.nickname} set the table's client seed to "${seed}" (applies next hand)`);
    return { ok: true };
  }

  // The single contract both hand engines run against.
  handCtx() {
    return {
      log: (text) => this.addLog(text),
      changed: () => this.emitChanged(),
      finished: () => this.onHandFinished(),
      setTimer: (name, ms, fn) => this.setTimer(name, ms, fn),
      clearTimer: () => this.clearTimer(),
      markAway: (player) => {
        player.sittingOut = true;
      },
      notifyTurn: (player) => notifyTurn(this, player),
      // 747: a swept pot rides at game level. Must land in carryPot BEFORE
      // the finished-hand broadcast, or the books look short for one frame.
      carryOut: (amount) => {
        this.carryPot += amount;
      },
      // Someone turned their hand face up after it ended. The row was written
      // the instant the hand finished, so the replay and its integrity proof
      // have to be brought back in step.
      handShown: () => this.onHandShown(),
    };
  }

  onHandShown() {
    const hand = this.currentHand;
    if (!hand || !this.lastHandRecordId) return;
    // Persistence must never take a table down.
    try {
      updateHandShown(this.lastHandRecordId, hand);
    } catch (err) {
      console.error(`show update failed for game ${this.id}:`, err.message);
    }
  }

  // 747: split a riding pot evenly among seated players when it can no
  // longer ride (game switched away, or the table is closing). Chips must
  // always land back in stacks — they can never evaporate.
  liquidateCarryPot(reason) {
    if (this.carryPot <= 0) return;
    const seats = this.seats
      .map((id, i) => (id && this.players.get(id)?.status === 'seated' ? i : null))
      .filter((i) => i !== null);
    if (seats.length === 0) return; // stays parked until someone is seated
    const amount = this.carryPot;
    this.carryPot = 0;
    const flat = new Map(seats.map((s) => [s, 1]));
    const { winnings } = payoutPots(
      [{ amount, eligibleSeats: seats }], flat, this.buttonSeat ?? seats[0]
    );
    for (const [seat, share] of winnings) {
      this.players.get(this.seats[seat]).stack += share;
    }
    this.addLog(`The riding 747 pot (${amount}) was split among seated players (${reason})`);
  }

  onHandFinished() {
    const hand = this.currentHand;
    if (hand) {
      for (const player of hand.players) {
        player.handsPlayed = (player.handsPlayed || 0) + 1;
        player.lastHandDelta = player.stack - (player.handStartStack ?? player.stack);
      }
      // Persistence must never take a table down.
      try {
        recordHandStats(this, hand);
        syncSessionResults(this);
        this.lastHandRecordId = saveHand(this, hand);
      } catch (err) {
        console.error(`stats write failed for game ${this.id}:`, err.message);
      }
    }

    for (const id of this.seats) {
      if (!id) continue;
      const player = this.players.get(id);
      if (player && player.stack === 0 && !player.sittingOut) {
        player.sittingOut = true;
        this.addLog(`${player.nickname} is out of chips and sitting out`);
      }
    }
    this.applyPendingOps();
    if (this.pauseRequested) {
      this.pauseRequested = false;
      this.status = GAME_STATUS.PAUSED;
      this.addLog('Game paused');
      this.emitChanged();
      return;
    }
    this.setTimer('nexthand', TIMINGS.NEXT_HAND_DELAY, () => this.startHand());
  }

  // Kick the hand loop after seating/top-up/sit-in changes when the table is idle.
  maybeStartHand() {
    if (this.status !== GAME_STATUS.RUNNING) return;
    if (this.currentHand && !this.currentHand.finished) return;
    if (this.timer?.name === 'nexthand') return;
    if (this.eligiblePlayers().length < 2) return;
    this.setTimer('nexthand', TIMINGS.NEXT_HAND_DELAY, () => this.startHand());
  }

  // Host prod for a stalling player. Reuses the timeout path, which already
  // does the correct auto-check-or-fold, but without marking them away —
  // nudging someone who is present shouldn't punish them.
  nudgePlayer(targetId, immediate = false) {
    const target = this.players.get(targetId);
    const hand = this.currentHand;
    if (!target || !hand || hand.finished || hand.toActSeat !== target.seatIndex) {
      return { ok: false, error: 'it is not their turn' };
    }
    if (immediate) {
      this.addLog(`The host forced an action for ${target.nickname}`);
      hand.handleTimeout({ markAway: false });
      return { ok: true };
    }
    this.addLog(`The host nudged ${target.nickname} — ${TIMINGS.NUDGE_GRACE / 1000}s to act`);
    this.setTimer('nudge', TIMINGS.NUDGE_GRACE, () => hand.handleTimeout({ markAway: false }));
    this.emitChanged();
    return { ok: true };
  }

  // ---- waitlist ----

  joinWaitlist(player, buyIn, seatIndex) {
    const { minBuyIn, maxBuyIn } = this.settings;
    // Validated here as well as in requestSeat: skipping it would let an
    // invalid buy-in in through the queue when a seat later frees up.
    if (!Number.isInteger(buyIn) || buyIn < minBuyIn || buyIn > maxBuyIn) {
      return { ok: false, error: `buy-in must be ${minBuyIn}-${maxBuyIn}` };
    }
    if (this.waitlist.some((e) => e.playerId === player.id)) {
      return { ok: false, error: 'you are already in the queue' };
    }
    player.status = 'waitlisted';
    player.pendingBuyIn = buyIn;
    this.waitlist.push({
      playerId: player.id, buyIn, seatIndex: seatIndex ?? null,
      // Same rule as requestSeat: a returning player doesn't wait on the host
      // just because the table happened to be full when they came back.
      approved: this.seatsItself(player),
    });
    this.addLog(`${player.nickname} joined the waitlist`);
    return { ok: true };
  }

  leaveWaitlist(player) {
    this.waitlist = this.waitlist.filter((e) => e.playerId !== player.id);
    if (player.status === 'waitlisted') {
      player.status = 'spectating';
      player.pendingBuyIn = 0;
    }
    return { ok: true };
  }

  approveWaitlist(playerId, approve) {
    const entry = this.waitlist.find((e) => e.playerId === playerId);
    if (!entry) return { ok: false, error: 'not in the queue' };
    if (!approve) {
      const player = this.players.get(playerId);
      if (player) this.leaveWaitlist(player);
      return { ok: true };
    }
    entry.approved = true;
    this.seatFromWaitlist();
    return { ok: true };
  }

  // Only ever runs between hands: seating someone mid-hand would desync the
  // seat map from the hand's own player list.
  seatFromWaitlist() {
    if (this.currentHand && !this.currentHand.finished) return;
    // Someone who queued while registration was open must not be seated with a
    // fresh full stack after it shut — that is a new entrant, not a returning
    // one, and the field has been playing without them.
    if (!this.rebuysOpen()) {
      if (this.waitlist.length) {
        this.addLog('Registration is closed — the seat queue is done for this one');
        this.waitlist = [];
      }
      return;
    }
    const { minBuyIn, maxBuyIn } = this.settings;
    for (let i = 0; i < this.waitlist.length && this.seats.includes(null); ) {
      const entry = this.waitlist[i];
      const player = this.players.get(entry.playerId);
      if (!player || player.status === 'seated' || !player.connected) {
        this.waitlist.splice(i, 1);
        continue;
      }
      if (!entry.approved) {
        i++;
        continue;
      }
      if (entry.buyIn < minBuyIn || entry.buyIn > maxBuyIn) {
        this.waitlist.splice(i, 1);
        continue;
      }
      player.status = 'requesting';
      player.pendingBuyIn = entry.buyIn;
      player.requestedSeat =
        entry.seatIndex !== null && this.seats[entry.seatIndex] === null ? entry.seatIndex : null;
      if (this.approveSeat(player.id, true).ok) this.waitlist.splice(i, 1);
      else i++;
    }
  }

  // ---- host ----

  isHost(player) {
    return player.id === this.hostId;
  }

  // Called when a player (re)connects. If the table's creator is back and host
  // had passed to someone else while they were gone, hand it straight back.
  // Returns true if host actually changed, so the caller can rebroadcast.
  reclaimHostIfCreator(player) {
    if (!player || player.id !== this.creatorId || this.hostId === player.id) return false;
    if (!player.connected) return false;
    this.hostId = player.id;
    clearTimeout(this.hostTransferTimeout);
    this.addLog(`${player.nickname} is back and is the host again`);
    return true;
  }

  noteDisconnect(player) {
    player.disconnectedAt = Date.now();
    if (player.id === this.hostId) {
      this.armHostTransferCheck(TIMINGS.HOST_TRANSFER_AFTER);
    }
    this.nudgeCurrentTurn(player);
  }

  armHostTransferCheck(ms) {
    clearTimeout(this.hostTransferTimeout);
    this.hostTransferTimeout = setTimeout(() => this.maybeTransferHost(), ms);
    this.hostTransferTimeout.unref?.();
  }

  maybeTransferHost() {
    if (this.closed) return;
    const host = this.players.get(this.hostId);
    if (host?.connected) return;
    // Prefer seated players (earliest seated first); fall back to any
    // connected player so a hostless lobby can still be managed.
    const candidates = [...this.players.values()]
      .filter((p) => p.connected)
      .sort((a, b) => {
        const aSeated = a.status === 'seated' ? 0 : 1;
        const bSeated = b.status === 'seated' ? 0 : 1;
        return aSeated - bSeated || (a.createdAt || 0) - (b.createdAt || 0);
      });
    if (candidates.length === 0) {
      // Nobody here to take over — check again in case someone shows up.
      this.armHostTransferCheck(60000);
      return;
    }
    this.hostId = candidates[0].id;
    this.addLog(`${candidates[0].nickname} is now the host`);
    this.emitChanged();
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.status = GAME_STATUS.CLOSED;
    this.clearTimer();
    // A riding 747 pot can't outlive the table — hand it back before the
    // session ledger is finalized.
    this.liquidateCarryPot('table closed');
    clearTimeout(this.hostTransferTimeout);
    try {
      if (this.tableSessionId || this.handNo > 0) closeTableSession(this);
    } catch (err) {
      console.error(`closing table session for ${this.id} failed:`, err.message);
    }
    if (this.onClosed) this.onClosed(reason);
  }
}

export function sanitizeSettings(s) {
  const clamp = (v, min, max, dflt) => {
    const n = Number.isInteger(v) ? v : dflt;
    return Math.max(min, Math.min(max, n));
  };
  // Blinds and buy-ins are uncapped by design — MAX_CHIPS only keeps chip
  // arithmetic in exact integers (see shared/constants.js).
  const smallBlind = clamp(s.smallBlind, 1, MAX_CHIPS, DEFAULT_SETTINGS.smallBlind);
  const bigBlind = clamp(s.bigBlind, smallBlind, MAX_CHIPS, Math.max(smallBlind, DEFAULT_SETTINGS.bigBlind));
  const minBuyIn = clamp(s.minBuyIn, 1, MAX_CHIPS, Math.min(bigBlind * 20, MAX_CHIPS));
  const maxBuyIn = clamp(s.maxBuyIn, minBuyIn, MAX_CHIPS, Math.max(minBuyIn, Math.min(bigBlind * 500, MAX_CHIPS)));
  const defaultBuyIn = clamp(s.defaultBuyIn, minBuyIn, maxBuyIn, Math.min(Math.max(bigBlind * 100, minBuyIn), maxBuyIn));
  const actionTime = SETTINGS_LIMITS.actionTimes.includes(s.actionTime)
    ? s.actionTime
    : DEFAULT_SETTINGS.actionTime;
  const variant = VARIANTS[s.variant] ? s.variant : DEFAULT_SETTINGS.variant;
  const bounded = (v, min, max, dflt) =>
    Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : dflt;
  return {
    variant, smallBlind, bigBlind, minBuyIn, maxBuyIn, defaultBuyIn, actionTime,
    tableTheme: cleanTheme(s.tableTheme),
    timeBank: bounded(s.timeBank, 0, 300, 0),
    straddle: !!s.straddle,
    rabbitHunt: !!s.rabbitHunt,
    runItTwice: !!s.runItTwice,
    bombPotEvery: bounded(s.bombPotEvery, 0, 100, 0),
    sevenDeuceBounty: bounded(s.sevenDeuceBounty, 0, MAX_CHIPS, 0),
    ante747: bounded(s.ante747, 0, MAX_CHIPS, DEFAULT_SETTINGS.ante747),
    penaltyCap747: bounded(s.penaltyCap747, 0, MAX_CHIPS, DEFAULT_SETTINGS.penaltyCap747),
    tournament: !!s.tournament,
    levelMinutes: bounded(s.levelMinutes, 1, 240, DEFAULT_SETTINGS.levelMinutes),
    rebuyMinutes: bounded(s.rebuyMinutes, 0, 1440, DEFAULT_SETTINGS.rebuyMinutes),
  };
}

// Only ever accept an uploads-relative image path and #rrggbb colours, so a
// crafted settings payload can't inject a URL or CSS into every client.
function cleanTheme(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return null;
  const colour = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
  const feltImage =
    typeof theme.feltImage === 'string' && /^\/uploads\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/.test(theme.feltImage)
      ? theme.feltImage
      : null;
  const feltColor = colour(theme.feltColor);
  const railColor = colour(theme.railColor);
  if (!feltImage && !feltColor && !railColor) return null;
  return { feltImage, feltColor, railColor };
}
