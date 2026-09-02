// Headless multiplayer soak test: boots the real server in-process, connects
// bot sockets, and plays many hands per variant choosing random legal actions
// from each bot's own availableActions. Asserts chip conservation, no negative
// stacks, and no stalls. Usage: node test/bots.js [handsPerVariant]

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-soak-')), 'test.db');

const { io: ioc } = await import('socket.io-client');
const { buildServer } = await import('../server/app.js');
// Playing requires an account, so the bots get real ones. Made in-process
// rather than through /api/auth/signup because that endpoint is rate-limited
// to 20 a minute and a soak wants more crew than that, and because what is on
// trial here is the engine, not the signup form.
const { initDb } = await import('../server/db.js');
const { createAccount } = await import('../server/accounts.js');
initDb();
const crew = new Map();
function accountFor(name) {
  if (!crew.has(name)) {
    const made = createAccount({
      email: `${name}@soak.example`, password: 'a good long password', displayName: name,
    });
    if (!made.ok) throw new Error(`could not make a soak account for ${name}: ${made.error}`);
    crew.set(name, made.token);
  }
  return crew.get(name);
}
const { EVENTS, TIMINGS } = await import('../shared/constants.js');

// Speed the game way up for the soak (in-process mutation of shared timings).
TIMINGS.NEXT_HAND_DELAY = 40;
TIMINGS.RUNOUT_STREET_DELAY = 5;
TIMINGS.DISCARD_TIME = 3000;
TIMINGS.RIT_VOTE_TIME = 2000; // a bot that declines to answer shouldn't stall the soak
TIMINGS.AWAY_GRACE = 20;
TIMINGS.COUNTDOWN_747 = 10;
TIMINGS.REVEAL_747_GAP = 10;
TIMINGS.REVEAL_747_STEP = 5;

