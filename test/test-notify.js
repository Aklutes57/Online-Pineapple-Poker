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

closeDb();
rmSync(dir, { recursive: true, force: true });

console.log(`notify: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
