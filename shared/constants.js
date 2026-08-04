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
  SHOW_CARDS: 'showCards',
  SIT_OUT: 'sitOut',
  SIT_IN: 'sitIn',
  STAND_UP: 'standUp',
  CHAT: 'chat',
  REACT: 'react',
  SET_PREACTION: 'setPreAction',
  RABBIT_HUNT: 'rabbitHunt',
  DECISION_747: 'decision747',
  SET_CLIENT_SEED: 'setClientSeed',
  SET_NAME_FONT: 'setNameFont',
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
  // 747 engine phases
  DECISION_747: 'decision747',
  COUNTDOWN_747: 'countdown747',
};

// Each variant declares: which engine runs the hand ('community' is the
// betting-rounds engine, '747' the dealer-vs-players engine), hole cards
// dealt, where the discard phase slots in (null = no discard), and betting
// style.
export const VARIANTS = {
  holdem: {
    key: 'holdem',
    label: "Texas Hold'em",
    holeCards: 2,
    discardBefore: null,
    potLimit: false,
  },
  pineapple: {
    key: 'pineapple',
    label: 'Pineapple',
    holeCards: 3,
    // Throw a card away first, then bet: the preflop round is played with the
    // two cards you are keeping.
    discardBefore: 'preflop',
    potLimit: false,
  },
  crazyPineapple: {
    key: 'crazyPineapple',
    label: 'Crazy Pineapple',
    holeCards: 3,
    // Bet preflop holding all three, then discard the moment the flop lands —
    // before the flop betting round.
    discardBefore: 'flop',
    potLimit: false,
  },
  plo: {
    key: 'plo',
    label: 'Pot Limit Omaha',
    holeCards: 4,
    discardBefore: null,
    potLimit: true,
    omaha: true, // must use exactly 2 hole cards
  },
  '747': {
    key: '747',
    label: '747 Poker',
    engine: '747',
    holeCards: 4, // plus a fifth card for players who stay
    discardBefore: null,
    potLimit: false,
    // Ante-based dealer game: no blinds, no betting rounds. The ante is the
    // table's big-blind setting, everyone plays the house dealer hand,
    // fours are wild, and two natural sevens in the first four cards win
    // outright. If the dealer beats everyone, the pot rides to the next
    // 747 hand.
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
  sevenDeuceBounty: 0, // chips each opponent pays for a win with 7-2
};

// Not a gameplay cap — blinds and buy-ins are host's choice, uncapped. This
// only bounds chip amounts so a full table's pot always sums in exact
// integers (10 × MAX_CHIPS is still well inside Number.MAX_SAFE_INTEGER);
// past that, conservation checks would rot from float rounding.
export const MAX_CHIPS = 100_000_000_000_000;

export const SETTINGS_LIMITS = {
  nickname: { min: 1, max: 20 },
  smallBlind: { min: 1, max: MAX_CHIPS },
  bigBlind: { min: 2, max: MAX_CHIPS },
  buyIn: { min: 1, max: MAX_CHIPS },
  actionTimes: [0, 15, 30, 60],
  chatLength: 300,
};

export const TIMINGS = {
  DISCARD_TIME: 15000, // ms for the pineapple discard decision
  RIT_VOTE_TIME: 12000, // ms to answer 'run it twice?' — no answer means no
  DISCARD_NO_CLOCK: 300000, // untimed tables still need a stall fallback
  NUDGE_GRACE: 15000, // ms a nudged player gets before the host's prod lands
  COUNTDOWN_747: 3200, // the 3-2-1 before stay/fold choices are revealed
  NEXT_HAND_DELAY: 4000, // ms between hands
  RUNOUT_STREET_DELAY: 1500, // ms between streets on an all-in run-out
  AWAY_GRACE: 1000, // ms before auto-acting for a sitting-out player
  DISCONNECT_GRACE: 60000, // ms a disconnected player gets when the action timer is off
  HOST_TRANSFER_AFTER: 120000, // ms of host disconnect before host passes
};

// Percentage {left, top} anchors for the 10 seats around the oval table.
// Index 0 is bottom-center; clockwise when viewed on screen.
export const SEAT_COORDS = [
  { left: 50, top: 97 },
  { left: 25, top: 90 },
  { left: 11, top: 66 },
  { left: 11, top: 32 },
  { left: 25, top: 8 },
  { left: 50, top: 1 },
  { left: 75, top: 8 },
  { left: 89, top: 32 },
  { left: 89, top: 66 },
  { left: 75, top: 90 },
];

// The same ring for a table stood on its end — used when the screen is taller
// than it is wide (a phone held upright), so the felt becomes a vertical oval
// with the seats around it instead of a letterboxed landscape table. Index 0 is
// still bottom-center (always you), still clockwise.
// The side seats sit further in than a simple ellipse would put them: a seat
// pod is a much larger share of this narrower felt, so hugging the rim would
// leave them dangling in space beside the table.
export const SEAT_COORDS_PORTRAIT = [
  { left: 50, top: 97 },
  { left: 28, top: 88 },
  { left: 17, top: 65 },
  { left: 17, top: 35 },
  { left: 28, top: 12 },
  { left: 50, top: 3 },
  { left: 72, top: 12 },
  { left: 83, top: 35 },
  { left: 83, top: 65 },
  { left: 72, top: 88 },
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
export const BET_COORDS_PORTRAIT = [
  { left: 50, top: 80 },
  { left: 36, top: 74 },
  { left: 27, top: 59 },
  { left: 27, top: 41 },
  { left: 36, top: 26 },
  { left: 50, top: 20 },
  { left: 64, top: 26 },
  { left: 73, top: 41 },
  { left: 73, top: 59 },
  { left: 64, top: 74 },
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
};
