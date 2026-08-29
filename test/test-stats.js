// Settle-up maths and stat aggregation. Uses a temp database.
// Usage: node test/test-stats.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-stats-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');

const { settleUp } = await import('../shared/settle.js');
const { initDb, closeDb, get } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const stats = await import('../server/stats.js');

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

// ---- settle up ----

{
  const payments = settleUp([
    { nickname: 'A', net: -30 },
    { nickname: 'B', net: 30 },
  ]);
  check('simple two-way settle', payments.length === 1);
  check('two-way direction and amount', payments[0].from === 'A' && payments[0].to === 'B' && payments[0].amount === 30);
}

{
  const rows = [
    { nickname: 'A', net: -50 },
    { nickname: 'B', net: -20 },
    { nickname: 'C', net: 45 },
    { nickname: 'D', net: 25 },
  ];
  const payments = settleUp(rows);
  const paidOut = new Map();
  for (const p of payments) {
    paidOut.set(p.from, (paidOut.get(p.from) || 0) + p.amount);
    paidOut.set(p.to, (paidOut.get(p.to) || 0) - p.amount);
  }
  check('every debtor pays exactly their debt', paidOut.get('A') === 50 && paidOut.get('B') === 20);
  check('every creditor receives exactly their credit', paidOut.get('C') === -45 && paidOut.get('D') === -25);
  check('uses at most n-1 transfers', payments.length <= rows.length - 1);
  check('no zero-amount payments', payments.every((p) => p.amount > 0));
}

{
  check('everyone square produces no payments', settleUp([
    { nickname: 'A', net: 0 },
    { nickname: 'B', net: 0 },
  ]).length === 0);
  check('empty ledger produces no payments', settleUp([]).length === 0);
}

{
  // One big winner against many small losers.
  const rows = [
    { nickname: 'W', net: 100 },
    { nickname: 'X', net: -25 },
    { nickname: 'Y', net: -35 },
    { nickname: 'Z', net: -40 },
  ];
  const payments = settleUp(rows);
  const total = payments.reduce((a, p) => a + p.amount, 0);
  check('one winner: total transferred equals the winnings', total === 100);
  check('one winner: all payments go to the winner', payments.every((p) => p.to === 'W'));
}

// ---- stat aggregation ----

initDb();
const acct = accounts.createAccount({
  email: 'stats@example.com', password: 'a good long password', displayName: 'Statto',
});

// A fake game/hand pair shaped like the real ones, so recordHandStats is
// exercised through its real query path.
const player = {
  id: 'p1',
  accountId: acct.account.id,
  stack: 260,
  handStartStack: 200,
  handResult: { desc: 'Two Pair, Aces and Eights', won: 60 },
  handStats: {
    vpip: true, pfr: true, threeBet: false, threeBetOp: true,
    sawFlop: true, wtsd: true, wsd: true,
    aggressive: 3, passive: 1, showdownScore: 12345,
  },
};
const guest = {
  id: 'p2',
  accountId: null,
  stack: 140,
  handStartStack: 200,
  handStats: { vpip: true, pfr: false, threeBet: false, threeBetOp: false, sawFlop: true, wtsd: true, wsd: false, aggressive: 0, passive: 2, showdownScore: 999 },
};
const fakeHand = { players: [player, guest], results: { pots: [{ amount: 120 }] } };
const fakeGame = {
  id: 'g1',
  handNo: 1,
  hostAccountId: acct.account.id,
  settings: { variant: 'holdem', smallBlind: 1, bigBlind: 2 },
  players: new Map([['p1', player], ['p2', guest]]),
  ledgerRows: () => [
    { playerId: 'p1', nickname: 'Statto', buyIns: 200, cashOuts: 0, stack: 260, net: 60 },
    { playerId: 'p2', nickname: 'GuestPal', buyIns: 200, cashOuts: 0, stack: 140, net: -60 },
  ],
};

stats.recordHandStats(fakeGame, fakeHand);
const row = get('SELECT * FROM player_stats WHERE account_id = ?', acct.account.id);
check('hand counted', row.hands_dealt === 1);
check('vpip counted', row.vpip_hands === 1);
check('pfr counted', row.pfr_hands === 1);
check('3-bet opportunity counted without a 3-bet', row.three_bet_ops === 1 && row.three_bet_hands === 0);
check('showdown counted', row.wtsd_hands === 1 && row.wsd_hands === 1);
check('aggression counted', row.aggressive_actions === 3 && row.passive_actions === 1);
check('net chips reflect the hand delta', row.net_chips === 60);
check('biggest pot recorded', row.biggest_pot === 120);
check('best hand description recorded', row.best_hand_desc === 'Two Pair, Aces and Eights');

// A second hand accumulates rather than replacing.
player.handStartStack = 260;
player.stack = 230;
player.handResult = { desc: 'Pair of Fives', won: 0 };
player.handStats = { vpip: false, pfr: false, threeBet: false, threeBetOp: false, sawFlop: false, wtsd: false, wsd: false, aggressive: 0, passive: 0, showdownScore: 5 };
stats.recordHandStats(fakeGame, fakeHand);
const row2 = get('SELECT * FROM player_stats WHERE account_id = ?', acct.account.id);
check('second hand accumulates', row2.hands_dealt === 2);
check('vpip did not increment on a folded hand', row2.vpip_hands === 1);
check('net chips accumulate across hands', row2.net_chips === 30);
check('best hand is not overwritten by a worse one', row2.best_hand_desc === 'Two Pair, Aces and Eights');

