// Shared between server (via relative import) and browser (served at /shared/constants.js).
// This file is the protocol contract: event names, phases, variants, seat geometry.

export const SEAT_COUNT = 10;

export const EVENTS = {
  // client -> server
  JOIN: 'join',
  REQUEST_SEAT: 'requestSeat',
  CANCEL_SEAT_REQUEST: 'cancelSeatRequest',
  ACTION: 'action',
  DISCARD: 'discard',
  // Draw games: the whole exchange in one message. An empty list is standing
  // pat, which is a choice and has to be sent like any other.
  DRAW_CARDS: 'drawCards',
  SHOW_CARDS: 'showCards',
  SIT_OUT: 'sitOut',
  SIT_IN: 'sitIn',
  SET_STRADDLE: 'setStraddle',
  // Chips moved by hand rather than by betting: a tip goes from one player's
  // stack to another's, a post goes from your stack into the live pot.
  TIP_PLAYER: 'tipPlayer',
  POST_TO_POT: 'postToPot',
  // The table's music queue. Playback is per-browser; these only move the
  // shared queue and the clock everybody seeks against.
  MUSIC_ADD: 'music:add',
  MUSIC_SKIP: 'music:skip',
  MUSIC_PAUSE: 'music:pause',
  MUSIC_ENDED: 'music:ended',
  MUSIC_CLEAR: 'music:clear',
  STAND_UP: 'standUp',
  CHAT: 'chat',
  REACT: 'react',
  SET_PREACTION: 'setPreAction',
  RABBIT_HUNT: 'rabbitHunt',
  DECISION_747: 'decision747',
  SET_CLIENT_SEED: 'setClientSeed',
  SET_AVATAR: 'setAvatar',
  SET_NAME_FONT: 'setNameFont',
  // The name the ledger settles up under, kept apart from the table username.
  SET_REAL_NAME: 'setRealName',
  RUN_IT_TWICE_VOTE: 'runItTwiceVote',
  REBUY: 'rebuy',
  LEAVE_WAITLIST: 'leaveWaitlist',
  // WebRTC voice/video: announce that you've joined the A/V session, and relay
  // the peer-to-peer connection handshake between two players in the same game.
  RTC_MEDIA: 'rtc:media',
  RTC_SIGNAL: 'rtc:signal',
  HOST_NUDGE: 'host:nudge',
  HOST_APPROVE_WAITLIST: 'host:approveWaitlist',
  HOST_APPROVE_SEAT: 'host:approveSeat',
  HOST_START_GAME: 'host:startGame',
  HOST_PAUSE: 'host:pause',
  HOST_KICK: 'host:kick',
  HOST_TRANSFER: 'host:transfer',
  HOST_ADJUST_STACK: 'host:adjustStack',
  HOST_UPDATE_SETTINGS: 'host:updateSettings',
  HOST_CLOSE_TABLE: 'host:closeTable',
  // server -> client
  STATE: 'state',
  CHAT_MSG: 'chatMsg',
  REACTION: 'reaction',
  LOG: 'log',
  ERROR_MSG: 'errorMsg',
  TABLE_CLOSED: 'tableClosed',
};

export const GAME_STATUS = {
  LOBBY: 'lobby',
  RUNNING: 'running',
  PAUSED: 'paused',
  CLOSED: 'closed',
};

export const PHASES = {
  PREFLOP: 'preflop',
  DISCARD_PREFLOP: 'discardPreflop',
  FLOP: 'flop',
  DISCARD_POSTFLOP: 'discardPostflop',
  RIT_VOTE: 'ritVote',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  COMPLETE: 'complete',
  // Draw engine: bet with five, exchange what you don't want, bet again.
  PREDRAW: 'predraw',
  DRAW: 'draw',
  POSTDRAW: 'postdraw',
  // Stud engine. Named for the card you are receiving, the way the game is
  // called at a table: third street is the first three cards, seventh the last.
  THIRD: 'third',
  FOURTH: 'fourth',
  FIFTH: 'fifth',
  SIXTH: 'sixth',
  SEVENTH: 'seventh',
  // 747 engine phases
  DECISION_747: 'decision747',
  COUNTDOWN_747: 'countdown747',
  // The staged showdown: decisions turned over, then the fifth cards landing
  // one at a time, then the dealer's. One phase for all three beats — which
  // beat is showing is carried by the timer name and by the card counts the
  // view already publishes.
  REVEAL_747: 'reveal747',
};

