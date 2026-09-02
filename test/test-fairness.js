// Provably-fair RNG: the server shuffle and the browser verifier must agree
// exactly, the shuffle must be an unbiased permutation, and the commit/reveal
// must verify. If this suite fails, historical hands can no longer be audited.
// Usage: node test/test-fairness.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-fair-')), 'test.db');

import * as srv from '../server/fairness.js';
import * as web from '../shared/fairness.js';
import { initDb, closeDb } from '../server/db.js';
import { saveHand, getHand, updateHandShown } from '../server/handStore.js';

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

const SEED = 'abc123'.padEnd(64, '0');
const CLIENT = 'clientXYZ';

// ---- regression lock: the exact deck for a fixed vector must never drift ----
// (a change here means every previously recorded hand would fail to verify)
const SNAPSHOT = ["9h","8h","8s","3h","Jd","9d","8d","Kc","9s","5s","Qs","As","5h","Js","4h","Ts","6s","Jc","Ah","7d","9c","4d","4s","8c","5d","2d","2h","2s","Tc","7c","3s","3d","Td","Qc","Qd","7h","2c","3c","Ac","Kd","5c","Qh","6d","4c","Jh","6h","Th","Ks","7s","6c","Ad","Kh"];
check('server shuffle matches the frozen snapshot',
  JSON.stringify(srv.seededShuffle(SEED, CLIENT, 7)) === JSON.stringify(SNAPSHOT));

// ---- a shuffle is a valid 52-card permutation ----
{
  const deck = srv.seededShuffle(SEED, CLIENT, 1);
  const fresh = srv.freshOrder();
  check('deck has 52 cards', deck.length === 52);
  check('deck has no duplicates', new Set(deck).size === 52);
  check('deck is a permutation of a real deck',
    [...deck].sort().join(',') === [...fresh].sort().join(','));
}

// ---- deterministic in the seeds, sensitive to each of them ----
check('same seeds + nonce reproduce the same deck',
  JSON.stringify(srv.seededShuffle(SEED, CLIENT, 3)) === JSON.stringify(srv.seededShuffle(SEED, CLIENT, 3)));
check('a different nonce changes the deck',
  JSON.stringify(srv.seededShuffle(SEED, CLIENT, 3)) !== JSON.stringify(srv.seededShuffle(SEED, CLIENT, 4)));
check('a different client seed changes the deck',
  JSON.stringify(srv.seededShuffle(SEED, CLIENT, 3)) !== JSON.stringify(srv.seededShuffle(SEED, 'other', 3)));
check('a different server seed changes the deck',
  JSON.stringify(srv.seededShuffle(SEED, CLIENT, 3)) !== JSON.stringify(srv.seededShuffle(srv.newServerSeed(), CLIENT, 3)));

// ---- commit / proof / float ----
check('commit is SHA-256 of the server seed',
  srv.commitOf(SEED) === srv.sha256Hex(SEED) && /^[0-9a-f]{64}$/.test(srv.commitOf(SEED)));
check('the per-hand float is in [0,1)', (() => {
  const f = srv.floatFromHex(srv.handProof(SEED, CLIENT, 7));
  return f >= 0 && f < 1;
})());
check('the commit reveals nothing usable — seed is 64 hex chars of entropy',
  /^[0-9a-f]{64}$/.test(srv.newServerSeed()));

// ---- browser verifier agrees with the server, byte for byte ----
{
  const vectors = [[SEED, CLIENT, 1], [SEED, CLIENT, 2], [srv.newServerSeed(), 'zzz', 99], [SEED, '', 0]];
  let allMatch = true;
  let hashMatch = true;
  for (const [s, c, n] of vectors) {
    const a = srv.seededShuffle(s, c, n);
    const b = await web.seededShuffle(s, c, n);
    if (JSON.stringify(a) !== JSON.stringify(b)) allMatch = false;
    if ((await web.sha256Hex(`${s}:${c}:${n}`)) !== srv.sha256Hex(`${s}:${c}:${n}`)) hashMatch = false;
    if ((await web.handProof(s, c, n)) !== srv.handProof(s, c, n)) hashMatch = false;
  }
  check('browser and server shuffles are identical', allMatch);
  check('browser and server hashes are identical', hashMatch);
}

