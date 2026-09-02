// Persists table results and poker statistics.
//
// Two separate things live here:
//  - session results: every participant's buy-ins/cash-outs/net for a table,
//    recorded whether or not they have an account (guests are stored by
//    nickname so a table's ledger is always complete).
//  - player stats: running aggregates per account (VPIP, PFR, 3-bet, went to
//    showdown, won at showdown, aggression). Aggregates rather than derived
//    sums, so the profile page is a single row read no matter how many hands
//    have been played.

import { run, get, all, now } from './db.js';
import { BUY_IN_CAP } from '../shared/constants.js';
import { settleUp, payeeLabeller } from '../shared/settle.js';
import { buildXlsx, ledgerSheet, LEDGER_WIDTHS } from '../shared/xlsx.js';

// The database speaks snake_case and every export speaks camelCase; one
// place to cross over, so the CSV and the spreadsheet cannot drift apart.
function shapeLedgerRows(rows) {
  return rows.map((r) => ({
    playerId: r.player_id,
    nickname: r.nickname,
    realName: r.real_name,
    buyIns: r.buy_ins,
    cashOuts: r.cash_outs,
    stack: r.final_stack,
    net: r.net,
    handsPlayed: r.hands_played,
  }));
}

export function ensureTableSession(game) {
  if (game.tableSessionId) return game.tableSessionId;
  const existing = get('SELECT id FROM table_sessions WHERE game_id = ?', game.id);
  if (existing) {
    game.tableSessionId = existing.id;
    return existing.id;
  }
  const result = run(
    `INSERT INTO table_sessions
       (game_id, host_account_id, variant, small_blind, big_blind, started_at, hands_played,
        fairness_server_seed, fairness_server_commit)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    game.id,
    game.hostAccountId ?? null,
    game.settings.variant,
    game.settings.smallBlind,
    game.settings.bigBlind,
    now(),
    // The raw server seed is deliberately NOT persisted — verification uses the
    // per-hand commitments/openings written by saveHand, so nothing that could
    // reconstruct a folded hand ever touches the database. Only the public
    // commitment is kept, for reference.
    null,
    game.fairness?.serverCommit ?? null
  );
  game.tableSessionId = Number(result.lastInsertRowid);
  return game.tableSessionId;
}

// Mirrors the live in-game ledger into the database. Called after every hand
// and at table close, so a crashed process still leaves an accurate record.
export function syncSessionResults(game) {
  const tableSessionId = ensureTableSession(game);
  const ts = now();
  for (const row of game.ledgerRows()) {
    const player = game.players.get(row.playerId);
    run(
      `INSERT INTO session_results
         (table_session_id, account_id, player_id, nickname, real_name, buy_ins, cash_outs, final_stack, net, hands_played, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(table_session_id, player_id) DO UPDATE SET
         account_id = excluded.account_id,
         nickname = excluded.nickname,
         real_name = excluded.real_name,
         buy_ins = excluded.buy_ins,
         cash_outs = excluded.cash_outs,
         final_stack = excluded.final_stack,
         net = excluded.net,
         hands_played = excluded.hands_played,
         updated_at = excluded.updated_at`,
      tableSessionId,
      player?.accountId ?? null,
      row.playerId,
      row.nickname,
      row.realName ?? null,
      row.buyIns,
      row.cashOuts,
      row.stack,
      row.net,
      player?.handsPlayed ?? 0,
      ts
    );
  }
  run('UPDATE table_sessions SET hands_played = ? WHERE id = ?', game.handNo, tableSessionId);
}

export function closeTableSession(game) {
  if (!game.tableSessionId) return;
  syncSessionResults(game);
  run('UPDATE table_sessions SET ended_at = ? WHERE id = ?', now(), game.tableSessionId);
}

// Builds the dated ledger CSV for a game from its persisted results, so it can
// be pulled long after the table is gone. Returns { filename, body } or null.
export function ledgerCsvForGame(gameId) {
  const session = get(
    `SELECT id, variant, small_blind, big_blind, started_at, hands_played
     FROM table_sessions WHERE game_id = ?`,
    gameId
  );
  if (!session) return null;
  const rows = all(
    `SELECT player_id, nickname, real_name, buy_ins, cash_outs, final_stack, net, hands_played
     FROM session_results WHERE table_session_id = ? ORDER BY net DESC`,
    session.id
  );
  if (!rows.length) return null;

  const iso = new Date(session.started_at).toISOString().slice(0, 10);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const settleLabel = payeeLabeller(shapeLedgerRows(rows));
  const lines = [
    ['Reg-Poker Online ledger'],
    ['Game', gameId],
    ['Date', iso],
    ['Variant', session.variant],
    ['Blinds', `${session.small_blind}/${session.big_blind}`],
    [],
    // Two name columns: who is settled up with, and who they played as.
    ['Name', 'Username', 'Buy-ins', 'Cash-outs', 'Final stack', 'Hands', 'Net'],
    ...rows.map((r) => [
      r.real_name || r.nickname, r.nickname,
      r.buy_ins, r.cash_outs, r.final_stack, r.hands_played, r.net,
    ]),
    [],
    ['Settle up: from', 'to', 'amount'],
  
    ...settleUp(shapeLedgerRows(rows))
      .map((p) => [settleLabel(p.fromId, p.from), settleLabel(p.toId, p.to), p.amount]),
  ];
  const body = lines.map((cols) => cols.map(esc).join(',')).join('\r\n');
  return {
    filename: `pineapple-ledger-${iso}.csv`,
    body,
    // Everything a caller needs to describe this ledger without re-querying:
    // the emailed copy names the game by its date in the subject line.
    iso,
    startedAt: session.started_at,
    variant: session.variant,
    blinds: `${session.small_blind}/${session.big_blind}`,
    players: rows.length,
    hands: session.hands_played || 0,
  };
}

// The same saved ledger as a coloured spreadsheet: winners green, losers red.
// Built from the persisted rows, so it outlives the table exactly as the CSV
// does. Returns { filename, body: Uint8Array } or null.
export function ledgerXlsxForGame(gameId) {
  const session = get(
    `SELECT id, variant, small_blind, big_blind, started_at
     FROM table_sessions WHERE game_id = ?`,
    gameId
  );
  if (!session) return null;
  const rows = all(
    `SELECT player_id, nickname, real_name, buy_ins, cash_outs, final_stack, net, hands_played
     FROM session_results WHERE table_session_id = ? ORDER BY net DESC`,
    session.id
  );
  if (!rows.length) return null;

  const iso = new Date(session.started_at).toISOString().slice(0, 10);
  const shaped = shapeLedgerRows(rows);
  const label = payeeLabeller(shaped);
  const body = buildXlsx(
    ledgerSheet(shaped, {
      meta: [
        ['Game', gameId],
        ['Date', iso],
        ['Variant', session.variant],
        ['Blinds', `${session.small_blind}/${session.big_blind}`],
      ],
      // Same disambiguation the CSV has always had: this is the block people
      // actually pay from, so two players called John Smith must not both
      // appear as "John Smith".
      settle: settleUp(shaped).map((p) => ({
        ...p, from: label(p.fromId, p.from), to: label(p.toId, p.to),
      })),
    }),
    { widths: LEDGER_WIDTHS }
  );
  return { filename: `reg-poker-ledger-${iso}.xlsx`, body };
}

// Rolls one finished hand's per-player flags into each account's aggregates.
export function recordHandStats(game, hand) {
  for (const player of hand.players) {
    if (!player.accountId) continue;
    const s = player.handStats;
    if (!s) continue;
    const delta = player.stack - (player.handStartStack ?? player.stack);
    const won = delta > 0 ? 1 : 0;
    const potSize = hand.results?.pots?.reduce((a, p) => a + p.amount, 0) ?? 0;
    // "Best hand ever made": the strongest five this player actually held, even
    // if the table never saw it. Falls back to the shown-down score for hands
    // recorded before the engine tracked made hands.
    const bestScore = s.madeScore || s.showdownScore || 0;
    const bestDesc = s.madeScore ? s.madeDesc : (player.handResult?.desc ?? null);

    ensureStatsRow(player.accountId);
    run(
      `UPDATE player_stats SET
         hands_dealt = hands_dealt + 1,
         vpip_hands = vpip_hands + ?,
         pfr_hands = pfr_hands + ?,
         three_bet_hands = three_bet_hands + ?,
         three_bet_ops = three_bet_ops + ?,
         saw_flop_hands = saw_flop_hands + ?,
         wtsd_hands = wtsd_hands + ?,
         wsd_hands = wsd_hands + ?,
         aggressive_actions = aggressive_actions + ?,
         passive_actions = passive_actions + ?,
         hands_won = hands_won + ?,
         net_chips = net_chips + ?,
         biggest_pot = MAX(biggest_pot, ?),
         best_hand_score = MAX(best_hand_score, ?),
         best_hand_desc = CASE WHEN ? > best_hand_score THEN ? ELSE best_hand_desc END,
         updated_at = ?
       WHERE account_id = ?`,
      s.vpip ? 1 : 0,
      s.pfr ? 1 : 0,
      s.threeBet ? 1 : 0,
      s.threeBetOp ? 1 : 0,
      s.sawFlop ? 1 : 0,
      s.wtsd ? 1 : 0,
      s.wsd ? 1 : 0,
      s.aggressive,
      s.passive,
      won,
      delta,
      won ? potSize : 0,
      bestScore,
      bestScore,
      bestDesc,
      now(),
      player.accountId
    );
  }
}

function ensureStatsRow(accountId) {
  run(
    'INSERT INTO player_stats (account_id, updated_at) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING',
    accountId,
    now()
  );
}

// What people finished the host's last closed table with, so a new table can
// pick up where that one left off.
//
// Accounts only, by decision and by necessity: player_id is generated per game
// and never matches across nights, so a guest could only be matched by the
// name they happened to type — and handing somebody else's stack to the wrong
// person is not a mistake worth risking to save them a buy-in. Guests buy in
// normally, and the UI says so before anyone sits down.
export function lastTableStacks(hostAccountId) {
  if (!hostAccountId) return null;
  const session = get(
    `SELECT id, game_id, variant, small_blind, big_blind, ended_at
       FROM table_sessions
      WHERE host_account_id = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC, id DESC
      LIMIT 1`,
    hostAccountId
  );
  if (!session) return null;
  const players = all(
    `SELECT account_id, nickname, real_name, final_stack
       FROM session_results
      WHERE table_session_id = ? AND account_id IS NOT NULL AND final_stack > 0
      ORDER BY final_stack DESC`,
    session.id
  ).map((r) => ({
    accountId: r.account_id,
    nickname: r.nickname,
    realName: r.real_name,
    // Clamped like every other way money enters a table. A stack that grew
    // past the cap by winning pots does not get to re-enter above it.
    stack: Math.min(r.final_stack, BUY_IN_CAP),
  }));
  return {
    tableSessionId: session.id,
    gameId: session.game_id,
    endedAt: session.ended_at,
    variant: session.variant,
    blinds: `${session.small_blind}/${session.big_blind}`,
    players,
  };
}

// The running tab across every night this host has run: each player's net
// summed over all their finished sessions at this host's tables, and the
// settle-up that squares the whole lot rather than one evening of it.
//
// Accounts only, for the same reason carrying a stack over is: player_id is
// generated per game, so a guest cannot be followed from one night to the
// next. Guests still settle inside each session's own ledger; they just do not
// appear in the running total, and the UI says so.
//
// Carrying stacks over does not distort this. A session's net is measured
// against whatever that session was bought in for, so a night you carried 640
// into and left with 500 is -140, and the +440 that produced the 640 is still
// on the previous night's row. The sum is the true position either way.
export function runningTotals(hostAccountId) {
  if (!hostAccountId) return null;
  // The bare nickname/real_name columns come from the row MAX(ended_at)
  // selected — SQLite's documented behaviour for a min/max aggregate — so a
  // player is named by whatever they were called most recently.
  const rows = all(
    `SELECT r.account_id, r.nickname, r.real_name,
            SUM(r.net) AS net, COUNT(*) AS sessions, MAX(t.ended_at) AS last_played
       FROM session_results r
       JOIN table_sessions t ON t.id = r.table_session_id
      WHERE t.host_account_id = ?
        AND t.ended_at IS NOT NULL
        AND r.account_id IS NOT NULL
      GROUP BY r.account_id
      ORDER BY net DESC`,
    hostAccountId
  ).map((r) => ({
    // settleUp keys payments on playerId, so the account id travels as the id
    // — names are free text and two people can share one.
    playerId: `acct:${r.account_id}`,
    accountId: r.account_id,
    nickname: r.nickname,
    realName: r.real_name,
    net: r.net,
    sessions: r.sessions,
    lastPlayed: r.last_played,
    // What has actually changed hands against this tab, kept apart from what
    // the cards did. `net` stays the poker result for ever; `outstanding` is
    // what is still owed once the money people handed over is taken off.
    paid: 0,
    received: 0,
    outstanding: r.net,
  }));

  const nights = get(
    `SELECT COUNT(*) AS n FROM table_sessions
      WHERE host_account_id = ? AND ended_at IS NOT NULL`,
    hostAccountId
  );

  // Money already handed over comes off the tab. Paying somebody moves the
  // payer toward square from below and the payee toward square from above, so
  // both sides of a settled debt land on nothing outstanding.
  const payments = listSettlePayments(hostAccountId);
  const byAccount = new Map(rows.map((r) => [r.accountId, r]));
  for (const p of payments) {
    const from = byAccount.get(p.fromAccountId);
    const to = byAccount.get(p.toAccountId);
    if (from) from.paid += p.amount;
    if (to) to.received += p.amount;
  }
  for (const r of rows) r.outstanding = r.net + r.paid - r.received;

  return {
    nights: nights?.n ?? 0,
    players: rows,
    payments,
    // Same routine the per-session ledger uses, run over what is still owed
    // rather than over the raw results — otherwise it would keep asking for
    // money that has already been handed over.
    settle: settleUp(rows.map((r) => ({ ...r, net: r.outstanding }))),
  };
}

// ---- settling the running tab ----

export const SETTLE_LIMITS = {
  note: 120,
  // Far above any tab a home game will ever run up, and far below the point
  // where these stop summing exactly. It is here so a slipped keyboard cannot
  // poison a ledger that has no other way to be corrected.
  amount: 1_000_000_000,
};

// Everyone who has a running total at this host's tables — the people whose
// balances can be squared against each other. A payment to anybody else is
// refused, not out of suspicion but because a name that is not on the tab
// cannot be settled by paying it.
function ledgerMembers(hostAccountId) {
  return new Set(
    all(
      `SELECT DISTINCT r.account_id AS id
         FROM session_results r
         JOIN table_sessions t ON t.id = r.table_session_id
        WHERE t.host_account_id = ?
          AND t.ended_at IS NOT NULL
          AND r.account_id IS NOT NULL`,
      hostAccountId
    ).map((r) => r.id)
  );
}

// Who may read this host's running tab from their profile: the host, and
// anybody who has finished a night at their tables. It spans evenings a
// stranger with a table link was never at.
export function canSeeLedger(hostAccountId, accountId) {
  if (!hostAccountId || !accountId) return false;
  if (hostAccountId === accountId) return true;
  return ledgerMembers(hostAccountId).has(accountId);
}

// Every running tab this account belongs to. A tab belongs to a host, not to
// a player: somebody who plays at two homes has two of them and they never
// mix, so the profile page has to ask which one before it can show anything.
export function hostLedgersFor(accountId) {
  if (!accountId) return [];
  const byHost = new Map();
  const put = (id, patch) => {
    byHost.set(id, { ...(byHost.get(id) || { hostId: id, hosted: false, nights: 0, net: 0, lastPlayed: 0 }), ...patch });
  };

  for (const r of all(
    `SELECT t.host_account_id AS host_id, a.display_name AS host_name,
            COUNT(*) AS nights, SUM(r.net) AS net, MAX(t.ended_at) AS last_played
       FROM session_results r
       JOIN table_sessions t ON t.id = r.table_session_id
       JOIN accounts a ON a.id = t.host_account_id
      WHERE r.account_id = ? AND t.ended_at IS NOT NULL AND t.host_account_id IS NOT NULL
      GROUP BY t.host_account_id`,
    accountId
  )) {
    put(r.host_id, {
      hostName: r.host_name, hosted: r.host_id === accountId,
      nights: r.nights, net: r.net, lastPlayed: r.last_played,
    });
  }

  // A host who ran a night without sitting in it still keeps that tab, and
  // still has to be able to open it.
  for (const r of all(
    `SELECT t.host_account_id AS host_id, a.display_name AS host_name,
            MAX(t.ended_at) AS last_played
       FROM table_sessions t
       JOIN accounts a ON a.id = t.host_account_id
      WHERE t.host_account_id = ? AND t.ended_at IS NOT NULL
      GROUP BY t.host_account_id`,
    accountId
  )) {
    const seen = byHost.get(r.host_id);
    put(r.host_id, {
      hostName: r.host_name,
      hosted: true,
      lastPlayed: Math.max(seen?.lastPlayed || 0, r.last_played || 0),
    });
  }

  return [...byHost.values()].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

// Money that actually changed hands, against the tab rather than at a table.
// `from` handed `to` this much; part payments are ordinary rows, so "gave me
// 50 of the 250" is one row and not a special case.
export function recordSettlePayment({
  hostAccountId, fromAccountId, toAccountId, amount, note = null, recordedBy = null,
}) {
  const host = Number(hostAccountId);
  const from = Number(fromAccountId);
  const to = Number(toAccountId);
  const value = Number(amount);
  const who = recordedBy == null ? null : Number(recordedBy);
  if (!Number.isInteger(host) || !Number.isInteger(from) || !Number.isInteger(to)) {
    return { ok: false, error: 'Pick who paid whom' };
  }
  if (from === to) return { ok: false, error: 'A payment needs two different people' };
  if (!Number.isInteger(value) || value <= 0) return { ok: false, error: 'Enter an amount above zero' };
  if (value > SETTLE_LIMITS.amount) return { ok: false, error: 'That amount is too large' };

  const members = ledgerMembers(host);
  if (!members.has(from) || !members.has(to)) {
    return { ok: false, error: 'Both players need a finished night at this host\'s tables' };
  }
  // Only the two people the money moved between may mark it off. They are the
  // ones who know whether it happened — the host is not a witness to a payment
  // between two other players, and hosting a table is not a licence to declare
  // somebody else's debt settled. A host who is in the payment records it like
  // anyone else, which in a home game is most of them.
  if (who !== from && who !== to) {
    return { ok: false, error: 'Only the payer or the payee can mark that paid' };
  }

  const text = typeof note === 'string'
    ? note.replace(/\s+/g, ' ').trim().slice(0, SETTLE_LIMITS.note) || null
    : null;
  const result = run(
    `INSERT INTO settle_payments
       (host_account_id, from_account_id, to_account_id, amount, note, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    host, from, to, value, text, who, now()
  );
  return { ok: true, id: Number(result.lastInsertRowid) };
}

export function listSettlePayments(hostAccountId) {
  if (!hostAccountId) return [];
  return all(
    `SELECT p.id, p.from_account_id, p.to_account_id, p.amount, p.note,
            p.recorded_by, p.created_at,
            f.display_name AS from_name, t.display_name AS to_name
       FROM settle_payments p
       JOIN accounts f ON f.id = p.from_account_id
       JOIN accounts t ON t.id = p.to_account_id
      WHERE p.host_account_id = ?
      ORDER BY p.created_at DESC, p.id DESC`,
    hostAccountId
  ).map((r) => ({
    id: r.id,
    fromAccountId: r.from_account_id,
    toAccountId: r.to_account_id,
    fromName: r.from_name,
    toName: r.to_name,
    amount: r.amount,
    note: r.note,
    recordedBy: r.recorded_by,
    createdAt: r.created_at,
  }));
}

// Undoing a payment is how a mistake gets fixed — there is no editing a row,
// because a wrong amount and a wrong direction are the same repair.
export function deleteSettlePayment(id, byAccountId) {
  const row = get('SELECT * FROM settle_payments WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'No such payment' };
  const who = Number(byAccountId);
  // The same two people, plus whoever entered the row. Recording is now
  // restricted to the two parties, so that last clause only ever matters for a
  // row a host entered under the old rule — and being able to undo your own
  // entry is the opposite of the power being taken away here.
  if (who !== row.from_account_id && who !== row.to_account_id
      && who !== row.recorded_by) {
    return { ok: false, error: 'Only the payer or the payee can undo that' };
  }
  run('DELETE FROM settle_payments WHERE id = ?', row.id);
  return { ok: true, hostAccountId: row.host_account_id };
}

export function accountSummary(accountId) {
  ensureStatsRow(accountId);
  const stats = get('SELECT * FROM player_stats WHERE account_id = ?', accountId) || {};

  const sessions = all(
    `SELECT r.buy_ins, r.cash_outs, r.final_stack, r.net, r.hands_played,
            t.variant, t.small_blind, t.big_blind, t.started_at, t.ended_at, t.game_id
     FROM session_results r
     JOIN table_sessions t ON t.id = r.table_session_id
     WHERE r.account_id = ?
     ORDER BY t.started_at DESC
     LIMIT 100`,
    accountId
  ).map((r) => ({
    gameId: r.game_id,
    variant: r.variant,
    smallBlind: r.small_blind,
    bigBlind: r.big_blind,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    buyIns: r.buy_ins,
    cashOuts: r.cash_outs,
    finalStack: r.final_stack,
    net: r.net,
    handsPlayed: r.hands_played,
  }));

  const totals = {
    net: sessions.reduce((a, s) => a + s.net, 0),
    sessions: sessions.length,
    hands: stats.hands_dealt || 0,
    biggestPot: stats.biggest_pot || 0,
    handsWon: stats.hands_won || 0,
  };

  return {
    totals,
    sessions,
    stats: {
      handsDealt: stats.hands_dealt || 0,
      vpipHands: stats.vpip_hands || 0,
      pfrHands: stats.pfr_hands || 0,
      threeBetHands: stats.three_bet_hands || 0,
      threeBetOps: stats.three_bet_ops || 0,
      sawFlopHands: stats.saw_flop_hands || 0,
      wtsdHands: stats.wtsd_hands || 0,
      wsdHands: stats.wsd_hands || 0,
      aggressiveActions: stats.aggressive_actions || 0,
      passiveActions: stats.passive_actions || 0,
      handsWon: stats.hands_won || 0,
      biggestPot: stats.biggest_pot || 0,
      bestHandDesc: stats.best_hand_desc || null,
      netChips: stats.net_chips || 0,
    },
  };
}

export { settleUp } from '../shared/settle.js';