const HANDS_PER_VARIANT = parseInt(process.argv[2], 10) || 60;
// Six seats play every one of these. Five Card Draw caps its deal at five,
// so this also exercises the overflow seat sitting a hand out.
const VARIANT_KEYS = ['holdem', 'pineapple', 'crazyPineapple', 'plo', '747', 'fiveCardDraw', 'sevenCardStud'];
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
    this.accountToken = accountFor(name);
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
          {
            gameId: this.gameId, token: this.token, nickname: this.name,
            accountToken: this.accountToken,
          },
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

    // Straddling is opt-in, twice over, so a soak that never opts in never
    // tests it. About two thirds of the table takes the first straddle and
    // about half will re-straddle behind someone — enough for double and
    // triple straddles to come around, with gaps in the chain where somebody
    // declined one or the other.
    if (!you.spectator && !this.straddleChosen && this.state.settings?.straddle) {
      this.straddleChosen = true;
      if (rnd() < 0.65) this.socket.emit(EVENTS.SET_STRADDLE, { on: true });
      if (rnd() < 0.5) this.socket.emit(EVENTS.SET_STRADDLE, { on: true, deep: true });
    }

    if (you.availableActions) {
      const key = `act:${hand.handId}:${hand.phase}:${hand.currentBet}:${hand.toActSeat}`;
      if (this.actedKeys.has(key)) return;
      this.actedKeys.add(key);
      const payload = this.pickAction(you.availableActions, hand);
      setTimeout(() => this.socket.emit(EVENTS.ACTION, payload), randInt(0, 10));
      return;
    }

    // 747: the simultaneous stay/fold decision. Mostly stay, so the pot
    // usually pays out, but enough folds to hit the everyone-folds sweep.
    if (you.canDecide747) {
      const key = `decide747:${hand.handId}`;
      if (this.actedKeys.has(key)) return;
      this.actedKeys.add(key);
      setTimeout(
        () => this.socket.emit(EVENTS.DECISION_747, { handId: hand.handId, stay: rnd() < 0.6 }),
        randInt(0, 10)
      );
      return;
    }

    // Run it twice is now a per-hand vote that needs everyone's agreement.
    // Mostly yes, so both the two-board and the declined path get exercised.
    if (you.canVoteRunItTwice) {
      const key = `rit:${hand.handId}`;
      if (this.actedKeys.has(key)) return;
      this.actedKeys.add(key);
      setTimeout(
        () => this.socket.emit(EVENTS.RUN_IT_TWICE_VOTE, { handId: hand.handId, yes: rnd() < 0.75 }),
        randInt(0, 10)
      );
      return;
    }

    // Sometimes show cards after the hand (folders flashing the fold, or a
    // fold-winner showing the bluff) — the reveal must never move chips.
    if (you.canShow) {
      const key = `show:${hand.handId}`;
      if (!this.actedKeys.has(key)) {
        this.actedKeys.add(key);
        if (rnd() < 0.35) {
          setTimeout(() => this.socket.emit(EVENTS.SHOW_CARDS, { handId: hand.handId }), randInt(0, 10));
        }
      }
    }

    if (you.canDraw) {
      const key = `draw:${hand.handId}`;
      if (this.actedKeys.has(key)) return;
      this.actedKeys.add(key);
      // Anything from standing pat to throwing the whole hand, so the deck is
      // pushed to the worst case a five-handed draw table can reach.
      const want = randInt(0, you.holeCards.length);
      const indices = [];
      while (indices.length < want) {
        const i = randInt(0, you.holeCards.length - 1);
        if (!indices.includes(i)) indices.push(i);
      }
      setTimeout(
        () => this.socket.emit(EVENTS.DRAW_CARDS, { handId: hand.handId, indices }),
        randInt(0, 10)
      );
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

async function soakVariant(variantKey, extraSettings = {}, label = variantKey) {
  const { httpServer } = buildServer();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `http://localhost:${port}`;

  const createRes = await fetch(`${url}/api/games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accountFor('host')}`,
    },
    body: JSON.stringify({
      nickname: 'host',
      settings: {
        variant: variantKey, smallBlind: 1, bigBlind: 2,
        defaultBuyIn: BUY_IN, minBuyIn: 40, maxBuyIn: 1000,
        ...extraSettings,
      },
    }),
  });
  const { gameId, token } = await createRes.json();

  const host = new Bot(url, gameId, 'host', { isHost: true, token });
  const bots = [host];
  for (let i = 0; i < BOTS; i++) bots.push(new Bot(url, gameId, `bot${i + 1}`));

  let handsFinished = 0;
  const variantsSeen = new Set(); // guards against a silent fallback variant
  let lastFinishedHandNo = 0;
  let lastVariantSwitch = 0;
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
      if (s.stack < 0) fail(`${label}: negative stack for ${s.nickname}`, state);
    }
    if (state.hand?.finished) {
      // A riding 747 pot is chips in flight — part of the books until it
      // pays out or is liquidated back into stacks.
      const sumStacks = seats.reduce((a, s) => a + s.stack, 0) + (state.carryPot || 0);
      const buyIns = state.ledger.reduce((a, r) => a + r.buyIns, 0);
      const cashOuts = state.ledger.reduce((a, r) => a + r.cashOuts, 0);
      if (sumStacks !== buyIns - cashOuts) {
        fail(
          `${variantKey}: chips not conserved after hand #${state.hand.handNo}: stacks+carry ${sumStacks}, expected ${buyIns - cashOuts}`,
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

    // Rotate the game mid-session every few hands (option passes only) —
    // the variant must switch cleanly between hands with chips conserved.
    if (
      extraSettings.rotateVariants &&
      started &&
      state.hand?.finished &&
      state.hand.handNo > lastVariantSwitch &&
      state.hand.handNo % 6 === 0
    ) {
      lastVariantSwitch = state.hand.handNo;
      // 747 in the rotation exercises switching a dealer game in and out
      // mid-session (including carry-pot liquidation on the way out).
      const rotation = ['holdem', 'pineapple', '747', 'crazyPineapple', 'plo'];
      const next = rotation[(rotation.indexOf(state.settings.variant) + 1) % rotation.length];
      bot.socket.emit(EVENTS.HOST_UPDATE_SETTINGS, { variant: next });
    }

    // Top up short bots so the game never dies (host behavior). Below the
    // big blind covers busted stacks and 747's you-must-cover-the-ante rule.
    if (started && (state.hand?.finished || !state.hand)) {
      const handNo = state.hand?.handNo ?? -1;
      for (const s of state.seats) {
        if (s && s.stack < state.settings.bigBlind && toppedUpAt.get(s.playerId) !== handNo) {
          toppedUpAt.set(s.playerId, handNo);
          bot.socket.emit(EVENTS.HOST_ADJUST_STACK, { playerId: s.playerId, delta: BUY_IN });
        }
      }
    }

    // Count finished hands.
    if (state.hand?.finished && state.hand.handNo > lastFinishedHandNo) {
      lastFinishedHandNo = state.hand.handNo;
      variantsSeen.add(state.hand.variant);
      handsFinished++;
      if (handsFinished % 20 === 0) {
        process.stdout.write(`  ${label}: ${handsFinished}/${HANDS_PER_VARIANT} hands\r`);
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
      fail(`${label}: no state broadcast for 10s (stall) after ${handsFinished} hands`, host.state);
    }
  }, 1000);

  const timeout = setTimeout(() => {
    fail(`${label}: soak did not finish in time (${handsFinished}/${HANDS_PER_VARIANT})`);
  }, 240000);

  await finished;

  clearInterval(watchdog);
  clearTimeout(timeout);
  if (!variantsSeen.has(variantKey)) {
    fail(`${label}: no hand was actually dealt as ${variantKey} (saw: ${[...variantsSeen].join(', ')})`);
  }
  if (extraSettings.rotateVariants && variantsSeen.size < 2) {
    fail(`${label}: rotation never switched the variant (saw: ${[...variantsSeen].join(', ')})`);
  }
  for (const bot of bots) bot.disconnect();
  await new Promise((resolve) => httpServer.close(resolve));
  console.log(`  ${label}: ${handsFinished} hands OK (${[...variantsSeen].join(', ')})`);
}

for (const variantKey of VARIANT_KEYS) {
  console.log(`Soaking ${variantKey}…`);
  await soakVariant(variantKey);
}

// Every chip-moving home-game option at once. Antes, bounties and two-board
// payouts all have to keep `sum of stacks === buy-ins - cash-outs` exact.
const OPTION_PASSES = [
  ['holdem', { straddle: true, runItTwice: true, bombPotEvery: 4, sevenDeuceBounty: 15, rabbitHunt: true, rotateVariants: true }, 'holdem+options'],
  ['plo', { straddle: true, runItTwice: true, bombPotEvery: 5, sevenDeuceBounty: 10, rotateVariants: true }, 'plo+options'],
  ['crazyPineapple', { bombPotEvery: 3, sevenDeuceBounty: 20, runItTwice: true, rotateVariants: true }, 'crazyPineapple+options'],
  // Starts as the dealer game and rotates out of (and back into) it —
  // the carry pot must liquidate cleanly at every switch.
  ['747', { rotateVariants: true }, '747+rotation'],
];
for (const [variantKey, settings, label] of OPTION_PASSES) {
  console.log(`Soaking ${label}…`);
  await soakVariant(variantKey, settings, label);
}

console.log('soak: all variants and options passed');
process.exit(0);
