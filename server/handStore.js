// Saves finished hands for the replayer and serves them back.
//
// Privacy rule, enforced twice: hands are written ONLY when the hand is over
// (saveHand is called from the hand-finished path and refuses an unfinished
// hand), and getHand refuses to return anything that is not complete. A row
// that could be read mid-hand would be a live hole-card oracle.

import { randomBytes } from 'node:crypto';
import { run, get, all, now } from './db.js';
import { ensureTableSession } from './stats.js';
import { buildCommitment, buildOpenings } from './fairness.js';

function newHandId() {
  return randomBytes(9).toString('base64url');
}

export function saveHand(game, hand) {
  if (!hand.finished) throw new Error('refusing to save an unfinished hand');

  const tableSessionId = ensureTableSession(game);
  const id = newHandId();

  // Only cards that were actually turned face up are stored as revealed;
  // everyone else's are kept for the participants' own replay view.
  const players = hand.players.map((p) => ({
    seat: p.seatIndex,
    playerId: p.id,
    accountId: p.accountId ?? null,
    nickname: p.nickname,
    startStack: p.handStartStack ?? 0,
    net: p.stack - (p.handStartStack ?? p.stack),
    folded: p.folded,
    allIn: p.allIn,
    // Same rule as the live view: a showdown reveals the hands still in it,
    // never the folded ones — those only go public by their owner's choice.
    shown: p.folded ? p.showedCards : hand.revealed || p.showedCards,
    cards: [...p.holeCards],
    desc: p.handResult?.desc ?? null,
    won: p.handResult?.won ?? 0,
  }));

  const pot = hand.results?.pots?.reduce((a, p) => a + p.amount, 0) ?? 0;

  // Provably-fair record. The raw server seed NEVER touches this row. Instead
  // we store the full per-slot commitment set plus openings for the cards that
  // were public this hand (board, extra boards, rabbit, and any shown hands) —
  // enough to verify every card seen, and nothing that could reconstruct a
  // folded hand.
  let fairnessRecord = null;
  if (hand.fairness && hand.fairnessSeed && Array.isArray(hand.deck)) {
    const serverSeed = hand.fairnessSeed;
    const { nonce } = hand.fairness;
    const { deckCommit, slotCommits } = buildCommitment(serverSeed, nonce, hand.deck);
    const publicCards = [
      ...(hand.board || []),
      ...(hand.board2 || []),
      ...(hand.rabbit || []),
      ...players.filter((p) => p.shown).flatMap((p) => p.cards),
    ].filter(Boolean);
    const openings = buildOpenings(serverSeed, nonce, hand.deck, publicCards);
    fairnessRecord = { ...hand.fairness, deckCommit, slotCommits, openings };
  } else if (hand.fairness) {
    fairnessRecord = { ...hand.fairness };
  }

  run(
    `INSERT INTO hands
       (id, table_session_id, hand_no, variant, board_json, timeline_json,
        players_json, winners_json, pot, cooler_json, created_at, fairness_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    tableSessionId,
    hand.handNo,
    hand.variant.key,
    JSON.stringify(hand.board),
    JSON.stringify(hand.timeline || []),
    JSON.stringify(players),
    JSON.stringify(hand.results?.winners ?? []),
    pot,
    hand.results?.cooler ? JSON.stringify(hand.results.cooler) : null,
    now(),
    fairnessRecord ? JSON.stringify(fairnessRecord) : null
  );
  return id;
}

// viewerAccountId reveals that participant's own cards; everyone else only
// ever sees what was actually shown down.
export function getHand(id, viewerAccountId = null) {
  const row = get('SELECT * FROM hands WHERE id = ?', id);
  if (!row) return null;

  // Fairness record: the per-slot commitment set and the openings for cards
  // that were public this hand. The raw server seed is never stored here or
  // returned, so folded hands can be verified-against but never reconstructed.
  let fairness = null;
  if (row.fairness_json) {
    const f = JSON.parse(row.fairness_json);
    fairness = { ...f, serverCommit: f.commit ?? null };
  }

  const players = JSON.parse(row.players_json).map((p) => {
    const visible = p.shown || (viewerAccountId && p.accountId === viewerAccountId);
    return {
      seat: p.seat,
      nickname: p.nickname,
      startStack: p.startStack,
      net: p.net,
      folded: p.folded,
      allIn: p.allIn,
      desc: p.shown ? p.desc : null,
      won: p.won,
      cards: visible ? p.cards : null,
      cardCount: p.cards.length,
    };
  });

  // Reveal events for cards nobody showed would leak through the timeline.
  const shownSeats = new Set(players.filter((p) => p.cards).map((p) => p.seat));
  const timeline = JSON.parse(row.timeline_json).filter(
    (e) => e.type !== 'reveal' || shownSeats.has(e.seat)
  );

  return {
    id: row.id,
    handNo: row.hand_no,
    variant: row.variant,
    board: JSON.parse(row.board_json),
    timeline,
    players,
    winners: JSON.parse(row.winners_json),
    pot: row.pot,
    cooler: row.cooler_json ? JSON.parse(row.cooler_json) : null,
    createdAt: row.created_at,
    reactions: listReactions(row.id),
    fairness,
  };
}

export function recentHandsForGame(gameId, limit = 20) {
  return all(
    `SELECT h.id, h.hand_no, h.pot, h.created_at, h.cooler_json
     FROM hands h JOIN table_sessions t ON t.id = h.table_session_id
     WHERE t.game_id = ? ORDER BY h.hand_no DESC LIMIT ?`,
    gameId, limit
  ).map((r) => ({
    id: r.id,
    handNo: r.hand_no,
    pot: r.pot,
    createdAt: r.created_at,
    cooler: r.cooler_json ? JSON.parse(r.cooler_json) : null,
  }));
}

// ---- reactions on saved hands ----

// A single hand never needs more than a handful of reactions; this ceiling
// stops a guest cycling arbitrary nicknames from writing unbounded rows.
const MAX_REACTIONS_PER_HAND = 200;

export function addHandReaction(handId, { emoji, accountId, nickname }) {
  if (!get('SELECT id FROM hands WHERE id = ?', handId)) {
    return { ok: false, error: 'no such hand' };
  }
  const { n } = get('SELECT COUNT(*) AS n FROM hand_reactions WHERE hand_id = ?', handId);
  if (n >= MAX_REACTIONS_PER_HAND) {
    return { ok: true, reactions: listReactions(handId) };
  }
  // One of each emoji per person per hand.
  const existing = get(
    `SELECT id FROM hand_reactions
     WHERE hand_id = ? AND emoji = ?
       AND ((account_id IS NOT NULL AND account_id = ?) OR (account_id IS NULL AND nickname = ?))`,
    handId, emoji, accountId ?? null, nickname
  );
  if (existing) return { ok: true, reactions: listReactions(handId) };

  run(
    'INSERT INTO hand_reactions (hand_id, account_id, nickname, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
    handId, accountId ?? null, nickname, emoji, now()
  );
  return { ok: true, reactions: listReactions(handId) };
}

export function listReactions(handId) {
  const rows = all(
    'SELECT emoji, nickname FROM hand_reactions WHERE hand_id = ? ORDER BY created_at',
    handId
  );
  const counts = new Map();
  for (const row of rows) {
    const entry = counts.get(row.emoji) || { emoji: row.emoji, count: 0, who: [] };
    entry.count++;
    entry.who.push(row.nickname);
    counts.set(row.emoji, entry);
  }
  return [...counts.values()];
}
