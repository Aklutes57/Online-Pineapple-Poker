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
  return { filename: `pineapple-ledger-${iso}.csv`, body };
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