// Each variant declares: which engine runs the hand ('community' is the
// betting-rounds engine, '747' the dealer-vs-players engine), hole cards
// dealt, where the discard phase slots in (null = no discard), and betting
// style.
//
// `sevenDeuce` marks the games the 7-2 bounty is played in. It is the worst
// STARTING HAND in a two-card game, which is the whole joke — so it means
// something in Hold'em and in the Pineapples, where you end up holding two,
// and nothing in Omaha or a bomb pot (four cards), in Draw (five) or in Stud
// (seven), where 7-2 is neither the worst holding nor a rare one.
export const VARIANTS = {
  holdem: {
    key: 'holdem',
    label: "Texas Hold'em",
    holeCards: 2,
    discardBefore: null,
    potLimit: false,
    sevenDeuce: true,
  },
  pineapple: {
    key: 'pineapple',
    label: 'Pineapple',
    holeCards: 3,
    // Throw a card away first, then bet: the preflop round is played with the
    // two cards you are keeping.
    discardBefore: 'preflop',
    potLimit: false,
    sevenDeuce: true,
  },
  crazyPineapple: {
    key: 'crazyPineapple',
    label: 'Crazy Pineapple',
    holeCards: 3,
    // Bet preflop holding all three, then discard the moment the flop lands —
    // before the flop betting round.
    discardBefore: 'flop',
    potLimit: false,
    sevenDeuce: true,
  },
  plo: {
    key: 'plo',
    label: 'Pot Limit Omaha',
    holeCards: 4,
    discardBefore: null,
    potLimit: true,
    omaha: true, // must use exactly 2 hole cards
  },
  // What a bomb pot is dealt as, whatever game the table is otherwise
  // playing: four cards each, Omaha rules (exactly two from your hand), and
  // two boards with the pot split between them. Marked hidden because it is
  // the shape a bomb pot takes rather than a game you sit down to play — it
  // never appears in the host's variant list.
  bombOmaha: {
    key: 'bombOmaha',
    label: 'Omaha bomb pot',
    holeCards: 4,
    discardBefore: null,
    // Pot limit, the way a bomb pot is actually played: everyone is already
    // in for the ante, so no-limit turns the first bet into a shove.
    potLimit: true,
    omaha: true,
    doubleBoard: true,
    hidden: true,
  },
  fiveCardDraw: {
    key: 'fiveCardDraw',
    label: 'Five Card Draw',
    engine: 'draw',
    holeCards: 5,
    discardBefore: null,
    potLimit: false,
    // No board at all: your five cards ARE your hand, and the best five of
    // five is simply the five you are holding.
    noBoard: true,
    // Five players, because the deck has to cover the worst case: five cards
    // each and then five more each if everybody draws their whole hand, which
    // is fifty of fifty-two. A live game reshuffles the discards to get round
    // that; we cannot, because the deck was committed to before the deal and
    // that commitment is what makes the shuffle provable.
    maxPlayers: 5,
  },
  sevenCardStud: {
    key: 'sevenCardStud',
    label: 'Seven Card Stud',
    engine: 'stud',
    // Dealt over five streets rather than all at once, so this is the total
    // each player ends up holding, not an opening deal.
    holeCards: 7,
    discardBefore: null,
    potLimit: false,
    noBoard: true,
    // No blinds. Everyone antes, and the lowest card showing on third street
    // is made to open the betting.
    ante: true,
    bringIn: true,
    // Seven cards each out of fifty-two: seven players is the real limit, and
    // it is the limit a live stud game plays to for exactly this reason.
    maxPlayers: 7,
  },
  '747': {
    key: '747',
    label: '747 Poker',
    engine: '747',
    holeCards: 4, // plus a fifth card for players who stay
    discardBefore: null,
    potLimit: false,
    // Ante-based dealer game: no blinds, no betting rounds. Everyone antes,
    // takes four cards, and locks a hold-or-drop choice; holders get a fifth
    // card. Only the BEST hand among the holders plays the house dealer —
    // every other holder lost to a player, is out of the hand, and pays a
    // penalty. Fours are wild and two natural sevens in the first four cards
    // win outright. If the dealer beats the challenger, the pot rides to the
    // next 747 hand; either way, penalties fund the NEXT pot, never this one.
  },
};

