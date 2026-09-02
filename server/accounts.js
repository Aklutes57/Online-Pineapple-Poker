// Optional accounts: email + password with scrypt, bearer session tokens.
// Guests never touch any of this — the app works signed out exactly as before.

import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { run, get, all, now } from './db.js';
import { cleanPayments } from '../shared/payments.js';
import { SETTINGS_LIMITS } from '../shared/constants.js';

// "Remember me" keeps you signed in on your own device for three months;
// without it the session lasts a day, so a shared or borrowed screen forgets
// you by tomorrow.
const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;   // 90 days, remembered
const SESSION_TTL_SHORT = 24 * 60 * 60 * 1000;  // 1 day, not remembered
const SCRYPT_KEYLEN = 64;

export const LIMITS = {
  email: 254,
  password: { min: 8, max: 200 },
  displayName: { min: 1, max: 20 },
};

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > LIMITS.email) return null;
  // Deliberately permissive: one @, no spaces, a dot in the domain.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAccount({ email, password, displayName, remember = true }) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return { ok: false, error: 'Enter a valid email address' };
  if (typeof password !== 'string' || password.length < LIMITS.password.min) {
    return { ok: false, error: `Password must be at least ${LIMITS.password.min} characters` };
  }
  if (password.length > LIMITS.password.max) {
    return { ok: false, error: 'That password is too long' };
  }
  const name = typeof displayName === 'string' ? displayName.trim().replace(/\s+/g, ' ') : '';
  if (name.length < LIMITS.displayName.min || name.length > LIMITS.displayName.max) {
    return { ok: false, error: 'Pick a display name of 1-20 characters' };
  }
  if (get('SELECT id FROM accounts WHERE email = ?', cleanEmail)) {
    return { ok: false, error: 'An account with that email already exists' };
  }

  const { hash, salt } = hashPassword(password);
  const ts = now();
  const result = run(
    `INSERT INTO accounts (email, password_hash, password_salt, display_name, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    cleanEmail, hash, salt, name, ts, ts
  );
  const accountId = Number(result.lastInsertRowid);
  run('INSERT INTO player_stats (account_id, updated_at) VALUES (?, ?)', accountId, ts);
  return { ok: true, account: getAccount(accountId), token: createSession(accountId, remember) };
}

export function login({ email, password, remember = true }) {
  const cleanEmail = normalizeEmail(email);
  const generic = { ok: false, error: 'Email or password is incorrect' };
  if (!cleanEmail || typeof password !== 'string') return generic;

  const row = get('SELECT * FROM accounts WHERE email = ?', cleanEmail);
  if (!row) {
    // Spend comparable time so a missing account isn't detectable by timing.
    hashPassword(password, 'decoysaltdecoysalt');
    return generic;
  }
  if (!verifyPassword(password, row.password_hash, row.password_salt)) return generic;

  run('UPDATE accounts SET last_login_at = ? WHERE id = ?', now(), row.id);
  return { ok: true, account: publicAccount(row), token: createSession(row.id, remember) };
}

export function createSession(accountId, remember = true) {
  const token = randomUUID() + randomBytes(16).toString('hex');
  const ts = now();
  run(
    'INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    token, accountId, ts, ts + (remember ? SESSION_TTL : SESSION_TTL_SHORT)
  );
  return token;
}

export function accountForToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const session = get('SELECT * FROM sessions WHERE token = ?', token);
  if (!session) return null;
  if (session.expires_at < now()) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return getAccount(session.account_id);
}

export function logout(token) {
  if (typeof token === 'string') run('DELETE FROM sessions WHERE token = ?', token);
}

export function getAccount(accountId) {
  const row = get('SELECT * FROM accounts WHERE id = ?', accountId);
  return row ? publicAccount(row) : null;
}

// Never leak the hash or salt past this boundary.
function publicAccount(row) {
  let prefs = {};
  try {
    prefs = JSON.parse(row.prefs_json || '{}');
  } catch {
    prefs = {};
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    // Lifted out of prefs so callers don't have to know where it lives.
    avatarUrl: typeof prefs.avatarUrl === 'string' ? prefs.avatarUrl : null,
    prefs,
  };
}

export function updatePrefs(accountId, patch) {
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: 'no such account' };
  const prefs = { ...account.prefs, ...patch };
  run('UPDATE accounts SET prefs_json = ? WHERE id = ?', JSON.stringify(prefs), accountId);
  return { ok: true, prefs };
}

// The name this account settles up under in a ledger, kept apart from the
// username shown at the table. Stored in prefs so it follows them to every
// table. Empty clears it, and the ledger falls back to the table name.
export function setRealName(accountId, raw) {
  const name = typeof raw === 'string'
    ? raw.replace(/\s+/g, ' ').trim().slice(0, SETTINGS_LIMITS.realName.max) || null
    : null;
  const result = updatePrefs(accountId, { realName: name });
  return result.ok ? name : null;
}

// Linked payment methods (Venmo/Cash App/PayPal/Zelle/Chime), validated and
// stored in prefs so table-mates can pay this player from the ledger.
//
// The three services with a public share link store the LINK — rebuilt from an
// allowlisted host and a validated handle, never the string that was pasted.
// Zelle and Chime have no such link and store a handle.
//
// Errors come back alongside so the profile can say which field it could not
// read. A link that vanishes silently is worse than one that explains itself.
export function setPayments(accountId, raw) {
  const { payments, errors } = cleanPayments(raw);
  const result = updatePrefs(accountId, { payments });
  return result.ok ? { payments, errors } : { payments: {}, errors };
}

// The profile picture, stored against the account so it follows the player to
// every table without being re-uploaded. Only a content-addressed same-origin
// upload path is accepted — never an arbitrary URL.
export const AVATAR_URL_RE = /^\/uploads\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

export function setAvatar(accountId, url) {
  if (url === null || url === '') {
    const cleared = updatePrefs(accountId, { avatarUrl: null });
    return cleared.ok ? { ok: true, avatarUrl: null } : { ok: false, error: cleared.error };
  }
  if (typeof url !== 'string' || !AVATAR_URL_RE.test(url)) {
    return { ok: false, error: 'bad picture' };
  }
  const result = updatePrefs(accountId, { avatarUrl: url });
  return result.ok ? { ok: true, avatarUrl: url } : { ok: false, error: result.error };
}

export function updateDisplayName(accountId, displayName) {
  const name = typeof displayName === 'string' ? displayName.trim().replace(/\s+/g, ' ') : '';
  if (name.length < LIMITS.displayName.min || name.length > LIMITS.displayName.max) {
    return { ok: false, error: 'Pick a display name of 1-20 characters' };
  }
  run('UPDATE accounts SET display_name = ? WHERE id = ?', name, accountId);
  return { ok: true, account: getAccount(accountId) };
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}

// Bearer token from an Authorization header or an explicit body/query field.
export function tokenFromRequest(req) {
  const header = req.get?.('authorization') || req.headers?.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

export function accountForRequest(req) {
  return accountForToken(tokenFromRequest(req));
}

export { all };
