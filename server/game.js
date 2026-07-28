// A table: seats, players, host, lobby, hand loop, chat/log/ledger.
// Owns the single pending flow timer (action / discard / run-out / next-hand).
// The sockets layer sets game.onChanged and calls the public methods here.

import { GAME_STATUS, DEFAULT_SETTINGS, SEAT_COUNT, TIMINGS, SETTINGS_LIMITS, PHASES } from '../shared/constants.js';
import { Hand } from './hand.js';
import { recordHandStats, syncSessionResults, closeTableSession } from './stats.js';
import { saveHand } from './handStore.js';
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
    this.hostAccountId = null;
    this.tableSessionId = null;
    this.players = new Map(); // playerId -> player
    this.byToken = new Map(); // token -> player
    this.seats = new Array(SEAT_COUNT).fill(null); // playerId | null
    this.currentHand = null;
    this.handNo = 0;
    this.buttonSeat = null;
    this.chat = [];
    this.logs = [];
    this.ledger = new Map(); // playerId -> { nickname, buyIns, cashOuts }
    this.pendingOps = []; // ops queued while a hand is live, applied at hand end
    this.pauseRequested = false;
    this.timer = null; // { name, deadline, handle }
    this.hostTransferTimeout = null;
    this.seq = 0;
    this.lastActivity = Date.now();
    this.closed = false;
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
    player.status = 'requesting';
    player.pendingBuyIn = buyIn;
    player.requestedSeat = seatIndex;
    if (player.id === this.hostId) {
      return this.approveSeat(player.id, true); // the host seats themselves
    }
    this.addLog(`${player.nickname} wants to join with ${buyIn}`);
    return { ok: true };
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
    this.creditLedger(player, player.pendingBuyIn);
    this.addLog(`${player.nickname} takes seat ${seat + 1} with ${player.stack}`);
    player.pendingBuyIn = 0;
    player.requestedSeat = null;
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

  adjustStack(playerId, delta) {
    const player = this.players.get(playerId);
    if (!player || player.status !== 'seated') return { ok: false, error: 'not seated' };
    if (!Number.isInteger(delta) || delta === 0) return { ok: false, error: 'bad amount' };
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
    const applied = Math.max(delta, -player.stack);
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
    const clean = sanitizeSettings(next);
    // Variant is fixed at creation.
    clean.variant = this.settings.variant;
    this.settings = clean;
    this.addLog(
      `Settings updated: blinds ${clean.smallBlind}/${clean.bigBlind}, ` +
      `timer ${clean.actionTime ? clean.actionTime + 's' : 'off'}`
    );
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
      }
    }
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

  startHand() {
    if (this.status !== GAME_STATUS.RUNNING || this.closed) return;
    if (this.currentHand && !this.currentHand.finished) return;
    const players = this.eligiblePlayers();
    if (players.length < 2) {
      this.currentHand = null;
      this.addLog('Waiting for at least 2 players with chips…');
      this.emitChanged();
      return;
    }
    this.buttonSeat = this.nextButtonSeat();
    this.handNo++;
    this.currentHand = new Hand({
      handNo: this.handNo,
      variantKey: this.settings.variant,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      actionTime: this.settings.actionTime,
      buttonSeat: this.buttonSeat,
      players: players.sort((a, b) => a.seatIndex - b.seatIndex),
      ctx: {
        log: (text) => this.addLog(text),
        changed: () => this.emitChanged(),
        finished: () => this.onHandFinished(),
        setTimer: (name, ms, fn) => this.setTimer(name, ms, fn),
        clearTimer: () => this.clearTimer(),
        markAway: (player) => {
          player.sittingOut = true;
        },
      },
    });
    this.currentHand.start();
    this.emitChanged();
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

  // ---- host ----

  isHost(player) {
    return player.id === this.hostId;
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
  const smallBlind = clamp(s.smallBlind, 1, 1000000, DEFAULT_SETTINGS.smallBlind);
  const bigBlind = clamp(s.bigBlind, smallBlind, 2000000, Math.max(smallBlind, DEFAULT_SETTINGS.bigBlind));
  const minBuyIn = clamp(s.minBuyIn, 1, 100000000, bigBlind * 20);
  const maxBuyIn = clamp(s.maxBuyIn, minBuyIn, 100000000, Math.max(minBuyIn, bigBlind * 500));
  const defaultBuyIn = clamp(s.defaultBuyIn, minBuyIn, maxBuyIn, Math.min(Math.max(bigBlind * 100, minBuyIn), maxBuyIn));
  const actionTime = SETTINGS_LIMITS.actionTimes.includes(s.actionTime)
    ? s.actionTime
    : DEFAULT_SETTINGS.actionTime;
  const variant = ['holdem', 'pineapple', 'crazyPineapple', 'plo'].includes(s.variant)
    ? s.variant
    : DEFAULT_SETTINGS.variant;
  return {
    variant, smallBlind, bigBlind, minBuyIn, maxBuyIn, defaultBuyIn, actionTime,
    tableTheme: cleanTheme(s.tableTheme),
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