export const DEFAULT_SETTINGS = {
  variant: 'holdem',
  smallBlind: 1,
  bigBlind: 2,
  defaultBuyIn: 200,
  minBuyIn: 40,
  maxBuyIn: 1000,
  actionTime: 30, // seconds; 0 = untimed ("no clock")
  timeBank: 0, // seconds of reserve per player; 0 = off
  straddle: false, // UTG posts 2x the big blind before the deal
  rabbitHunt: false, // show what would have come after a hand ends early
  runItTwice: false, // deal two boards when everyone is all-in
  bombPotEvery: 0, // every N hands: everyone antes, straight to the flop
  // …or leave it to chance. A fixed cadence is predictable and people start
  // waiting for it; a frequency means the table never knows which hand it is.
  // 'off' | 'frequent' | 'semi' | 'rare' — see BOMB_POT_ODDS.
  bombPotFrequency: 'off',
  bombPotAnte: 0, // chips each player antes; 0 means "use the big blind"
  sevenDeuceBounty: 0, // chips each opponent pays for a win with 7-2
  // Mixed games. When on, the table changes format every `rotateEvery` hands,
  // walking `rotateList` in order. An empty list means "every format that can
  // be rotated" — see rotatableVariants(). Rotation only ever happens between
  // hands, and never while the table is playing 747.
  rotateVariants: false,
  rotateEvery: 8,
  rotateList: [],
  // 747 only. ante747 = 0 means "use the big blind", which is what 747 tables
  // did before the ante became host-settable.
  ante747: 0,
  // Cap on the 747 penalty. A loser pays min(pot, cap); 0 turns penalties off.
  penaltyCap747: 25,
  // Tournament. Off means a cash game, which is what every table was before
  // this existed and still is unless you ask for otherwise.
  tournament: false,
  levelMinutes: 15,   // how long each blind level lasts
  rebuyMinutes: 60,   // re-buys allowed for this long; 0 = freezeout from hand 1
};

// A tournament's blind ladder, as multiples of the starting big blind. Each
// level's small blind is half its big blind, rounded up, so the ratio holds at
// every level without carrying a second table of numbers.
export const BLIND_LADDER = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

// The blinds for a level index, from the table's starting big blind. Past the
// end of the ladder each further level doubles, so a long tournament never
// stalls at a fixed level.
//
// Total about the inputs: a negative or non-integer level would index off the
// end of the ladder, and `Math.round(bb * undefined)` is NaN — which would be
// posted as a blind and turn a stack into NaN, taking chip conservation with
// it. Nothing downstream would catch that, so it is caught here.
export function blindsForLevel(startingBigBlind, level) {
  const base = Number.isFinite(startingBigBlind) && startingBigBlind >= 2
    ? Math.floor(startingBigBlind)
    : 2;
  const idx = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  const last = BLIND_LADDER.length - 1;
  const mult = idx <= last ? BLIND_LADDER[idx] : BLIND_LADDER[last] * 2 ** (idx - last);
  const raw = Math.round(base * mult);
  const bigBlind = Number.isFinite(raw) ? Math.max(2, Math.min(raw, MAX_CHIPS)) : base;
  return { smallBlind: Math.max(1, Math.ceil(bigBlind / 2)), bigBlind };
}

// Not a gameplay cap — blinds and buy-ins are host's choice, uncapped. This
// only bounds chip amounts so a full table's pot always sums in exact
// integers (10 × MAX_CHIPS is still well inside Number.MAX_SAFE_INTEGER);
// past that, conservation checks would rot from float rounding.
export const MAX_CHIPS = 100_000_000_000_000;

// How much money may enter the table in one go — a house rule, unlike
// MAX_CHIPS above, which is only there to keep arithmetic exact.
//
// It exists because nothing bounds the ledger's running totals: creditLedger
// just adds to buyIns, hand after hand. With re-buys allowed all the way to
// MAX_CHIPS, ninety of them push a player's total past
// Number.MAX_SAFE_INTEGER, and past that point adding 1 to a number does
// nothing — the books-balance check would then print "✓ Books balance" over
// books that do not. At a hundred million the same overflow needs ninety
// MILLION re-buys, which is the headroom this number is chosen for.
export const BUY_IN_CAP = 100_000_000;

export const SETTINGS_LIMITS = {
  nickname: { min: 1, max: 20 },
  // Optional, and longer than a nickname because it is a person's actual name.
  realName: { min: 1, max: 40 },
  smallBlind: { min: 1, max: MAX_CHIPS },
  bigBlind: { min: 2, max: MAX_CHIPS },
  buyIn: { min: 1, max: MAX_CHIPS },
  actionTimes: [0, 15, 30, 60],
  chatLength: 300,
};

