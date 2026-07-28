// All-in equity and cooler/bad-beat classification.
// Usage: node test/test-cooler.js

import { equity } from '../server/equity.js';
import { detectCooler } from '../server/cooler.js';
import { rank5, best7, CATEGORY } from '../server/evaluator.js';

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
function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

// ---- equity against known figures ----
// Tolerances are wide enough for the Monte Carlo paths but tight enough that
// a genuinely wrong calculation fails.

{
  const e = equity(
    [{ seat: 0, holeCards: ['As', 'Ah'] }, { seat: 1, holeCards: ['Ks', 'Kh'] }],
    []
  );
  check('AA vs KK preflop is about 82%', near(e.get(0), 0.82, 0.04));
  check('equity sums to 1', near(e.get(0) + e.get(1), 1, 0.001));
}

{
  // A pair against two live overcards — the classic coin flip.
  const e = equity(
    [{ seat: 0, holeCards: ['8s', '8h'] }, { seat: 1, holeCards: ['Ac', 'Kd'] }],
    []
  );
  check('pair vs two overcards is near a coin flip', near(e.get(0), 0.53, 0.05));
}

{
  // Exact enumeration on the flop: a set against a flush draw.
  const e = equity(
    [{ seat: 0, holeCards: ['9s', '9d'] }, { seat: 1, holeCards: ['Ah', 'Kh'] }],
    ['9h', '7h', '2c']
  );
  check('set vs flush draw on the flop favours the set', e.get(0) > 0.6 && e.get(0) < 0.8);
  check('flop equity sums to 1', near(e.get(0) + e.get(1), 1, 0.001));
}

{
  // Drawing dead: the board is already a made straight flush for seat 0.
  const e = equity(
    [{ seat: 0, holeCards: ['9h', '8h'] }, { seat: 1, holeCards: ['As', 'Ad'] }],
    ['7h', '6h', '5h', '2c', '3d']
  );
  check('a completed straight flush has 100% equity', near(e.get(0), 1, 0.001));
  check('drawing dead is 0%', near(e.get(1), 0, 0.001));
}

{
  // Identical hands by rank must split exactly.
  const e = equity(
    [{ seat: 0, holeCards: ['As', 'Kd'] }, { seat: 1, holeCards: ['Ah', 'Kc'] }],
    ['2c', '7d', '9h', 'Ts', 'Jc']
  );
  check('an exact chop splits 50/50', near(e.get(0), 0.5, 0.001) && near(e.get(1), 0.5, 0.001));
}

{
  const e = equity([{ seat: 3, holeCards: ['As', 'Ah'] }], ['2c', '7d', '9h']);
  check('a lone player has all the equity', e.get(3) === 1);
}

{
  // Omaha must respect the exactly-two-hole-cards rule.
  const e = equity(
    [
      { seat: 0, holeCards: ['Ah', 'Kc', 'Qd', 'Js'] },
      { seat: 1, holeCards: ['2h', '3h', '8c', '9d'] },
    ],
    ['5h', '6h', '7h', 'Tc', '2c'],
    { omaha: true }
  );
  check('omaha equity is resolved on a finished board', near(e.get(0) + e.get(1), 1, 0.001));
}

// ---- cooler classification ----

function player(seat, nickname, cards, board, extra = {}) {
  const { score } = best7([...cards, ...board]);
  return { seat, nickname, score, desc: 'x', folded: false, ...extra };
}

const BOARD = ['Ah', 'Kd', '9c', '4s', '2h'];

{
  // A big pot where a heavy favourite lost is a bad beat.
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'Vic', score: rank5(['Ah', 'Ac', 'Ad', 'Ks', 'Kh']), desc: 'a full house', folded: false },
      { seat: 1, nickname: 'Luck', score: rank5(['9h', '9c', '9d', '9s', 'Kh']), desc: 'quads', folded: false },
    ],
    potTotal: 400,
    bigBlind: 2,
    allInEquity: new Map([[0, 0.93], [1, 0.07]]),
  });
  check('bad beat detected', result?.trigger === 'badBeat');
  check('bad beat names the victim', result.detail.includes('Vic'));
  check('bad beat quotes the equity', result.detail.includes('93%'));
}

