// P2P payment links + server-saved CSV ledgers.
// Usage: node test/test-payments.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-pay-')), 'test.db');

const { buildServer } = await import('../server/app.js');
const { initDb, run } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const { ledgerCsvForGame, ledgerXlsxForGame } = await import('../server/stats.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}

initDb();

// ---- setPayments validates + normalizes ----
const acct = accounts.createAccount({
  email: 'pay@example.com', password: 'a good long password', displayName: 'Payer',
}).account;

const stored = accounts.setPayments(acct.id, {
  venmo: '@AceHigh', cashapp: '$acetag', paypal: 'aceh', zelle: 'ace@bank.com',
  chime: '$AceChime', bogus: 'nope', blank: '   ',
});
check('known services with handles are stored, @/$ stripped',
  stored.venmo === 'AceHigh' && stored.cashapp === 'acetag' && stored.zelle === 'ace@bank.com');
check('unknown/blank services are dropped', !('bogus' in stored) && !('blank' in stored));

// ---- HTTP: PUT /api/me/payments then read back via /api/auth/me ----
const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const url = `http://localhost:${httpServer.address().port}`;

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'pay@example.com', password: 'a good long password' }),
}).then((r) => r.json());
const token = login.token;

const putRes = await fetch(`${url}/api/me/payments`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ payments: { venmo: '@NewName', zelle: 'new@bank.com' } }),
});
const putData = await putRes.json();
check('PUT /api/me/payments returns normalized handles',
  putRes.ok && putData.payments.venmo === 'NewName' && putData.payments.zelle === 'new@bank.com');

const me = await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
check('payments read back through /api/auth/me', me.account.prefs.payments.venmo === 'NewName');

check('payments require auth', (await fetch(`${url}/api/me/payments`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payments: {} }),
})).status === 401);

// ---- server-saved CSV ledger ----
// Seed a finished session directly so we exercise the CSV generator.
const started = 1_700_000_000_000; // fixed ms for a deterministic date in the CSV
run(
  `INSERT INTO table_sessions (game_id, host_account_id, variant, small_blind, big_blind, started_at, hands_played)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  'GAME123', acct.id, 'holdem', 1, 2, started, 10
);
const { get } = await import('../server/db.js');
const tsId = get('SELECT id FROM table_sessions WHERE game_id = ?', 'GAME123').id;
for (const [nick, buy, out, net] of [['Ann', 200, 260, 60], ['Bob', 200, 140, -60]]) {
  run(
    `INSERT INTO session_results (table_session_id, account_id, player_id, nickname, buy_ins, cash_outs, final_stack, net, hands_played, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    tsId, null, `p-${nick}`, nick, buy, out, 0, net, 10, started
  );
}

const csv = ledgerCsvForGame('GAME123');
check('a CSV is generated for a played game', !!csv && typeof csv.body === 'string');
check('the CSV filename carries the game date', csv.filename === 'pineapple-ledger-2023-11-14.csv');
check('the CSV lists players and nets', csv.body.includes('Ann') && csv.body.includes('60') && csv.body.includes('-60'));
check('the CSV includes a settle-up section', /Settle up/.test(csv.body) && csv.body.includes('Bob'));
check('an unknown game yields no CSV', ledgerCsvForGame('nope') === null);

// ---- HTTP: GET /api/games/:id/ledger.csv ----
const csvRes = await fetch(`${url}/api/games/GAME123/ledger.csv`);
check('the ledger CSV is downloadable by game id (no auth)',
  csvRes.ok && csvRes.headers.get('content-type').includes('text/csv')
  && csvRes.headers.get('content-disposition').includes('pineapple-ledger-2023-11-14.csv'));
check('an unknown game CSV is 404', (await fetch(`${url}/api/games/nope/ledger.csv`)).status === 404);

// ---- the colour-coded spreadsheet, which is the download people actually get ----
const book = ledgerXlsxForGame('GAME123');
check('a spreadsheet is generated for a played game',
  !!book && book.body instanceof Uint8Array && book.body.length > 0);
check('the spreadsheet filename carries the game date',
  book.filename === 'reg-poker-ledger-2023-11-14.xlsx');
// A .xlsx is a ZIP; every one starts "PK".
check('the spreadsheet really is a workbook',
  book.body[0] === 0x50 && book.body[1] === 0x4b);
check('an unknown game yields no spreadsheet', ledgerXlsxForGame('nope') === null);

const xlsxRes = await fetch(`${url}/api/games/GAME123/ledger.xlsx`);
check('the ledger spreadsheet is downloadable by game id (no auth)',
  xlsxRes.ok
  && xlsxRes.headers.get('content-type').includes('spreadsheetml')
  && xlsxRes.headers.get('content-disposition').includes('reg-poker-ledger-2023-11-14.xlsx'));
check('an unknown game spreadsheet is 404',
  (await fetch(`${url}/api/games/nope/ledger.xlsx`)).status === 404);

console.log(`payments: ${passes} passed, ${failures} failed`);
await new Promise((r) => httpServer.close(r));
process.exit(failures ? 1 : 0);
