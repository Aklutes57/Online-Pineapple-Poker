import { buildPots, payoutPots } from '../server/pots.js';

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
function player(seatIndex, totalCommitted, folded = false) {
  return { seatIndex, totalCommitted, folded };
}
function potTotal(pots) {
  return pots.reduce((a, p) => a + p.amount, 0);
}

// --- Simple 2-way pot ---
{
  const pots = buildPots([player(0, 50), player(1, 50)]);
  check('2-way: one pot', pots.length === 1);
  check('2-way: amount 100', pots[0].amount === 100);
  check('2-way: both eligible', pots[0].eligibleSeats.length === 2);
}

// --- 3-way with one short all-in ---
{
  const pots = buildPots([player(0, 30), player(1, 100), player(2, 100)]);
  check('short all-in: two pots', pots.length === 2);
  check('main pot 90', pots[0].amount === 90);
  check('side pot 140', pots[1].amount === 140);
  check('main pot: all eligible', pots[0].eligibleSeats.length === 3);
  check('side pot: seats 1,2', pots[1].eligibleSeats.length === 2 && !pots[1].eligibleSeats.includes(0));
}

// --- Double all-in layering ---
{
  const pots = buildPots([player(0, 20), player(1, 60), player(2, 150), player(3, 150)]);
  check('layered: three pots', pots.length === 3);
  check('layer1 = 80', pots[0].amount === 80); // 20*4
  check('layer2 = 120', pots[1].amount === 120); // 40*3
  check('layer3 = 180', pots[2].amount === 180); // 90*2
}

// --- Folded player's dead money stays in main pot ---
{
  const pots = buildPots([player(0, 30, true), player(1, 100), player(2, 100)]);
  check('dead money: one pot (no live short stack)', pots.length === 1);
  check('dead money total 230', potTotal(pots) === 230);
  check('folder not eligible', !pots[0].eligibleSeats.includes(0));
}

// --- Folded player committed MORE than a live all-in ---
{
  const pots = buildPots([player(0, 80, true), player(1, 50), player(2, 100)]);
  check('fold-above-allin: two pots', pots.length === 2);
  // main: min(80,50)+50+50 = 150; side: 30(dead)+50 = 80 eligible only seat 2
  check('fold-above-allin main 150', pots[0].amount === 150);
  check('fold-above-allin side 80', pots[1].amount === 80);
  check('side only seat 2', pots[1].eligibleSeats.length === 1 && pots[1].eligibleSeats[0] === 2);
  check('total conserved', potTotal(pots) === 230);
}

// --- Payout: single winner takes all ---
{
  const pots = buildPots([player(0, 50), player(1, 50)]);
  const { winnings } = payoutPots(pots, new Map([[0, 500], [1, 400]]), 1);
  check('single winner gets 100', winnings.get(0) === 100 && !winnings.has(1));
}

// --- Payout: split pot with odd chip to left of button ---
{
  const pots = buildPots([player(0, 51), player(1, 51)]); // pot 102... make odd: use 3 players
  const pots2 = buildPots([player(0, 33), player(1, 33), player(2, 33)]); // 99, three-way tie
  const { winnings } = payoutPots(pots2, new Map([[0, 500], [1, 500], [2, 500]]), 2, 10);
  // 99 / 3 = 33 exactly; no remainder. Force remainder with pot 100 split 3 ways:
  const pots3 = [{ amount: 100, eligibleSeats: [0, 1, 2] }];
  const r3 = payoutPots(pots3, new Map([[0, 500], [1, 500], [2, 500]]), 2, 10);
  // shares 33 each, remainder 1 goes to first winner left of button seat 2 -> seat 3? occupied are 0,1,2 -> distance from 2: seat 0 = 8? Using seatDistance: ((s - btn + 9) % 10) + 1 -> seat 0: ((0-2+9)%10)+1 = 8; seat 1: 9? ((1-2+9)%10)+1= 9? seat 3 n/a. Actually seat 0 is closest.
  check('split conserved', [...r3.winnings.values()].reduce((a, b) => a + b, 0) === 100);
  check('odd chip to closest-left of button', r3.winnings.get(0) === 34 && r3.winnings.get(1) === 33 && r3.winnings.get(2) === 33);
  check('even split silent pass', [...winnings.values()].every((v) => v === 33));
}

// --- Payout: side pot to different winner ---
{
  const pots = buildPots([player(0, 30), player(1, 100), player(2, 100)]);
  // seat 0 has the best hand overall (wins main), seat 2 beats seat 1 (wins side).
  const { winnings } = payoutPots(pots, new Map([[0, 900], [1, 400], [2, 500]]), 0);
  check('short stack wins main 90', winnings.get(0) === 90);
  check('side 140 to seat 2', winnings.get(2) === 140);
  check('seat 1 wins nothing', !winnings.has(1));
}

// --- Folded player never wins even with a score entry absent ---
{
  const pots = buildPots([player(0, 100, true), player(1, 100), player(2, 100)]);
  const { winnings } = payoutPots(pots, new Map([[1, 100], [2, 200]]), 0);
  check('folder excluded from payout', !winnings.has(0));
  check('winner gets all 300', winnings.get(2) === 300);
}

// --- Randomized chip conservation (1000 cases) ---
{
  let ok = true;
  let rngState = 12345;
  const rnd = (n) => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState % n;
  };
  for (let i = 0; i < 1000 && ok; i++) {
    const n = 2 + rnd(8);
    const players = [];
    for (let s = 0; s < n; s++) {
      players.push(player(s, rnd(500), rnd(4) === 0));
    }
    // Ensure at least one live player with the max commitment (betting engine guarantees
    // uncalled bets are returned before pots are built, so max committer is always live).
    const maxC = Math.max(...players.map((p) => p.totalCommitted));
    const liveMax = players.filter((p) => !p.folded && p.totalCommitted === maxC);
    if (liveMax.length === 0) {
      const cand = players.filter((p) => p.totalCommitted === maxC);
      cand[0].folded = false;
    }
    const live = players.filter((p) => !p.folded && p.totalCommitted > 0);
    if (live.length === 0) continue;
    const pots = buildPots(players);
    const committed = players.reduce((a, p) => a + p.totalCommitted, 0);
    if (potTotal(pots) !== committed) {
      console.error(`case ${i}: pots ${potTotal(pots)} != committed ${committed}`, players);
      ok = false;
      break;
    }
    const scores = new Map(live.map((p) => [p.seatIndex, rnd(1000)]));
    const { winnings } = payoutPots(pots, scores, rnd(10));
    const paid = [...winnings.values()].reduce((a, b) => a + b, 0);
    if (paid !== committed) {
      console.error(`case ${i}: paid ${paid} != committed ${committed}`);
      ok = false;
    }
  }
  check('1000 randomized cases conserve chips', ok);
}

console.log(`pots: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