{
  // Same cards, but the money went in with the equity close: not a bad beat,
  // still a cooler because a big hand lost a big pot.
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'A', score: rank5(['Ah', 'Ac', 'Ad', 'Ks', 'Kh']), desc: 'a full house', folded: false },
      { seat: 1, nickname: 'B', score: rank5(['9h', '9c', '9d', '9s', 'Kh']), desc: 'quads', folded: false },
    ],
    potTotal: 400,
    bigBlind: 2,
    allInEquity: new Map([[0, 0.45], [1, 0.55]]),
  });
  check('a close all-in is not a bad beat', result?.trigger !== 'badBeat');
  check('but quads still gets announced', result?.trigger === 'quads');
}

{
  // Two pair losing to a set in a big pot is the everyday cooler.
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'A', score: rank5(['Ah', 'Ac', 'Kd', 'Ks', '9h']), desc: 'two pair', folded: false },
      { seat: 1, nickname: 'B', score: rank5(['9h', '9c', '9d', 'As', 'Kh']), desc: 'a set of nines', folded: false },
    ],
    potTotal: 300,
    bigBlind: 2,
    allInEquity: null,
  });
  check('cooler detected without equity data', result?.trigger === 'cooler');
  check('cooler names both hands', result.detail.includes('two pair') && result.detail.includes('a set of nines'));
}

{
  // A tiny pot is not worth a callout.
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'A', score: rank5(['Ah', 'Ac', 'Kd', 'Ks', '9h']), desc: 'two pair', folded: false },
      { seat: 1, nickname: 'B', score: rank5(['9h', '9c', '9d', 'As', 'Kh']), desc: 'a set', folded: false },
    ],
    potTotal: 8,
    bigBlind: 2,
    allInEquity: null,
  });
  check('a small pot is not a cooler', result === null);
}

{
  // An ordinary hand: top pair beats middle pair. Nothing to announce.
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'A', score: rank5(['Ah', 'Ac', 'Qd', '7s', '5h']), desc: 'a pair of aces', folded: false },
      { seat: 1, nickname: 'B', score: rank5(['9h', '9c', 'Qd', '7s', '5h']), desc: 'a pair of nines', folded: false },
    ],
    potTotal: 300,
    bigBlind: 2,
    allInEquity: null,
  });
  check('an ordinary hand raises nothing', result === null);
}

{
  // A chop is nobody's bad beat.
  const score = rank5(['Ah', 'Ac', 'Kd', 'Ks', '9h']);
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'A', score, desc: 'two pair', folded: false },
      { seat: 1, nickname: 'B', score, desc: 'two pair', folded: false },
    ],
    potTotal: 400,
    bigBlind: 2,
    allInEquity: new Map([[0, 0.9], [1, 0.1]]),
  });
  check('a chopped pot raises nothing', result === null);
}

{
  check('a single player raises nothing', detectCooler({
    players: [{ seat: 0, nickname: 'A', score: 1, desc: 'x', folded: false }],
    potTotal: 400, bigBlind: 2,
  }) === null);
  check('folded players are ignored', detectCooler({
    players: [
      { seat: 0, nickname: 'A', score: rank5(['Ah', 'Ac', 'Ad', 'Ks', 'Kh']), desc: 'a boat', folded: false },
      { seat: 1, nickname: 'B', score: rank5(['9h', '9c', '9d', '9s', 'Kh']), desc: 'quads', folded: true },
    ],
    potTotal: 400, bigBlind: 2,
  }) === null);
  check('an empty table raises nothing', detectCooler({ players: [], potTotal: 0, bigBlind: 2 }) === null);
}

{
  // Straight flush gets its own headline.
  const result = detectCooler({
    players: [
      { seat: 0, nickname: 'A', score: rank5(['9h', '8h', '7h', '6h', '5h']), desc: 'a straight flush', folded: false },
      { seat: 1, nickname: 'B', score: rank5(['Ah', 'Ac', 'Ad', 'Ks', 'Kh']), desc: 'a full house', folded: false },
    ],
    potTotal: 400,
    bigBlind: 2,
    allInEquity: null,
  });
  check('straight flush announced', result?.trigger === 'quads' && result.headline === 'Straight flush!');
}

console.log(`cooler/equity: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
