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
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  COMPLETE: 'complete',
};

// Each variant declares: hole cards dealt, where the discard phase slots in
// (null = no discard), and betting style.
export const VARIANTS = {
  holdem: {
    key: 'holdem',
    label: "Texas Hold'em",
    holeCards: 2,
    discardAfter: null,
    potLimit: false,
  },
  pineapple: {
    key: 'pineapple',
    label: 'Pineapple',
    holeCards: 3,
    discardAfter: 'preflop', // discard one before the flop is dealt
    potLimit: false,
  },
  crazyPineapple: {
    key: 'crazyPineapple',
    label: 'Crazy Pineapple',
    holeCards: 3,
    discardAfter: 'flop', // discard one after the flop betting round
    potLimit: false,
  },
  plo: {
    key: 'plo',
    label: 'Pot Limit Omaha',
    holeCards: 4,
    discardAfter: null,
    potLimit: true,
    omaha: true, // must use exactly 2 hole cards
  },
};

export const DEFAULT_SETTINGS = {
  variant: 'holdem',
  smallBlind: 1,
  bigBlind: 2,
  defaultBuyIn: 200,
  minBuyIn: 40,
  maxBuyIn: 1000,
  actionTime: 30, // seconds; 0 = no limit
};

export const SETTINGS_LIMITS = {
  nickname: { min: 1, max: 20 },
  smallBlind: { min: 1, max: 1000000 },
  bigBlind: { min: 2, max: 2000000 },
  buyIn: { min: 1, max: 100000000 },
  actionTimes: [0, 15, 30, 60],
  chatLength: 300,
};

export const TIMINGS = {
  DISCARD_TIME: 15000, // ms for the pineapple discard decision
  NEXT_HAND_DELAY: 4000, // ms between hands
  RUNOUT_STREET_DELAY: 1500, // ms between streets on an all-in run-out
  AWAY_GRACE: 1000, // ms before auto-acting for a sitting-out player
  HOST_TRANSFER_AFTER: 120000, // ms of host disconnect before host passes
};

// Percentage {left, top} anchors for the 10 seats around the oval table.
// Index 0 is bottom-center; clockwise when viewed on screen.
export const SEAT_COORDS = [
  { left: 50, top: 97 },
  { left: 23, top: 90 },
  { left: 7, top: 66 },
  { left: 7, top: 32 },
  { left: 23, top: 8 },
  { left: 50, top: 1 },
  { left: 77, top: 8 },
  { left: 93, top: 32 },
  { left: 93, top: 66 },
  { left: 77, top: 90 },
];

// Where each seat's bet chips render, pulled toward the table center.
export const BET_COORDS = [
  { left: 50, top: 76 },
  { left: 30, top: 72 },
  { left: 17, top: 58 },
  { left: 17, top: 38 },
  { left: 30, top: 24 },
  { left: 50, top: 22 },
  { left: 70, top: 24 },
  { left: 83, top: 38 },
  { left: 83, top: 58 },
  { left: 70, top: 72 },
];

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
