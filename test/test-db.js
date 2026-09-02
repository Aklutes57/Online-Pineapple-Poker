// Persistence and accounts: migrations, password handling, sessions, and the
// guarantee that signing up never leaks a hash. Runs against a temp DB file.
// Usage: node test/test-db.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-test-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');

const { initDb, closeDb, get, all, run } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');

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

// ---- migrations ----

initDb();
const version = get('SELECT version FROM schema_version');
check('migrations ran', version.version > 0);
check('accounts table exists', !!get("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'"));
check('hands table exists', !!get("SELECT name FROM sqlite_master WHERE type='table' AND name='hands'"));
check('player_stats table exists', !!get("SELECT name FROM sqlite_master WHERE type='table' AND name='player_stats'"));

// Re-running migrations must be a no-op, not an error.
closeDb();
initDb();
check('migrations are idempotent across reopen', get('SELECT version FROM schema_version').version === version.version);

// ---- signup ----

const created = accounts.createAccount({
  email: '  Player@Example.COM ',
  password: 'correct horse battery',
  displayName: 'Ayden',
});
check('signup succeeds', created.ok === true);
check('signup normalizes email to lowercase', created.account.email === 'player@example.com');
check('signup returns a session token', typeof created.token === 'string' && created.token.length > 20);
check('signup never returns a password hash', !('password_hash' in created.account) && !('passwordHash' in created.account));
check('signup seeds a stats row', !!get('SELECT account_id FROM player_stats WHERE account_id = ?', created.account.id));

const stored = get('SELECT * FROM accounts WHERE id = ?', created.account.id);
check('password is not stored in plain text', stored.password_hash !== 'correct horse battery');
check('password hash is long', stored.password_hash.length >= 64);
check('salt is stored', typeof stored.password_salt === 'string' && stored.password_salt.length > 0);

// ---- signup validation ----

check('duplicate email rejected', accounts.createAccount({
  email: 'player@example.com', password: 'another password', displayName: 'Imposter',
}).ok === false);
check('short password rejected', accounts.createAccount({
  email: 'b@example.com', password: 'short', displayName: 'B',
}).ok === false);
check('bad email rejected', accounts.createAccount({
  email: 'not-an-email', password: 'a good long password', displayName: 'B',
}).ok === false);
check('empty display name rejected', accounts.createAccount({
  email: 'c@example.com', password: 'a good long password', displayName: '   ',
}).ok === false);
check('non-string password rejected', accounts.createAccount({
  email: 'd@example.com', password: 12345678, displayName: 'D',
}).ok === false);

// ---- login ----

check('login with correct password', accounts.login({
  email: 'player@example.com', password: 'correct horse battery',
}).ok === true);
check('login is case-insensitive on email', accounts.login({
  email: 'PLAYER@example.com', password: 'correct horse battery',
}).ok === true);
check('login with wrong password fails', accounts.login({
  email: 'player@example.com', password: 'wrong password here',
}).ok === false);
check('login for unknown email fails', accounts.login({
  email: 'nobody@example.com', password: 'correct horse battery',
}).ok === false);

const wrongPw = accounts.login({ email: 'player@example.com', password: 'wrong password here' });
const unknown = accounts.login({ email: 'nobody@example.com', password: 'whatever password' });
check('failed logins do not reveal which part was wrong', wrongPw.error === unknown.error);

// ---- sessions ----

const session = accounts.login({ email: 'player@example.com', password: 'correct horse battery' });
const resolved = accounts.accountForToken(session.token);
check('session token resolves to the account', resolved && resolved.id === created.account.id);
check('garbage token resolves to null', accounts.accountForToken('garbage') === null);
check('null token resolves to null', accounts.accountForToken(null) === null);
check('resolved account carries no secrets', resolved && !('password_hash' in resolved));

accounts.logout(session.token);
check('logout invalidates the token', accounts.accountForToken(session.token) === null);

// Expired sessions are rejected and cleaned up.
const expiring = accounts.createSession(created.account.id);
run('UPDATE sessions SET expires_at = ? WHERE token = ?', Date.now() - 1000, expiring);
check('expired session rejected', accounts.accountForToken(expiring) === null);
check('expired session deleted', !get('SELECT token FROM sessions WHERE token = ?', expiring));

// ---- profile updates ----

check('display name update works', accounts.updateDisplayName(created.account.id, 'Ayden K').ok === true);
check('display name persists', accounts.getAccount(created.account.id).displayName === 'Ayden K');
check('over-long display name rejected', accounts.updateDisplayName(created.account.id, 'x'.repeat(50)).ok === false);
check('prefs merge', accounts.updatePrefs(created.account.id, { hud: true }).prefs.hud === true);
check('prefs persist across reads', accounts.getAccount(created.account.id).prefs.hud === true);

// ---- data survives a reopen (the whole point of persistence) ----

closeDb();
initDb();
const afterRestart = accounts.login({ email: 'player@example.com', password: 'correct horse battery' });
check('account survives a database reopen', afterRestart.ok === true);
check('display name survives a reopen', afterRestart.account.displayName === 'Ayden K');

closeDb();
rmSync(dir, { recursive: true, force: true });

console.log(`db/accounts: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