// How often a random bomb pot comes around, as a per-hand chance. Roughly one
// in six, one in twelve, one in twenty-five — often enough to change how a
// session feels, rare enough to still be a surprise.
export const BOMB_POT_ODDS = {
  off: 0,
  frequent: 1 / 6,
  semi: 1 / 12,
  rare: 1 / 25,
};

export const BOMB_POT_LABELS = {
  off: 'Off',
  frequent: 'Random — often',
  semi: 'Random — now and then',
  rare: 'Random — rare',
};

// Bomb pots are dealt as this, not as the table's own game.
export const BOMB_POT_VARIANT = 'bombOmaha';

// The formats a mixed table can rotate through. 747 is deliberately not one
// of them: it runs a different engine — no blinds, no betting rounds, a pot
// that rides between hands — so rotating it in mid-session would change what
// "the next hand" means and strand the carry pot. Hidden variants are engine
// internals (the bomb pot's Omaha), not games you sit down to play.
export function rotatableVariants() {
  return Object.values(VARIANTS)
    .filter((v) => !v.hidden && v.engine !== '747')
    .map((v) => v.key);
}

export const TIMINGS = {
  DISCARD_TIME: 15000, // ms for the pineapple discard decision
  RIT_VOTE_TIME: 12000, // ms to answer 'run it twice?' — no answer means no
  DISCARD_NO_CLOCK: 300000, // untimed tables still need a stall fallback
  NUDGE_GRACE: 15000, // ms a nudged player gets before the host's prod lands
  COUNTDOWN_747: 3200, // the 3-2-1 before stay/fold choices are revealed
  // The 747 showdown is dealt out rather than announced. GAP is the beat the
  // table gets to read something — who stayed, and the last card before the
  // dealer's — and STEP is the rhythm the fifth cards land in. Total added
  // time is 2*GAP + (n-1)*STEP for n stayers: 8s heads-up, 20s nine-handed.
  // Keep GAP under the soak's 10s stall watchdog (test/bots.js).
  REVEAL_747_GAP: 4000,
  REVEAL_747_STEP: 1500,
  NEXT_HAND_DELAY: 3000, // ms between hands
  // ms between streets on an all-in run-out. Long on purpose: when the money
  // is already in, the run-out IS the hand, and a flop that lands four
  // seconds before the turn is the part people are actually watching.
  RUNOUT_STREET_DELAY: 4000,
  AWAY_GRACE: 1000, // ms before auto-acting for a sitting-out player
  // How long a player who has dropped off gets before the table acts for
  // them. Long enough to walk back from a dead lift or a flaky phone and
  // still have your hand, short enough that nine people aren't held up by
  // somebody who has actually left.
  DISCONNECT_GRACE: 30000,
  HOST_TRANSFER_AFTER: 120000, // ms of host disconnect before host passes
};

// Percentage {left, top} anchors for the 10 seats around the oval table.
// Index 0 is bottom-center; clockwise when viewed on screen.
export const SEAT_COORDS = [
  { left: 50, top: 97 },
  { left: 28, top: 92 },
  { left: 10, top: 72 },
  { left: 10, top: 27 },
  { left: 28, top: 6 },
  { left: 50, top: 1 },
  { left: 72, top: 6 },
  { left: 90, top: 27 },
  { left: 90, top: 72 },
  { left: 72, top: 92 },
];

// The same ring for a table stood on its end — used when the screen is taller
// than it is wide (a phone held upright), so the felt becomes a vertical oval
// with the seats around it instead of a letterboxed landscape table. Index 0 is
// still bottom-center (always you), still clockwise.
// The side seats sit further in than a simple ellipse would put them: a seat
// pod is a much larger share of this narrower felt, so hugging the rim would
// leave them dangling in space beside the table.
// The mid-height seats stay clear of the board band (the board row sits at
// ~40-50% of the upright felt), and the seats flanking your own sit wide and
// high enough that your enlarged cards can't reach their nameplates.
export const SEAT_COORDS_PORTRAIT = [
  { left: 50, top: 97 },
  { left: 21, top: 87 },
  { left: 14, top: 62 },
  { left: 14, top: 30 },
  // The top three sit closest together of any seats on the ring, and a
  // nameplate here is about 56px wide against a 254px felt — so at 32/50/68
  // (18% apart, ~46px) they overlapped horizontally by design, and only the
  // vertical stagger kept them apart. Any game whose plates run a few pixels
  // taller closed that gap and they collided: Pineapple, 747 and Stud all did,
  // on every portrait screen. Spread to 24% apart, which clears a plate's own
  // width and stops depending on the height staying small.
  { left: 26, top: 8 },
  { left: 50, top: 3 },
  { left: 74, top: 8 },
  { left: 86, top: 30 },
  { left: 86, top: 62 },
  { left: 79, top: 87 },
];

