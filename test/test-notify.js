// Invite lists, Discord webhook validation, and the outbox.
// The security-critical assertions here are the webhook allowlist (an
// unvalidated "webhook URL" field is a server-side request forgery hole)
// and that stored webhook URLs are never echoed back in full.
// Usage: node test/test-notify.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-notify-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');
delete process.env.SMTP_URL;

const { initDb, closeDb, get, all } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const notify = await import('../server/notify.js');

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

initDb();
const acct = accounts.createAccount({
  email: 'host@example.com', password: 'a good long password', displayName: 'Hosty',
}).account;

// ---- contacts ----

check('contact added', notify.addContact(acct.id, 'Friend@Example.com', 'Ben').ok === true);
check('contact email normalized', notify.listContacts(acct.id)[0].email === 'friend@example.com');
check('contact label kept', notify.listContacts(acct.id)[0].label === 'Ben');
check('contact defaults to auto-send', notify.listContacts(acct.id)[0].autoSend === true);
check('duplicate contact rejected', notify.addContact(acct.id, 'friend@example.com').ok === false);
check('invalid email rejected', notify.addContact(acct.id, 'not-an-email').ok === false);
check('empty email rejected', notify.addContact(acct.id, '').ok === false);

const contactId = notify.listContacts(acct.id)[0].id;
notify.setContactAutoSend(acct.id, contactId, false);
check('auto-send can be turned off', notify.listContacts(acct.id)[0].autoSend === false);
notify.setContactAutoSend(acct.id, contactId, true);

// A second account must not be able to touch the first one's contacts.
const other = accounts.createAccount({
  email: 'other@example.com', password: 'a good long password', displayName: 'Other',
}).account;
notify.removeContact(other.id, contactId);
check("another account cannot delete someone else's contact", notify.listContacts(acct.id).length === 1);

// ---- unsubscribe ----

const token = get('SELECT unsubscribe_token FROM contacts WHERE id = ?', contactId).unsubscribe_token;
check('unsubscribe token works', notify.unsubscribeByToken(token).ok === true);
check('unsubscribe clears auto-send', notify.listContacts(acct.id)[0].autoSend === false);
check('unknown unsubscribe token is refused', notify.unsubscribeByToken('nope').ok === false);
notify.setContactAutoSend(acct.id, contactId, true);

// ---- Discord webhook validation (SSRF guard) ----

const GOOD = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnop';
check('valid Discord webhook accepted',
  notify.addNotifyTarget(acct.id, 'discord_webhook', GOOD, 'Home game').ok === true);

const BAD_URLS = [
  ['http (not https)', 'http://discord.com/api/webhooks/1/x'],
  ['internal host', 'https://localhost/api/webhooks/1/x'],
  ['loopback ip', 'https://127.0.0.1/api/webhooks/1/x'],
  ['cloud metadata', 'https://169.254.169.254/api/webhooks/1/x'],
  ['private range', 'https://10.0.0.5/api/webhooks/1/x'],
  ['lookalike domain', 'https://discord.com.evil.example/api/webhooks/1/x'],
  ['right host, wrong path', 'https://discord.com/api/users/@me'],
  ['file scheme', 'file:///etc/passwd'],
  ['not a url', 'just some text'],
  ['empty', ''],
];
for (const [label, url] of BAD_URLS) {
  check(`webhook rejected: ${label}`,
    notify.addNotifyTarget(acct.id, 'discord_webhook', url).ok === false);
}
check('unknown channel rejected', notify.addNotifyTarget(acct.id, 'telegram', GOOD).ok === false);

// ---- webhook secrecy ----

const targets = notify.listNotifyTargets(acct.id);
check('only the valid webhook was stored', targets.length === 1);
check('webhook url is masked in listings', !targets[0].value.includes('abcdefghijklmnop'));
check('full webhook url is still stored server-side',
  get('SELECT value FROM notify_targets WHERE id = ?', targets[0].id).value === GOOD);

// ---- announce queues to every auto-send destination ----

await notify.announceTable(acct.id, {
  gameId: 'abc123',
  variantLabel: "Texas Hold'em",
  blinds: '1/2',
  link: 'http://localhost:3000/games/abc123',
  hostName: 'Hosty',
});

const outbox = all('SELECT * FROM outbox ORDER BY id');
check('announce queued one job per destination', outbox.length === 2);
check('announce queued the email contact', outbox.some((o) => o.channel === 'email' && o.target === 'friend@example.com'));
check('announce queued the discord target', outbox.some((o) => o.channel === 'discord_webhook'));
check('outbox stores the join link', outbox.every((o) => o.body.includes('/games/abc123')));

// With no SMTP configured the email is recorded rather than lost.
const emailJob = outbox.find((o) => o.channel === 'email');
check('unconfigured email is logged, not failed', emailJob.status === 'logged');
check('email is not retried when unconfigured', emailJob.attempts === 1);
check('emailConfigured reports false without SMTP_URL', notify.emailConfigured() === false);

// Turning auto-send off keeps that address out of the next announcement.
notify.setContactAutoSend(acct.id, contactId, false);
await notify.announceTable(acct.id, {
  gameId: 'def456', variantLabel: 'PLO', blinds: '1/2',
  link: 'http://localhost:3000/games/def456', hostName: 'Hosty',
});
const afterOptOut = all("SELECT * FROM outbox WHERE target = 'friend@example.com'");
check('opted-out contacts are skipped', afterOptOut.length === 1);

