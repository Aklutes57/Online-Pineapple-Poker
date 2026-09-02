// Provably-fair verifier (browser side, asynchronous WebCrypto).
//
// This is the INDEPENDENT auditor: given a hand's revealed seeds it re-runs the
// exact shuffle in the player's own browser, confirms the server seed matches
// the commitment that was published during the hand, and reproduces the deck
// that was dealt. It uses only the platform's SubtleCrypto — no trust in the
// server code. It is kept byte-for-byte equivalent to server/fairness.js by
// test/test-fairness.js, which runs BOTH implementations (this one works under
// Node's global WebCrypto too) and asserts identical output.

export const ALGO = 'hmac-sha256-fy-v2';

const RANK_CHARS = '23456789TJQKA';
const SUIT_CHARS = 'cdhs';

export function freshOrder() {
  const deck = [];
  for (let r = 0; r < 13; r++) {
    for (let s = 0; s < 4; s++) deck.push(RANK_CHARS[r] + SUIT_CHARS[s]);
  }
  return deck;
}

const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return toHex(new Uint8Array(digest));
}

async function hmacBytes(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msgStr));
  return new Uint8Array(sig);
}

// Matches the server's domain separation: the shuffle stream is keyed by a
// seed-derived sub-key, independent of the per-slot commitment keys.
const SHUFFLE_LABEL = 'pp-fair-v2|shuffle';

async function subKey(serverSeed, label) {
  return toHex(await hmacBytes(serverSeed, label));
}

// Async twin of the server's byteStream: block c = HMAC(shuffleSubKey,
// "clientSeed:nonce:c"), consumed 4 bytes at a time.
function byteStream(serverSeed, clientSeed, nonce) {
  let block = new Uint8Array(0);
  let counter = 0;
  let offset = 0;
  let key = null;
  return async function next4() {
    if (key === null) key = await subKey(serverSeed, SHUFFLE_LABEL);
    while (offset + 4 > block.length) {
      const fresh = await hmacBytes(key, `${clientSeed}:${nonce}:${counter}`);
      counter += 1;
      if (offset < block.length) {
        const merged = new Uint8Array(block.length - offset + fresh.length);
        merged.set(block.subarray(offset), 0);
        merged.set(fresh, block.length - offset);
        block = merged;
      } else {
        block = fresh;
      }
      offset = 0;
    }
    const v = (block[offset] * 0x1000000) + (block[offset + 1] << 16) + (block[offset + 2] << 8) + block[offset + 3];
    offset += 4;
    return v >>> 0;
  };
}

async function uniformInt(next4, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  let v = await next4();
  while (v >= limit) v = await next4();
  return v % n;
}

export async function seededShuffle(serverSeed, clientSeed, nonce) {
  const deck = freshOrder();
  const next4 = byteStream(serverSeed, clientSeed, nonce);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = await uniformInt(next4, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function commitOf(serverSeed) {
  return sha256Hex(serverSeed);
}

export function handProof(serverSeed, clientSeed, nonce) {
  return sha256Hex(`${serverSeed}:${clientSeed}:${nonce}`);
}

export function floatFromHex(hex) {
  return parseInt(hex.slice(0, 13), 16) / 0x10000000000000;
}

export async function slotCommit(slotKeyHex, card) {
  return sha256Hex(`${slotKeyHex}|${card}`);
}

// Muck-safe audit for the replay page. Recomputes the deck commitment from the
// published per-slot commitments, then re-derives each OPENED (public) slot's
// commitment from its revealed key+card and checks it against the set. Folded
// positions are never opened, so their cards stay sealed. Confirms every card
// that was visible this hand (board + shown hands) is among the proven slots.
export async function verifyReveal({ deckCommit, slotCommits, openings, publicCards = [] }) {
  const deckCommitOk = (await sha256Hex((slotCommits || []).join(':'))) === deckCommit;

  const proven = new Set();
  let openingsOk = (openings || []).length > 0 || publicCards.length === 0;
  for (const o of openings || []) {
    const expect = slotCommits?.[o.i];
    const got = await slotCommit(o.key, o.card);
    if (expect && got === expect) proven.add(o.card);
    else openingsOk = false;
  }

  const allPublicProven = publicCards.every((c) => proven.has(c));
  return {
    deckCommitOk,
    openingsOk,
    allPublicProven,
    provenCards: [...proven],
    ok: deckCommitOk && openingsOk && allPublicProven,
  };
}
