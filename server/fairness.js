// Provably-fair shuffling (server side, synchronous).
//
// The scheme, per table session:
//   • serverSeed  — 32 random bytes, SECRET until the table session closes.
//   • serverCommit = SHA-256(serverSeed) — published the moment the table
//     exists, and never changes for the life of the session. This is the
//     tamper-evidence anchor: the server is locked into one seed up front.
//   • clientSeed  — a public string any seated player can set. Because the
//     server committed to its seed BEFORE a player picks a client seed, a
//     player who sets their own client seed makes it impossible for the house
//     to have ground the shuffle in its favour.
//   • nonce       — the hand number, so every hand off the same seeds differs.
//
// Each hand's 52-card order is a deterministic function of
// (serverSeed, clientSeed, nonce). The per-hand PROOF shown live is
// SHA-256("serverSeed:clientSeed:nonce") and a [0,1) float derived from it —
// both are hashes, so they reveal nothing about the deck or the seed, yet once
// the seed is revealed at session close anyone can recompute them and re-derive
// the exact deck. shared/fairness.js is the independent browser verifier and is
// kept byte-for-byte identical to this file by test/test-fairness.js.

import { createHash, createHmac, randomBytes } from 'node:crypto';

export const ALGO = 'hmac-sha256-fy-v2';

// Canonical 52-card order. MUST match freshDeck() in deck.js and the copy in
// shared/fairness.js — the shuffle permutes this exact starting sequence.
const RANK_CHARS = '23456789TJQKA';
const SUIT_CHARS = 'cdhs';

export function freshOrder() {
  const deck = [];
  for (let r = 0; r < 13; r++) {
    for (let s = 0; s < 4; s++) deck.push(RANK_CHARS[r] + SUIT_CHARS[s]);
  }
  return deck;
}

export function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacBytes(keyStr, msgStr) {
  return createHmac('sha256', Buffer.from(keyStr, 'utf8')).update(msgStr, 'utf8').digest();
}

// Domain separation is load-bearing. The shuffle keystream and the per-slot
// commitment keys are BOTH HMACs under the server seed, so if they shared a key
// a player could set the client seed to a value that makes a slot message
// collide with a shuffle message — turning the public slot openings into the
// shuffle keystream and unmasking folded hands. We derive an independent
// sub-key for each purpose from the server seed, so their outputs are
// unrelated no matter what client seed is chosen.
const SHUFFLE_LABEL = 'pp-fair-v2|shuffle';
const SLOT_LABEL = 'pp-fair-v2|slot';

function subKey(serverSeed, label) {
  return hmacBytes(serverSeed, label).toString('hex');
}

// A lazy stream of bytes for the shuffle, keyed by a seed-derived shuffle
// sub-key (NOT the raw server seed). Uniform draws pull 4 bytes at a time with
// rejection sampling, so there is no modulo bias.
function byteStream(serverSeed, clientSeed, nonce) {
  const key = subKey(serverSeed, SHUFFLE_LABEL);
  let block = Buffer.alloc(0);
  let counter = 0;
  let offset = 0;
  return function next4() {
    while (offset + 4 > block.length) {
      const fresh = hmacBytes(key, `${clientSeed}:${nonce}:${counter}`);
      counter += 1;
      block = offset < block.length ? Buffer.concat([block.subarray(offset), fresh]) : fresh;
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  };
}

function uniformInt(next4, n) {
  // Largest multiple of n that fits in a uint32; values at or above it are
  // rejected so every residue is equally likely.
  const limit = Math.floor(0x100000000 / n) * n;
  let v = next4();
  while (v >= limit) v = next4();
  return v % n;
}

export function seededShuffle(serverSeed, clientSeed, nonce) {
  const deck = freshOrder();
  const next4 = byteStream(serverSeed, clientSeed, nonce);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = uniformInt(next4, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function commitOf(serverSeed) {
  return sha256Hex(serverSeed);
}

// Test-only: the raw hex of shuffle keystream block `counter`. Exposed so the
// security suite can assert a slot key never equals a shuffle block (the
// domain-separation guarantee). Reveals nothing not already derivable from the
// server seed, which is server-secret.
export function _shuffleBlockHex(serverSeed, clientSeed, nonce, counter) {
  return hmacBytes(subKey(serverSeed, SHUFFLE_LABEL), `${clientSeed}:${nonce}:${counter}`).toString('hex');
}

export function handProof(serverSeed, clientSeed, nonce) {
  return sha256Hex(`${serverSeed}:${clientSeed}:${nonce}`);
}

// A friendly [0,1) fingerprint from a hex hash: first 13 nibbles = 52 bits,
// which divides exactly by 2^52 and stays inside Number's safe-integer range.
export function floatFromHex(hex) {
  return parseInt(hex.slice(0, 13), 16) / 0x10000000000000;
}

export function newServerSeed() {
  return randomBytes(32).toString('hex');
}

export function newClientSeed() {
  return randomBytes(8).toString('hex');
}

// ---- per-slot commitments (muck-safe selective disclosure) ----
//
// The raw server seed is NEVER published — revealing it would re-derive the
// whole deck and expose folded hands. Instead, at hand start we commit to every
// one of the 52 positions with a per-slot blinding key derived from the (still
// secret) server seed, and publish only a single deckCommit hash over them.
// After the hand we OPEN just the public positions (the board and any cards
// shown down) by revealing their blinding key + card; each opened slot is
// checked against the commitment. Folded positions keep their key forever, so
// their cards can never be recovered — SHA-256(256-bit key | card) is not
// brute-forceable even though a card has only 52 possibilities.

function slotKey(serverSeed, nonce, i) {
  // Keyed by the SLOT sub-key, never the raw seed — see the domain-separation
  // note above. This is why no client-seed value can alias slot keys onto the
  // shuffle keystream.
  return hmacBytes(subKey(serverSeed, SLOT_LABEL), `${nonce}:${i}`).toString('hex');
}

export function slotCommit(slotKeyHex, card) {
  return sha256Hex(`${slotKeyHex}|${card}`);
}

// Commit to the full 52-card order. deckCommit is safe to publish the instant
// the hand starts — it locks every card in before any bet, yet reveals nothing.
export function buildCommitment(serverSeed, nonce, deck) {
  const slotCommits = deck.map((card, i) => slotCommit(slotKey(serverSeed, nonce, i), card));
  return { deckCommit: sha256Hex(slotCommits.join(':')), slotCommits };
}

// Open only the positions whose card is already public. Each card is located in
// the dealt deck (all 52 are distinct, so the index is unambiguous); folded
// hole cards are simply never passed in here.
export function buildOpenings(serverSeed, nonce, deck, publicCards) {
  const seen = new Set();
  const openings = [];
  for (const card of publicCards) {
    const i = deck.indexOf(card);
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    openings.push({ i, key: slotKey(serverSeed, nonce, i), card });
  }
  openings.sort((a, b) => a.i - b.i);
  return openings;
}
