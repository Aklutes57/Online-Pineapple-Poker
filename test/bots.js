// Headless multiplayer soak test: boots the real server in-process, connects
// bot sockets, and plays many hands per variant choosing random legal actions
// from each bot's own availableActions. Asserts chip conservation, no negative
// stacks, and no stalls. Usage: node test/bots.js [handsPerVariant]

import { io as ioc } from 'socket.io-client';
import { buildServer } from '../server/app.js';
import { EVENTS, TIMINGS } from '../shared/constants.js';

// Speed the game way up for the soak (in-process mutation of shared timings).
TIMINGS.NEXT_HAND_DELAY = 40;
TIMINGS.RUNOUT_STREET_DELAY = 5;
TIMINGS.DISCARD_TIME = 3000;
TIMINGS.AWAY_GRACE = 20;

const HANDS_PER_VARIANT = parseInt(process.argv[2], 10) || 60;
const VARIANT_KEYS = ['holdem', 'pineapple', 'crazyPineapple', 'plo'];
const BOTS = 5; // plus the host = 6 seats
const BUY_IN = 200;

let rngState = 987654321;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function randInt(min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}

function fail(msg, extra) {
  console.error(`\nSOAK FAIL: ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2).slice(0, 4000));
  process.exit(1);
}

class Bot {
  constructor(url, gameId, name, { isHost = false, token = null } = {}) {
    this.url = url;
    this.gameId = gameId;
    this.name = name;
    this.isHost = isHost;
    this.token = token;
    this.state = null;
    this.actedKeys = new Set();
    this.socket = null;
    this.onState = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = ioc(this.url, { transports: ['websocket'] });
      this.socket.on('connect', () => {
        this.socket.emit(
          EVENTS.JOIN,
          { gameId: this.gameId, token: this.token, nickname: this.name },
          (res) => {
            if (!res?.ok) {
              reject(new Error(`join failed for ${this.name}`));
              return;
            }
            this.token = res.token;
            this.handleState(res.state);
            resolve();
          }
        );
      });
      this.socket.on(EVENTS.STATE, (state) => this.handleState(state));
      this.socket.on('connect_error', reject);
    });
  }

  handleState(state) {
    if (this.state && state.seq <= this.state.seq) return;
    this.state = state;
    if (this.onState) this.onState(this, state);
    this.maybeAct();
  }

  maybeAct() {
    const you = this.state?.you;
    const hand = this.state?.hand;
    if (!you || !hand) return;

    if (you.availableActions) {
      const key = `act:${hand.handId}:${hand.phase}:${hand.currentBet}:${hand.toActSeat}`;
      if (this.actedKeys.has(key)) return;
      this.actedKeys.add(key);
      const payload = this.pickAction(you.availableActions, hand);
      setTimeout(() => this.socket.emit(EVENTS.ACTION, payload), randInt(0, 10));
      return;
    }

    if (you.canDiscard) {
      const key = `discard:${hand.handId}`;
      if (this.actedKeys.has(key)) return;
      this.actedKeys.add(key);
      setTimeout(
        () =>
          this.socket.emit(EVENTS.DISCARD, {
            handId: hand.handId,
            cardIndex: randInt(0, you.holeCards.length - 1),
          }),
        randInt(0, 10)
      );
    }
  }

  pickAction(av, hand) {
    const roll = rnd();
    const base = { handId: hand.handId };
    if (av.canRaise && roll < 0.05) {
      return { ...base, action: 'raise', amount: av.maxRaiseTo }; // shove
    }
    if (av.canRaise && roll < 0.3) {
      const bb = this.state.settings.bigBlind;
      const cap = Math.min(av.maxRaiseTo, av.minRaiseTo + bb * 6);
      return { ...base, action: 'raise', amount: randInt(av.minRaiseTo, cap) };
    }
    if (!av.canCheck && roll > 0.85) {
      return { ...base, action: 'fold' };
    }
    return { ...base, action: av.canCheck ? 'check' : 'call' };
  }

  disconnect() {
    this.socket?.disconnect();
  }
}

async function soakVariant(variantKey) {
  const { httpServer } = buildServer();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `http://localhost:${port}`;

  const createRes = await fetch(`${url}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: 'host',
      settings: { variant: variantKey, smallBlind: 1, bigBlind: 2, defaultBuyIn: BUY_IN, minBuyIn: 40, maxBuyIn: 1000 },
    }),
  });
  const { gameId, token } = await createRes.json();

  const host = new Bot(url, gameId, 'host', { isHost: true, token });
  const bots = [host];
  for (let i = 0; i < BOTS; i++) bots.push(new Bot(url, gameId, `bot${i + 1}`));

  let handsFinished = 0;
  let lastFinishedHandNo = 0;
  let lastEventAt = Date.now();
  let started = false;
  let done = false;
  const approved = new Set();
  const toppedUpAt = new Map(); // playerId -> handNo of last top-up

  let finishResolve;
  const finished = new Promise((resolve) => {
    finishResolve = resolve;
  });

  function checkInvariants(state) {
    const seats = state.seats.filter(Boolean);
    for (const s of seats) {
      if (s.stack < 0) fail(`${variantKey}: negative stack for ${s.nickname}`, state);
    }
    if (state.hand?.finished) {
      const sumStacks = seats.reduce((a, s) => a + s.stack, 0);
      const buyIns = state.ledger.reduce((a, r) => a + r.buyIns, 0);
      const cashOuts = state.ledger.reduce((a, r) => a + r.cashOuts, 0);
      if (sumStacks !== buyIns - cashOuts) {
        fail(
          `${variantKey}: chips not conserved after hand #${state.hand.handNo}: stacks ${sumStacks}, expected ${buyIns - cashOuts}`,
          state
        );
      }
    }
  }

  host.onState = (bot, state) => {
    lastEventAt = Date.now();
    checkInvariants(state);

    // Approve every seat request.
    for (const req of state.seatRequests || []) {
      if (!approved.has(req.playerId)) {
        approved.add(req.playerId);
        bot.socket.emit(EVENTS.HOST_APPROVE_SEAT, { playerId: req.playerId, approve: true });
      }
    }

    // Start once everyone is seated.
    const seated = state.seats.filter(Boolean).length;
    if (!started && state.status === 'lobby' && seated === BOTS + 1) {
      started = true;
      bot.socket.emit(EVENTS.HOST_START_GAME, {});
    }

    // Top up busted bots so the game never dies (host behavior).
    if (started && state.hand?.finished) {
      for (const s of state.seats) {
        if (s && s.stack === 0 && toppedUpAt.get(s.playerId) !== state.hand.handNo) {
          toppedUpAt.set(s.playerId, state.hand.handNo);
          bot.socket.emit(EVENTS.HOST_ADJUST_STACK, { playerId: s.playerId, delta: BUY_IN });
        }
      }
    }

    // Count finished hands.
    if (state.hand?.finished && state.hand.handNo > lastFinishedHandNo) {
      lastFinishedHandNo = state.hand.handNo;
      handsFinished++;
      if (handsFinished % 20 === 0) {
        process.stdout.write(`  ${variantKey}: ${handsFinished}/${HANDS_PER_VARIANT} hands\r`);
      }
      if (handsFinished >= HANDS_PER_VARIANT && !done) {
        done = true;
        finishResolve();
      }
    }
  };

  for (const bot of bots.slice(1)) {
    bot.onState = () => {
      lastEventAt = Date.now();
    };
  }

  for (const bot of bots) {
    await bot.connect();
  }
  for (const bot of bots) {
    bot.socket.emit(EVENTS.REQUEST_SEAT, { nickname: bot.name, buyIn: BUY_IN, seatIndex: null });
  }

  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt > 10000) {
      fail(`${variantKey}: no state broadcast for 10s (stall) after ${handsFinished} hands`, host.state);
    }
  }, 1000);

  const timeout = setTimeout(() => {
    fail(`${variantKey}: soak did not finish in time (${handsFinished}/${HANDS_PER_VARIANT})`);
  }, 240000);

  await finished;

  clearInterval(watchdog);
  clearTimeout(timeout);
  for (const bot of bots) bot.disconnect();
  await new Promise((resolve) => httpServer.close(resolve));
  console.log(`  ${variantKey}: ${handsFinished} hands OK                    `);
}

for (const variantKey of VARIANT_KEYS) {
  console.log(`Soaking ${variantKey}…`);
  await soakVariant(variantKey);
}
console.log('soak: all variants passed');
process.exit(0);