// ---- per-slot commitments: muck-safe selective disclosure ----
{
  const nonce = 42;
  const deck = srv.seededShuffle(SEED, CLIENT, nonce);
  const { deckCommit, slotCommits } = srv.buildCommitment(SEED, nonce, deck);
  check('a commitment is published for all 52 slots', slotCommits.length === 52);
  check('deckCommit is a hash over the slot commitments',
    deckCommit === srv.sha256Hex(slotCommits.join(':')) && /^[0-9a-f]{64}$/.test(deckCommit));

  // Server and browser agree on the commitment (byte for byte).
  let slotParity = true;
  for (let i = 0; i < 52; i++) {
    // openings carry the key; rebuild the same commit on the web side
    const key = srv.buildOpenings(SEED, nonce, deck, [deck[i]])[0].key;
    if ((await web.slotCommit(key, deck[i])) !== slotCommits[i]) slotParity = false;
  }
  check('browser recomputes each slot commitment identically', slotParity);

  // Open only the public cards (say the first 5 = a board); a folded hole card
  // (deck[7]) is deliberately NOT opened.
  const board = deck.slice(0, 5);
  const openings = srv.buildOpenings(SEED, nonce, deck, board);
  const good = await web.verifyReveal({ deckCommit, slotCommits, openings, publicCards: board });
  check('the deck commitment verifies', good.deckCommitOk === true);
  check('every opened public card is proven', good.allPublicProven === true && good.ok === true);

  // Muck safety: a card that was never opened is not proven, and its slot key
  // is not present anywhere in what a viewer receives.
  const muck = deck[7];
  check('an un-opened (folded) card is not among the proven cards', !good.provenCards.includes(muck));
  check('no opening leaks the folded slot', !openings.some((o) => o.i === 7));

  // Tampering is caught: swap a claimed card in an opening.
  const forged = openings.map((o, k) => (k === 0 ? { ...o, card: muck } : o));
  const bad = await web.verifyReveal({ deckCommit, slotCommits, openings: forged, publicCards: board });
  check('a forged opening fails verification', bad.ok === false);

  // A tampered commitment set is caught too.
  const badSet = [...slotCommits]; badSet[0] = 'deadbeef'.repeat(8);
  const bad2 = await web.verifyReveal({ deckCommit, slotCommits: badSet, openings, publicCards: board });
  check('a tampered commitment set fails verification', bad2.deckCommitOk === false && bad2.ok === false);
}

// ---- domain separation: a crafted client seed cannot alias the slot keys
//      onto the shuffle keystream and unmask mucked hands ----
{
  // The original break: shuffle blocks and slot keys were both HMAC(serverSeed,
  // …). Setting clientSeed to "slot" made the shuffle's message for block c
  // equal the slot key's message for position c, so the PUBLIC openings handed
  // an attacker the shuffle keystream — enough to replay the deck and read
  // mucked hands. With independent sub-keys, an opened slot key must never
  // equal the shuffle block for the same index, for ANY client seed.
  const nonce = 5;
  for (const evilClient of ['slot', 'pp-fair-v2|slot', 'slot:5', '']) {
    const deck = srv.seededShuffle(SEED, evilClient, nonce);
    const opening = srv.buildOpenings(SEED, nonce, deck, [deck[0]])[0]; // slot key for position 0
    const block0 = srv._shuffleBlockHex(SEED, evilClient, nonce, 0);   // shuffle keystream block 0
    check(`slot key never aliases the shuffle keystream (client="${evilClient}")`,
      opening.key !== block0 && opening.key !== block0.slice(0, opening.key.length));
  }
  // The exploit needed the shuffle's early keystream blocks (0..~6 cover all 51
  // draws). Confirm NONE of the opened public slot keys equals any of those
  // blocks — so an attacker holding every public opening still has zero
  // keystream to replay the deck with.
  const deck = srv.seededShuffle(SEED, 'slot', nonce);
  const openings = srv.buildOpenings(SEED, nonce, deck, deck.slice(0, 9));
  const streamBlocks = new Set(
    Array.from({ length: 8 }, (_, c) => srv._shuffleBlockHex(SEED, 'slot', nonce, c))
  );
  check('no opened slot key equals any shuffle keystream block',
    openings.every((o) => !streamBlocks.has(o.key)));
}