// Where each seat's bet chips render, pulled toward the table center.
export const BET_COORDS = [
  { left: 50, top: 76 },
  { left: 32, top: 72 },
  { left: 21, top: 58 },
  { left: 21, top: 38 },
  { left: 32, top: 24 },
  { left: 50, top: 22 },
  { left: 68, top: 24 },
  { left: 79, top: 38 },
  { left: 79, top: 58 },
  { left: 68, top: 72 },
];

// Bet chip anchors for the upright (portrait) table.
// Kept clear of two things at once: the seat pod the chip belongs to (whose
// cards stack upward, well past the nameplate) and the board in the middle of
// the felt. On the upright table the board fills the waist of the oval, so the
// side seats' chips sit above or below it rather than beside it.
export const BET_COORDS_PORTRAIT = [
  { left: 50, top: 76 },
  { left: 37, top: 72 },
  { left: 38, top: 62 },
  { left: 38, top: 31 },
  { left: 37, top: 20 },
  { left: 50, top: 24 },
  { left: 63, top: 20 },
  { left: 62, top: 31 },
  { left: 62, top: 62 },
  { left: 63, top: 72 },
];

// Fonts a player can display their own name in. Every stack is built from
// faces that ship with Windows, macOS/iOS or Android — no webfont to download,
// so a name renders instantly and identically for everyone at the table.
export const NAME_FONTS = {
  classic: { label: 'Classic', stack: "'Segoe UI','Helvetica Neue',Arial,sans-serif" },
  bubble: { label: 'Bubble', stack: "'Arial Black','Arial Bold',Gadget,'Helvetica Neue',sans-serif" },
  stencil: { label: 'Stencil', stack: "Impact,Haettenschweiler,'Arial Narrow Bold',sans-serif" },
  slab: { label: 'Slab', stack: "Rockwell,'Rockwell Nova',Georgia,'Times New Roman',serif" },
  typewriter: { label: 'Typewriter', stack: "'Courier New',Courier,monospace" },
  script: { label: 'Script', stack: "'Segoe Script','Brush Script MT','Snell Roundhand',cursive" },
  deco: { label: 'Deco', stack: "'Copperplate','Copperplate Gothic Light','Palatino Linotype',serif" },
};

export const DEFAULT_NAME_FONT = 'classic';

// Table skins. Purely a look: every skin redefines the same custom properties
// in base.css, so seats, buttons and cards land in identical places whichever
// one you pick. Chosen per player, on their own screen — two people at the same
// table can be looking at two different rooms.
export const SKINS = {
  velvet: { label: 'Velvet Lounge' },
  tour: { label: 'Tour Circuit' },
  series: { label: 'Championship' },
  cwru: { label: 'CWRU Spartans' },
  wabash: { label: 'Wabash Scarlet' },
  classic: { label: 'Classic Card Room' },
  redhawk: { label: 'NC Wrestling Club' },
};
export const DEFAULT_SKIN = 'velvet';

// The reaction palette. Server-validated, so a client can't inject arbitrary
// text through the reaction channel.
export const REACTIONS = ['👍', '😂', '😱', '🤯', '🔥', '💀', '🍍', '🤡', '😭', '🙌'];

export const REACTION_COOLDOWN = 700; // ms between reactions per player

// Sound cues the table can raise. Every one has a built-in synthesized
// fallback, and a host can map their own uploaded clip to any of them.
export const SOUND_TRIGGERS = ['cooler', 'badBeat', 'quads', 'win', 'bust', 'yourTurn'];

export const ERRORS = {
  NOT_JOINED: 'NOT_JOINED',
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  BAD_ACTION: 'BAD_ACTION',
  BAD_AMOUNT: 'BAD_AMOUNT',
  SEAT_TAKEN: 'SEAT_TAKEN',
  NOT_HOST: 'NOT_HOST',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  // Playing needs an account. The table is where the money is recorded, and
  // every part of that record — the ledger across nights, the stacks carried
  // between them, the .csv mailed to the host — is keyed to an account. A
  // player without one is a hole in all of it.
  SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
};
