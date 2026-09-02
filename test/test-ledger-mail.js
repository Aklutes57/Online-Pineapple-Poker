// The ledger actually reaching an SMTP server as an attachment.
//
// test-notify.js covers what gets queued; this covers the last hop, which is
// the whole point of the feature and the one part the outbox cannot show. It
// needs its own file because the mail transport is built once and cached, so
// the stub has to be in place before anything sends.
// Usage: node test/test-ledger-mail.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-ledgermail-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');
// Any URL will do — createTransport is stubbed below before it is ever called.
process.env.SMTP_URL = 'smtp://user:pass@localhost:2525';
process.env.SMTP_FROM = 'Reg-Poker <no-reply@example.com>';

// Same module instance notify.js will import, stubbed before its first use.
const nodemailer = (await import('nodemailer')).default;
const sentMail = [];
nodemailer.createTransport = () => ({
  async sendMail(message) {
    sentMail.push(message);
    return { messageId: 'stub' };
  },
});

const { initDb, closeDb } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const stats = await import('../server/stats.js');
const { createGame } = await import('../server/gameManager.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}

initDb();
const host = accounts.createAccount({
  email: 'ayden@example.com', password: 'a good long password', displayName: 'Ayden',
}).account;

// A finished night.
const { game, host: seat } = createGame(
  { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
  'Ayden', host.id
);
game.hostAccountId = host.id;
game.origin = 'https://pineapple-poker-now.fly.dev';
seat.accountId = host.id;
seat.connected = true;
game.requestSeat(seat, 200, 0);
const pal = game.addPlayer('Pal', null);
pal.connected = true;
game.requestSeat(pal, 200, 1);
if (pal.status === 'requesting') game.approveSeat(pal.id, true);
seat.stack = 350;
pal.stack = 50;
game.handNo = 22;
stats.syncSessionResults(game);
game.close('host');
await new Promise((r) => setTimeout(r, 80));

check('one mail reached the transport', sentMail.length === 1);
const mail = sentMail[0] || {};
check('addressed to the host', mail.to === 'ayden@example.com');
check('from the configured sender', mail.from === 'Reg-Poker <no-reply@example.com>');

const csv = stats.ledgerCsvForGame(game.id);
check('it carries exactly one attachment', (mail.attachments || []).length === 1);
// Defaulted so a MISSING attachment reports failed checks rather than
// throwing on the next line — a gate that crashes says less than one that
// says which property was wrong.
const file = (mail.attachments || [])[0] || { content: '', filename: '', contentType: '' };
check('the attachment is the ledger .csv, byte for byte', file.content === csv.body);
check('named by the date of the game', file.filename === csv.filename
  && file.filename === `pineapple-ledger-${new Date(csv.startedAt).toISOString().slice(0, 10)}.csv`);
check('and typed as a .csv so mail clients open it in a spreadsheet',
  /^text\/csv/.test(file.contentType || ''));

check('the subject names the game by its date',
  mail.subject === `Your poker ledger — ${(await import('../server/notify.js')).ledgerDateLabel(csv.startedAt)}`);
check('the plain-text part says what the night was',
  /2 players/.test(mail.text) && /22 hands/.test(mail.text));
check('the html part links to the saved copy',
  mail.html.includes(`https://pineapple-poker-now.fly.dev/api/games/${game.id}/ledger.csv`));
check('and the button says what it opens, not "Take a seat"',
  mail.html.includes('Open the ledger') && !mail.html.includes('Take a seat'));

// The CSV must survive the round trip as something a spreadsheet can read.
const lines = String(file.content).split('\r\n');
check('the attachment is CRLF-delimited, as a .csv should be', lines.length > 5);
check('it opens with the ledger header', lines[0].startsWith('"Reg-Poker Online ledger"'));
check('it names both players and their nets',
  file.content.includes('"Ayden"') && file.content.includes('"Pal"')
  && file.content.includes('150') && file.content.includes('-150'));
check('and carries the settle-up, which is what the night is settled from',
  /Settle up/.test(file.content));

closeDb();
rmSync(dir, { recursive: true, force: true });
console.log(`ledger-mail: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
