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

const { payments: stored } = accounts.setPayments(acct.id, {
  venmo: '@AceHigh', cashapp: '$acetag', paypal: 'aceh', zelle: 'ace@bank.com',
  chime: 'AceChime', bogus: 'nope', blank: '   ',
});
// The three link services store a link built from the handle; the two without
// a public link store the handle itself.
check('a bare handle still works and becomes the canonical link',
  stored.venmo === 'https://account.venmo.com/u/AceHigh'
  && stored.cashapp === 'https://cash.app/$acetag'
  && stored.paypal === 'https://paypal.me/aceh');
check('services with no share link keep the handle',
  stored.zelle === 'ace@bank.com' && stored.chime === 'AceChime');
check('unknown/blank services are dropped', !('bogus' in stored) && !('blank' in stored));

// ---- the share link is what the field is actually for ----
{
  const { parsePayment, paymentLink, displayHandle, cleanPayments } =
    await import('../shared/payments.js');

  const ok = (key, input) => parsePayment(key, input);
  const stores = (key, input, expected) => {
    const r = ok(key, input);
    return r.ok && r.value === expected;
  };

  // Every share-link shape these three services are seen handing out.
  check('a Venmo share link is taken as it is',
    stores('venmo', 'https://account.venmo.com/u/AceHigh', 'https://account.venmo.com/u/AceHigh'));
  check('and the apex host form canonicalises to the same link',
    stores('venmo', 'https://venmo.com/u/AceHigh', 'https://account.venmo.com/u/AceHigh'));
  check('a link pasted without its scheme still works — people copy it that way',
    stores('venmo', 'venmo.com/u/AceHigh', 'https://account.venmo.com/u/AceHigh'));
  check('a bare Venmo path is a username',
    stores('venmo', 'https://venmo.com/AceHigh', 'https://account.venmo.com/u/AceHigh'));
  check('but a real Venmo page is not a username',
    ok('venmo', 'https://venmo.com/business/profiles').ok === false);
  check('a Cash App share link keeps the cashtag',
    stores('cashapp', 'https://cash.app/$acetag', 'https://cash.app/$acetag'));
  check('a UK cashtag link is not rejected for its sigil',
    stores('cashapp', 'https://cash.app/%C2%A3acetag', 'https://cash.app/$acetag'));
  check('a Cash App help page is not a cashtag',
    ok('cashapp', 'https://cash.app/help/us/en-us/3123-cashtags').ok === false);
  // Cash App serves real one-segment routes (/tags is a hardware product,
  // /press is the newsroom). Requiring the currency sigil is what keeps them
  // out — a reserved-word list would always lag behind Cash App's own routes.
  check('a one-segment Cash App route is not a cashtag either',
    ok('cashapp', 'https://cash.app/tags').ok === false
    && ok('cashapp', 'https://cash.app/press').ok === false);
  check('a PayPal.Me link is taken',
    stores('paypal', 'https://paypal.me/DiaRusso', 'https://paypal.me/DiaRusso'));
  check('so is the paypal.com/paypalme form, amount and all',
    stores('paypal', 'https://www.paypal.com/paypalme/DiaRusso/25', 'https://paypal.me/DiaRusso'));

  // The QR link carries an opaque id and no username. It has to survive as a
  // link, because turning it into a handle is impossible.
  const qr = ok('venmo', 'https://venmo.com/code?user_id=3319592654995456106&created=1753280522');
  check('a Venmo QR link is kept whole', qr.ok
    && qr.value === 'https://venmo.com/code?user_id=3319592654995456106&created=1753280522');
  check('and it admits it carries no username', qr.handle === '');
  check('a QR link with a junk id is refused',
    ok('venmo', 'https://venmo.com/code?user_id=notanumber').ok === false);
  check('the ledger names it by the service rather than inventing a handle',
    displayHandle('venmo', qr.value) === 'Venmo link');

  // ---- hostile input: these are rendered as links other players click ----
  const refused = (key, input) => ok(key, input).ok === false;
  check('javascript: is refused', refused('venmo', 'javascript:alert(1)'));
  check('data: is refused', refused('venmo', 'data:text/html,<script>alert(1)</script>'));
  check('plain http is refused — this link asks people for money',
    refused('venmo', 'http://venmo.com/u/AceHigh'));
  check('a userinfo trick is refused (https://venmo.com@evil.com/...)',
    refused('venmo', 'https://venmo.com@evil.com/u/AceHigh'));
  // The one above is caught by the host check — the real host is evil.com.
  // This one has a genuinely allowlisted host and is refused for the
  // credentials alone, which is the rule being tested.
  check('an authority carrying credentials is refused even on the right host',
    refused('venmo', 'https://evil.com:pw@venmo.com/u/AceHigh'));
  check('a credentialed authority is refused',
    refused('paypal', 'https://user:pass@evil.com/DiaRusso'));
  check('an unlisted subdomain of the real host is refused',
    refused('venmo', 'https://blog.venmo.com/u/AceHigh'));
  check('the host is the host, not something in the path',
    refused('venmo', 'https://evil.com/venmo.com/u/AceHigh'));
  check('a lookalike suffix host is refused (venmo.com.evil.com)',
    refused('venmo', 'https://venmo.com.evil.com/u/AceHigh'));
  check('a lookalike prefix host is refused (evil-venmo.com)',
    refused('venmo', 'https://evil-venmo.com/u/AceHigh'));
  check('a subdomain of a lookalike is refused',
    refused('venmo', 'https://cash.app.evil.com/$acetag'));
  check('a punycode homoglyph host is refused',
    refused('venmo', 'https://xn--vnmo-nqa.com/u/AceHigh'));
  check('a protocol-relative paste is refused',
    refused('venmo', '//evil.com/u/AceHigh'));
  check('a non-standard port is refused',
    refused('venmo', 'https://venmo.com:8443/u/AceHigh'));
  check('cash.me is not in the allowlist — nobody could show it still resolves to Block',
    refused('cashapp', 'https://cash.me/$acetag'));
  check('an absurdly long paste is refused',
    refused('venmo', `https://venmo.com/u/${'a'.repeat(400)}`));
  check('a zero-width character hiding in a host is refused',
    refused('venmo', 'https://ven\u200bmo.com/u/AceHigh'));
  check('an RTL override is refused',
    refused('venmo', 'https://venmo.com/u/Ace\u202eHigh'));
  check('a newline inside the input is refused',
    refused('venmo', 'https://venmo.com/u/Ace\nHigh'));

  // The property everything else rests on: what is stored is what we built,
  // so a query string or fragment riding along cannot survive.
  const carried = ok('venmo', 'https://account.venmo.com/u/AceHigh?next=https://evil.com#frag');
  check('a query string and fragment are dropped, not stored',
    carried.ok && carried.value === 'https://account.venmo.com/u/AceHigh');

  // Zelle and Chime have no share link, and must say so rather than mangling
  // a pasted URL into convincing-looking nonsense.
  const zelleUrl = ok('zelle', 'https://enroll.zellepay.com/qr-codes?data=eyJuYW1lIjoiSmFjb2IifQ==');
  check('a pasted Zelle URL is refused with an explanation', zelleUrl.ok === false
    && /no share link/i.test(zelleUrl.error));
  check('a Zelle email is kept exactly as enrolled',
    stores('zelle', 'ace@bank.com', 'ace@bank.com'));
  check('a Chime sign must start with a letter', refused('chime', '1nvalid'));
  check('a valid ChimeSign is kept', stores('chime', '$kyle-daley1', 'kyle-daley1'));
  check('Chime offers no link to open', paymentLink('chime', 'kyle-daley1', { amount: 25 }) === null);

  // ---- what a table-mate actually opens ----
  check('the pay button opens the player\'s own share link',
    paymentLink('venmo', 'https://account.venmo.com/u/AceHigh', { amount: 25 }).href
    === 'https://account.venmo.com/u/AceHigh');
  check('and does not pretend Venmo took the amount',
    paymentLink('venmo', 'https://account.venmo.com/u/AceHigh', { amount: 25 }).prefilled === false);
  // PayPal is the one service whose own help centre documents an amount in
  // the path, so it is the one that carries one.
  const pp = paymentLink('paypal', 'https://paypal.me/DiaRusso', { amount: 25 });
  check('PayPal carries the amount, which PayPal documents',
    pp.href === 'https://paypal.me/DiaRusso/25' && pp.prefilled === true);
  check('a handle saved before this change still opens',
    paymentLink('venmo', 'AceHigh', {}).href === 'https://account.venmo.com/u/AceHigh');

  // The form has to be able to say what went wrong, per field.
  const mixed = cleanPayments({ venmo: 'https://evil.com/u/x', paypal: 'https://paypal.me/Fine' });
  check('a refused link is dropped and explained, and the good one still saves',
    !('venmo' in mixed.payments) && !!mixed.errors.venmo
    && mixed.payments.paypal === 'https://paypal.me/Fine');
}

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
check('PUT /api/me/payments returns the canonical links',
  putRes.ok && putData.payments.venmo === 'https://account.venmo.com/u/NewName'
  && putData.payments.zelle === 'new@bank.com');

const me = await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
check('payments read back through /api/auth/me',
  me.account.prefs.payments.venmo === 'https://account.venmo.com/u/NewName');

// The server is the boundary that counts: a hostile link must not be storable
// even by a client that skips the page's own checks.
const evilRes = await fetch(`${url}/api/me/payments`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ payments: { venmo: 'https://venmo.com.evil.example/u/Victim' } }),
});
const evilData = await evilRes.json();
check('a lookalike host is refused by the server, not just the form',
  evilRes.ok && !('venmo' in evilData.payments) && !!evilData.errors.venmo);

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
