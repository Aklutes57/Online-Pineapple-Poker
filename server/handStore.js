// Saves finished hands for the replayer and serves them back.
//
// Privacy rule, enforced twice: hands are written ONLY when the hand is over
// (saveHand is called from the hand-finished path and refuses an unfinished
// hand), and getHand refuses to return anything that is not complete. A row
// that could be read mid-hand would be a live hole-card oracle.

import { randomBytes } from 'node:crypto';
import { run, get, all, now } from './db.js';
import { ensureTableSession } from './stats.js';

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

  run(
    `INSERT INTO hands
       (id, table_session_id, hand_no, variant, board_json, timeline_json,
        players_json, winners_json, pot, cooler_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now()
  );
  return id;
}

// viewerAccountId reveals that participant's own cards; everyone else only
// ever sees what was actually shown down.
export function getHand(id, viewerAccountId = null) {
  const row = get('SELECT * FROM hands WHERE id = ?', id);
  if (!row) return null;

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

export function addHandReaction(handId, { emoji, accountId, nickname }) {
  if (!get('SELECT id FROM hands WHERE id = ?', handId)) {
    return { ok: false, error: 'no such hand' };
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