// An account with nothing configured queues nothing, and no account at all
// is a silent no-op rather than an error.
check('announce with no destinations queues nothing',
  (await notify.announceTable(other.id, { gameId: 'x', variantLabel: 'x', blinds: '1/2', link: 'x', hostName: 'x' })).sent === 0);
check('announce for a guest host is a no-op',
  (await notify.announceTable(null, { gameId: 'x', variantLabel: 'x', blinds: '1/2', link: 'x', hostName: 'x' })).sent === 0);

// ---- delivery log masks webhooks too ----

check('delivery log masks webhook targets',
  notify.recentDeliveries(10).every((r) => !r.target.includes('abcdefghijklmnop')));

// ---- the ledger, emailed to the host when the game ends ----
{
  const { createGame } = await import('../server/gameManager.js');
  const stats = await import('../server/stats.js');

  const inbox = () => all("SELECT * FROM outbox WHERE subject LIKE 'Your poker ledger%' ORDER BY id");
  const payloadOf = (row) => JSON.parse(row.body);

  // A night that actually happened: two players, chip-conserving.
  const { game, host } = createGame(
    { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
    'Hosty', acct.id
  );
  game.hostAccountId = acct.id;
  game.origin = 'https://poker.example';
  host.accountId = acct.id;
  host.connected = true;
  game.requestSeat(host, 200, 0);
  const pal = game.addPlayer('Pal', null);
  pal.connected = true;
  game.requestSeat(pal, 200, 1);
  if (pal.status === 'requesting') game.approveSeat(pal.id, true);
  host.stack = 320;
  pal.stack = 80;
  game.handNo = 14;
  stats.syncSessionResults(game);

  check('nothing is emailed while the table is still running', inbox().length === 0);

  game.close('host');
  // close() fires the mail without being awaited, so let the microtask run.
  await new Promise((r) => setTimeout(r, 50));

  const sent = inbox();
  check('closing the table emails the host exactly one ledger', sent.length === 1);
  check('and it goes to the host, not to their invite list',
    sent[0].target === 'host@example.com' && sent[0].channel === 'email');

  const payload = payloadOf(sent[0]);
  const csv = stats.ledgerCsvForGame(game.id);
  check('the .csv is attached', !!payload.attachment && !!payload.attachment.content);
  check('the attachment is the same ledger the download serves',
    payload.attachment.content === csv.body && payload.attachment.filename === csv.filename);
  check('the attachment names the file by the date of the game',
    /^pineapple-ledger-\d{4}-\d{2}-\d{2}\.csv$/.test(payload.attachment.filename));

  // The date of the game is the point of the subject line.
  const when = notify.ledgerDateLabel(csv.startedAt);
  check('the subject names the game by its date',
    sent[0].subject === `Your poker ledger — ${when}`);
  check('and that date is the date the ledger itself carries',
    when === `${new Date(csv.startedAt).getUTCDate()} ${
      ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December'][new Date(csv.startedAt).getUTCMonth()]
    } ${new Date(csv.startedAt).getUTCFullYear()}`);
  check('the body says what the night was',
    /2 players/.test(payload.body) && /14 hands/.test(payload.body)
    && /blinds 1\/2/.test(payload.body));
  check('the mail links to the saved copy on the server',
    payload.link === `https://poker.example/api/games/${game.id}/ledger.csv`);
  check('with a button that says what it opens', payload.cta === 'Open the ledger');
  check('and says why they are getting it', /hosted this table/.test(payload.footer));

  // Closing is guarded, so a second close must not send a second copy.
  game.close('idle');
  await new Promise((r) => setTimeout(r, 50));
  check('closing an already-closed table does not send it twice', inbox().length === 1);

  // With no SMTP configured the row is the delivery, and it says so rather
  // than being retried for ever.
  check('with no SMTP the outbox row records what would have gone out',
    sent.length === 1 && all("SELECT * FROM outbox WHERE id = ?", sent[0].id)[0].status === 'logged');
}
{
  // A guest host has no email, and a table nobody played at has no ledger.
  // Neither is an error; both are silence.
  const { createGame } = await import('../server/gameManager.js');
  const stats = await import('../server/stats.js');
  const before = all("SELECT COUNT(*) AS n FROM outbox")[0].n;

  const guest = createGame({ smallBlind: 1, bigBlind: 2 }, 'Guesty', null);
  guest.game.close('host');
  await new Promise((r) => setTimeout(r, 30));
  check('a guest-hosted table emails nobody',
    all("SELECT COUNT(*) AS n FROM outbox")[0].n === before);

  const empty = createGame({ smallBlind: 1, bigBlind: 2 }, 'Hosty', acct.id);
  empty.game.hostAccountId = acct.id;
  empty.game.close('idle');
  await new Promise((r) => setTimeout(r, 30));
  check('a table that never dealt a hand emails nothing',
    all("SELECT COUNT(*) AS n FROM outbox")[0].n === before);

  check('and the mailer says why rather than throwing',
    (await notify.mailLedgerToHost({ gameId: 'nope', hostAccountId: acct.id })).reason === 'no ledger');
  check('a guest host is a no-op',
    (await notify.mailLedgerToHost({ gameId: 'nope', hostAccountId: null })).sent === 0);
  void stats;
}

closeDb();
rmSync(dir, { recursive: true, force: true });

console.log(`notify: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
