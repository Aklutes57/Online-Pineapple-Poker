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

// ---- the running total across nights ----
{
  const { createGame } = await import('../server/gameManager.js');

  const a = accounts.createAccount({ email: 'run-a@example.com', password: 'password123', displayName: 'Ann' });
  const b = accounts.createAccount({ email: 'run-b@example.com', password: 'password123', displayName: 'Bo' });
  const hostId = a.account.id;

  // Two nights at Ann's tables. Night one: Ann +300, Bo -300, a guest square.
  function night(annStack, boStack, guestStack) {
    const { game, host } = createGame(
      { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
      'Ann', hostId
    );
    game.hostAccountId = hostId;
    host.accountId = hostId;
    host.connected = true;
    game.requestSeat(host, 200, 0);
    const bo = game.addPlayer('Bo', b.account.id);
    bo.connected = true;
    game.requestSeat(bo, 200, 1);
    if (bo.status === 'requesting') game.approveSeat(bo.id, true);
    const guest = game.addPlayer('Gus', null);
    guest.connected = true;
    game.requestSeat(guest, 200, 2);
    if (guest.status === 'requesting') game.approveSeat(guest.id, true);
    host.stack = annStack; bo.stack = boStack; guest.stack = guestStack;
    game.handNo = 5;
    stats.syncSessionResults(game);
    game.close('done');
    return game;
  }

  // Chip-conserving, like a real night: three players in for 200 each.
  night(500, 100, 0);     // Ann +300, Bo -100, Gus -200
  night(150, 250, 200);   // Ann  -50, Bo  +50, Gus    0

  const run = stats.runningTotals(hostId);
  check('the running total covers both nights', run.nights === 2);
  check('only signed-in players appear', run.players.length === 2);

  const ann = run.players.find((p) => p.accountId === hostId);
  const bo = run.players.find((p) => p.accountId === b.account.id);
  check('a player\'s running total is the sum of their nights',
    ann.net === 250 && bo.net === -50);
  check('and it counts the nights they played', ann.sessions === 2 && bo.sessions === 2);
  check('the guest is absent — nothing follows them between nights',
    !run.players.some((p) => p.nickname === 'Gus'));

  check('the running settle-up squares the whole lot, not one night',
    run.settle.length === 1 && run.settle[0].amount === 50
    && run.settle[0].to === 'Ann' && run.settle[0].from === 'Bo');

  // Worth pinning because it is a real limitation, not an accident: a guest's
  // 200 is nowhere in this. Signed-in totals do NOT sum to zero once a guest
  // has won or lost anything, because nothing follows a guest between nights.
  // Inside a single night's ledger they still settle normally.
  check('a guest\'s money is missing from the running total, so it does not balance',
    run.players.reduce((t, p) => t + p.net, 0) === 200);
}
{
  // Carrying a stack over must not double-count. A night you carried 640 into
  // and left with 500 is -140 for that night; the +440 that produced the 640
  // stays on the previous night's row, and the sum is the true position.
  const { createGame } = await import('../server/gameManager.js');
  const c = accounts.createAccount({ email: 'run-c@example.com', password: 'password123', displayName: 'Cass' });
  const hostId = c.account.id;

  const first = createGame({ minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 }, 'Cass', hostId);
  first.game.hostAccountId = hostId;
  first.host.accountId = hostId;
  first.host.connected = true;
  first.game.requestSeat(first.host, 200, 0);
  first.host.stack = 640;                       // +440 on the night
  first.game.handNo = 3;
  stats.syncSessionResults(first.game);
  first.game.close('done');

  const carry = stats.lastTableStacks(hostId);
  const second = createGame({ minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 }, 'Cass', hostId);
  second.game.hostAccountId = hostId;
  second.game.setCarryStacks(carry.players);
  second.host.accountId = hostId;
  second.host.connected = true;
  second.game.requestSeat(second.host, 200, 0); // sits with the carried 640
  check('the carried stack is what they sat down with', second.host.stack === 640);
  second.host.stack = 500;                      // -140 on the night
  second.game.handNo = 3;
  stats.syncSessionResults(second.game);
  second.game.close('done');

  const run = stats.runningTotals(hostId);
  const cass = run.players.find((p) => p.accountId === hostId);
  check('carrying a stack over does not double-count the running total',
    cass.net === 300);
  check('which is exactly what they are up from their original buy-in',
    500 - 200 === cass.net);
}

// ---- marking the running tab paid ----
{
  const { createGame } = await import('../server/gameManager.js');

  const d = accounts.createAccount({ email: 'pay-d@example.com', password: 'password123', displayName: 'Dee' });
  const e = accounts.createAccount({ email: 'pay-e@example.com', password: 'password123', displayName: 'Eli' });
  const f = accounts.createAccount({ email: 'pay-f@example.com', password: 'password123', displayName: 'Fay' });
  const hostId = d.account.id;
  const eliId = e.account.id;
  const fayId = f.account.id;

  // One night, chip-conserving: Dee +250, Eli -250.
  const { game, host } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Dee', hostId
  );
  game.hostAccountId = hostId;
  host.accountId = hostId;
  host.connected = true;
  game.requestSeat(host, 300, 0);
  const eli = game.addPlayer('Eli', eliId);
  eli.connected = true;
  game.requestSeat(eli, 300, 1);
  if (eli.status === 'requesting') game.approveSeat(eli.id, true);
  host.stack = 550;
  eli.stack = 50;
  game.handNo = 9;
  stats.syncSessionResults(game);
  game.close('done');

  const before = stats.runningTotals(hostId);
  check('the tab opens with the loser owing the winner',
    before.settle.length === 1 && before.settle[0].amount === 250
    && before.settle[0].from === 'Eli' && before.settle[0].to === 'Dee');
  check('and nothing has been paid yet', before.payments.length === 0);

  // A part payment: 100 of the 250.
  const part = stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId,
    amount: 100, note: 'Venmo', recordedBy: eliId,
  });
  check('a player can mark off money they handed over', part.ok === true);

  const mid = stats.runningTotals(hostId);
  const eliRow = mid.players.find((p) => p.accountId === eliId);
  const deeRow = mid.players.find((p) => p.accountId === hostId);
  check('what the cards did is untouched by paying for it',
    eliRow.net === -250 && deeRow.net === 250);
  check('but only the rest is still outstanding',
    eliRow.outstanding === -150 && deeRow.outstanding === 150);
  check('the payment is shown against both sides',
    eliRow.paid === 100 && deeRow.received === 100);
  check('and the settle-up now asks for the remainder, not the whole debt',
    mid.settle.length === 1 && mid.settle[0].amount === 150);
  check('the payment is listed with who paid whom',
    mid.payments.length === 1 && mid.payments[0].amount === 100
    && mid.payments[0].fromAccountId === eliId && mid.payments[0].toAccountId === hostId);
  check('and the note it was paid with survives', mid.payments[0].note === 'Venmo');

  // The rest of it, recorded by the host this time.
  const rest = stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId,
    amount: 150, recordedBy: hostId,
  });
  check('the host can mark off a payment made to them', rest.ok === true);
  const square = stats.runningTotals(hostId);
  check('two part payments square the debt as surely as one whole one',
    square.settle.length === 0);
  check('and both players read as nothing outstanding',
    square.players.every((p) => p.outstanding === 0));

  // Undo: the debt comes back exactly as it was.
  const undo = stats.deleteSettlePayment(rest.id, eliId);
  check('the payer can undo a payment that was recorded wrongly', undo.ok === true);
  const after = stats.runningTotals(hostId);
  check('undoing a payment puts the debt back',
    after.settle.length === 1 && after.settle[0].amount === 150);

  // Who is allowed to say a debt was paid.
  const meddling = stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId,
    amount: 150, recordedBy: fayId,
  });
  check('a third player cannot declare somebody else\'s debt settled', meddling.ok === false);
  const stranger = stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: fayId,
    amount: 10, recordedBy: eliId,
  });
  check('a payment to somebody who never played here is refused', stranger.ok === false);

  check('a payment of nothing is refused', stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId, amount: 0, recordedBy: eliId,
  }).ok === false);
  check('a negative payment is refused — direction is the two ids, not the sign',
    stats.recordSettlePayment({
      hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId, amount: -50, recordedBy: eliId,
    }).ok === false);
  check('a fractional payment is refused', stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId, amount: 12.5, recordedBy: eliId,
  }).ok === false);
  check('an absurd payment is refused rather than left to poison the tab',
    stats.recordSettlePayment({
      hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId,
      amount: stats.SETTLE_LIMITS.amount + 1, recordedBy: eliId,
    }).ok === false);
  check('paying yourself is refused', stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: eliId, amount: 10, recordedBy: eliId,
  }).ok === false);

  // Overpaying is allowed and flips the balance — that is a real thing that
  // happens, and the tab has to be able to say so rather than swallow it.
  const over = stats.recordSettlePayment({
    hostAccountId: hostId, fromAccountId: eliId, toAccountId: hostId,
    amount: 200, recordedBy: eliId,
  });
  check('overpaying is recorded rather than clamped', over.ok === true);
  const flipped = stats.runningTotals(hostId);
  check('and the tab now says the other one owes the difference',
    flipped.settle.length === 1 && flipped.settle[0].amount === 50
    && flipped.settle[0].from === 'Dee' && flipped.settle[0].to === 'Eli');
  stats.deleteSettlePayment(over.id, eliId);

  // Who may open which tab.
  check('a player who has finished a night can read that host\'s tab',
    stats.canSeeLedger(hostId, eliId) === true);
  check('the host can read their own tab', stats.canSeeLedger(hostId, hostId) === true);
  check('somebody who has never played there cannot',
    stats.canSeeLedger(hostId, fayId) === false);

  const ledgers = stats.hostLedgersFor(eliId);
  check('a player\'s profile lists the tab they are on',
    ledgers.length === 1 && ledgers[0].hostId === hostId && ledgers[0].hostName === 'Dee');
  check('with their own position on it', ledgers[0].net === -250 && ledgers[0].nights === 1);
  check('and it is not marked as theirs to host', ledgers[0].hosted === false);
  const hostLedgers = stats.hostLedgersFor(hostId);
  check('the host sees the tab as their own',
    hostLedgers.length === 1 && hostLedgers[0].hosted === true);
  check('somebody with no finished nights has no tabs at all',
    stats.hostLedgersFor(fayId).length === 0);
}
{
  // A host who runs a night without sitting in it still keeps that tab, and
  // still has to be able to open it — they are the one everybody pays through.
  const { createGame } = await import('../server/gameManager.js');
  const g = accounts.createAccount({ email: 'pay-g@example.com', password: 'password123', displayName: 'Gil' });
  const h = accounts.createAccount({ email: 'pay-h@example.com', password: 'password123', displayName: 'Hal' });
  const hostId = g.account.id;

  const { game } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Gil', hostId
  );
  game.hostAccountId = hostId;
  const hal = game.addPlayer('Hal', h.account.id);
  hal.connected = true;
  game.requestSeat(hal, 200, 1);
  if (hal.status === 'requesting') game.approveSeat(hal.id, true);
  hal.stack = 200;
  game.handNo = 4;
  stats.syncSessionResults(game);
  game.close('done');

  const ledgers = stats.hostLedgersFor(hostId);
  check('a host who never sat down still has the tab they ran',
    ledgers.length === 1 && ledgers[0].hostId === hostId && ledgers[0].hosted === true);
  check('with no position of their own on it', ledgers[0].nights === 0 && ledgers[0].net === 0);
  check('and they can open it', stats.canSeeLedger(hostId, hostId) === true);
}

rmSync(dir, { recursive: true, force: true });

console.log(`stats: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