// A better hand DOES replace it — including one that never reached a showdown,
// which is what "best hand ever made" means.
player.handStartStack = 230;
player.stack = 400;
player.handResult = { desc: null, won: 170 }; // won by folding everyone out
player.handStats = {
  vpip: true, pfr: false, threeBet: false, threeBetOp: false, sawFlop: true,
  wtsd: false, wsd: false, aggressive: 1, passive: 0,
  showdownScore: 0, madeScore: 99_999_999, madeDesc: 'Four of a Kind, Kings',
};
stats.recordHandStats(fakeGame, fakeHand);
const row3 = get('SELECT * FROM player_stats WHERE account_id = ?', acct.account.id);
check('a better hand replaces the best hand', row3.best_hand_desc === 'Four of a Kind, Kings');
check('a hand never shown down still counts as made', row3.best_hand_score === 99_999_999);

// ---- session results include guests ----

stats.syncSessionResults(fakeGame);
const results = get('SELECT COUNT(*) AS n FROM session_results');
check('both players recorded in session results', results.n === 2);
const guestRow = get('SELECT * FROM session_results WHERE nickname = ?', 'GuestPal');
check('guest recorded with no account', guestRow && guestRow.account_id === null);
check('guest net recorded', guestRow.net === -60);
const acctRow = get('SELECT * FROM session_results WHERE nickname = ?', 'Statto');
check('account row linked to the account', acctRow.account_id === acct.account.id);

// Re-syncing updates in place instead of duplicating.
stats.syncSessionResults(fakeGame);
check('re-sync does not duplicate rows', get('SELECT COUNT(*) AS n FROM session_results').n === 2);

// ---- profile summary ----

const summary = stats.accountSummary(acct.account.id);
check('summary reports the session', summary.totals.sessions === 1);
check('summary net matches the ledger', summary.totals.net === 60);
check('summary carries stats', summary.stats.handsDealt === 3);
check('summary lists the session row', summary.sessions[0].variant === 'holdem');

closeDb();
// ---- carrying stacks over to the next table ----
{
  const { createGame } = await import('../server/gameManager.js');
  const { BUY_IN_CAP } = await import('../shared/constants.js');

  const acct = accounts.createAccount({
    email: 'carry@example.com', password: 'password123', displayName: 'Carrie',
  });
  check('an account was made for the carry test', acct.ok === true);
  const accountId = acct.account.id;

  // A night that finishes: one signed-in player up, one guest also up.
  const first = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Carrie', accountId
  );
  const game = first.game;
  game.hostAccountId = accountId;
  const host = first.host;
  host.accountId = accountId;
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const guest = game.addPlayer('Gary', null);
  guest.connected = true;
  game.requestSeat(guest, 200, 1);
  if (guest.status === 'requesting') game.approveSeat(guest.id, true);

  // Play out: the host finished ahead, the guest behind. syncSessionResults is
  // what a finished hand calls, and it is what creates the session row — so a
  // table that never dealt a hand has nothing to carry over from.
  host.stack = 640;
  guest.stack = 90;
  game.handNo = 12;
  stats.syncSessionResults(game);
  game.close('done');

  const last = stats.lastTableStacks(accountId);
  check('the last table is found', !!last && last.players.length === 1);
  check('the signed-in player carries their finishing stack',
    last.players[0].accountId === accountId && last.players[0].stack === 640);
  check('a guest is not carried over — nothing matches them between tables',
    !last.players.some((p) => p.nickname === 'Gary'));

  // The next night.
  const second = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Carrie', accountId
  );
  const g2 = second.game;
  const carried = g2.setCarryStacks(last.players);
  check('one player is set to carry over', carried === 1);

  const host2 = second.host;
  host2.accountId = accountId;
  host2.connected = true;
  g2.requestSeat(host2, 200, 0); // asks for 200; should sit with 640
  check('they sit down with what they finished with, not what the box asked for',
    host2.stack === 640);

  // The books must open balanced: a carried stack IS this session's buy-in.
  const row = g2.ledger.get(host2.id);
  check('the carried stack is credited as the buy-in', row.buyIns === 640);
  check('so the new session opens balanced',
    host2.stack + row.cashOuts - row.buyIns === 0);

  // Spent once: standing up and coming back must not mint it again.
  g2.removeFromSeat(host2, 'leave');
  g2.requestSeat(host2, 200, 0);
  check('the carry-over is spent once, not every time they sit', host2.stack === 200);

  // A guest at the new table is unaffected.
  const guest2 = g2.addPlayer('Gary', null);
  guest2.connected = true;
  g2.requestSeat(guest2, 150, 2);
  if (guest2.status === 'requesting') g2.approveSeat(guest2.id, true);
  check('a guest buys in for what they asked for', guest2.stack === 150);
}
{
  // A stack below the table's floor is not a carry-over — it is a short
  // buy-in, and that player just buys in normally.
  const { createGame } = await import('../server/gameManager.js');
  const { game } = createGame({ minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 }, 'H', null);
  check('a stack under the minimum is not carried',
    game.setCarryStacks([{ accountId: 7, stack: 12 }]) === 0);
}
{
  // …and one above the cap is clamped rather than let in through the side door.
  const { createGame } = await import('../server/gameManager.js');
  const { BUY_IN_CAP } = await import('../shared/constants.js');
  const { game } = createGame({ minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 }, 'H', null);
  game.setCarryStacks([{ accountId: 9, stack: BUY_IN_CAP * 10 }]);
  check('a carried stack cannot exceed the buy-in cap',
    game.carryStacks.get(9) === BUY_IN_CAP);
}

rmSync(dir, { recursive: true, force: true });

console.log(`stats: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