// ---- no modulo bias: first-card distribution is flat over many shuffles ----
{
  const counts = new Map();
  const N = 5200; // 100 expected per card
  for (let i = 0; i < N; i++) {
    const top = srv.seededShuffle(SEED, CLIENT, i)[0];
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  check('every one of the 52 cards appears on top at least once', counts.size === 52);
  // Expected 100 each; a correct unbiased shuffle stays comfortably in range.
  let withinBand = true;
  for (const c of srv.freshOrder()) {
    const n = counts.get(c) || 0;
    if (n < 50 || n > 160) withinBand = false;
  }
  check('top-card frequencies show no gross bias', withinBand);
}

// ---- persistence: commitment + public openings survive the DB, seed never
//      leaves the server, and a folded hand can be verified but not read ------

{
  initDb();
  const nonce = 1;
  const serverSeed = srv.newServerSeed();
  const clientSeed = 'friday-night';
  const game = {
    id: 'game-fair-1',
    handNo: nonce,
    hostAccountId: null,
    tableSessionId: null,
    settings: { variant: 'holdem', smallBlind: 1, bigBlind: 2 },
    players: new Map(),
    ledgerRows: () => [],
    fairness: { algo: srv.ALGO, serverSeed, serverCommit: srv.commitOf(serverSeed), clientSeed },
  };
  const deck = srv.seededShuffle(serverSeed, clientSeed, nonce);
  const proof = srv.handProof(serverSeed, clientSeed, nonce);
  const { deckCommit } = srv.buildCommitment(serverSeed, nonce, deck);
  const board = deck.slice(4, 9);
  // Ann shows (cards public); Bo folds and mucks (cards must stay sealed).
  const annCards = [deck[0], deck[2]];
  const boCards = [deck[1], deck[3]];
  const hand = {
    handNo: nonce, finished: true, revealed: true,
    variant: { key: 'holdem' },
    board,
    board2: null, rabbit: null,
    deck,
    timeline: [],
    players: [
      { seatIndex: 0, id: 'p0', accountId: null, nickname: 'Ann', handStartStack: 200,
        stack: 210, folded: false, allIn: false, showedCards: true,
        holeCards: annCards, handResult: { desc: 'a pair', won: 10 } },
      { seatIndex: 1, id: 'p1', accountId: null, nickname: 'Bo', handStartStack: 200,
        stack: 190, folded: true, allIn: false, showedCards: false,
        holeCards: boCards, handResult: { desc: null, won: 0 } },
    ],
    results: { pots: [{ amount: 20 }], winners: [{ seat: 0, amount: 20 }] },
    fairness: { algo: srv.ALGO, commit: srv.commitOf(serverSeed), clientSeed, nonce, proof,
      float: srv.floatFromHex(proof), deckCommit },
    // Each hand carries its own seed (never broadcast, never stored) — that is
    // what saveHand opens the public slots with.
    fairnessSeed: serverSeed,
  };

  const id = saveHand(game, hand);
  const rec = getHand(id);
  check('the record never carries the raw server seed', !('serverSeed' in (rec.fairness || {})) || rec.fairness.serverSeed == null);
  check('the record carries the deck commitment', rec.fairness?.deckCommit === deckCommit);
  check('the record carries all 52 slot commitments', rec.fairness?.slotCommits?.length === 52);
  check('the record opens the board and shown hands only',
    rec.fairness.openings.length === board.length + annCards.length);

  // Every opened card is public (board + Ann's shown cards); neither of Bo's
  // mucked cards is opened.
  const openedCards = new Set(rec.fairness.openings.map((o) => o.card));
  check('mucked cards are never opened',
    !openedCards.has(boCards[0]) && !openedCards.has(boCards[1]));

  const publicCards = [...board, ...annCards];
  const audit = await web.verifyReveal({
    deckCommit: rec.fairness.deckCommit,
    slotCommits: rec.fairness.slotCommits,
    openings: rec.fairness.openings,
    publicCards,
  });
  check('the browser verifies the commitment and every public card', audit.ok === true);
  check('mucked cards cannot be recovered from the record', !audit.provenCards.includes(boCards[0]));

  // A late voluntary show happens after the row is written. Re-opening the
  // record must publish exactly the newly-shown slots and nothing else, or the
  // browser verifier fails closed on a card it can now see.
  hand.players[1].showedCards = true;
  updateHandShown(id, hand);
  const reopened = getHand(id);
  check('a late show opens exactly the cards it made public',
    reopened.fairness.openings.length === board.length + annCards.length + boCards.length);
  const reopenedAudit = await web.verifyReveal({
    deckCommit: reopened.fairness.deckCommit,
    slotCommits: reopened.fairness.slotCommits,
    openings: reopened.fairness.openings,
    publicCards: [...board, ...annCards, ...boCards],
  });
  check('the browser still verifies after a late show', reopenedAudit.ok === true);
  hand.players[1].showedCards = false;
  updateHandShown(id, hand);
  const reclosed = getHand(id);
  check('un-showing narrows the openings back down',
    reclosed.fairness.openings.length === board.length + annCards.length);

  closeDb();
}

// ---- every hand is dealt from its own fresh randomness ----

{
  const { Game } = await import('../server/game.js');
  const g = new Game('rand-1');
  const seen = new Set();
  const commits = new Set();
  for (let i = 1; i <= 40; i++) {
    g.handNo = i;
    const f = g.fairnessForHand();
    seen.add(f.deck.join(''));
    commits.add(f.meta.commit);
    check(`hand ${i} deck is a full 52`, f.deck.length === 52 && new Set(f.deck).size === 52);
  }
  check('40 consecutive hands are 40 different decks', seen.size === 40);
  check('each hand commits to its own fresh seed', commits.size === 40);

  // Two tables that happen to share a client seed still deal differently:
  // nothing about the deal is derived from a stored table seed.
  const a = new Game('rand-a');
  const b = new Game('rand-b');
  a.fairness.clientSeed = 'same-seed';
  b.fairness.clientSeed = 'same-seed';
  a.handNo = 1; b.handNo = 1;
  check('same client seed + same hand number still differ across tables',
    a.fairnessForHand().deck.join('') !== b.fairnessForHand().deck.join(''));

  // Replaying the same table from scratch does not reproduce its cards.
  const c = new Game('rand-c');
  c.handNo = 1;
  check('the same table re-dealt gives a different hand',
    c.fairnessForHand().deck.join('') !== c.fairnessForHand().deck.join(''));
}

console.log(`fairness: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
