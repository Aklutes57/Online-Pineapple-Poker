// Shared client-side account helper. Accounts are optional everywhere:
// every function degrades to "signed out" rather than throwing.

const TOKEN_KEY = 'pp:account';

// "Remember me" decides WHERE the token lives, not just how long the server
// honours it: remembered goes to localStorage (survives closing the browser),
// not-remembered to sessionStorage (gone when the tab closes — the right
// default on a friend's laptop or a shared iPad).
export function getAccountToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setAccountToken(token, remember = true) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (!token) return;
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    /* private browsing — signed-in state just won't persist */
  }
}

// Whether this device is currently set to stay signed in. Drives the
// checkbox's default, so it shows what you chose last time.
export function isRemembered() {
  try {
    return localStorage.getItem(TOKEN_KEY) !== null
      || localStorage.getItem('pp:remember') !== 'off';
  } catch {
    return true;
  }
}

function saveRememberPref(remember) {
  try {
    localStorage.setItem('pp:remember', remember ? 'on' : 'off');
  } catch { /* private browsing */ }
}

export function authHeaders(extra = {}) {
  const token = getAccountToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

let cachedAccount = null;

export function currentAccount() {
  return cachedAccount;
}

export async function loadAccount() {
  if (!getAccountToken()) {
    cachedAccount = null;
    return null;
  }
  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    if (!res.ok) {
      if (res.status === 401) setAccountToken(null);
      cachedAccount = null;
      return null;
    }
    const { account } = await res.json();
    cachedAccount = account;
    return account;
  } catch {
    cachedAccount = null;
    return null;
  }
}

export async function signup({ email, password, displayName, remember = true }) {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, remember }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Could not create the account' };
  saveRememberPref(remember);
  setAccountToken(data.token, remember);
  cachedAccount = data.account;
  return { ok: true, account: data.account };
}

export async function signin({ email, password, remember = true }) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, remember }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Could not sign in' };
  saveRememberPref(remember);
  setAccountToken(data.token, remember);
  cachedAccount = data.account;
  return { ok: true, account: data.account };
}

export async function signout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  } catch {
    /* clearing locally is what matters */
  }
  setAccountToken(null);
  cachedAccount = null;
}

export async function updateAccount(patch) {
  const res = await fetch('/api/auth/me', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Could not save' };
  cachedAccount = data.account;
  return { ok: true, account: data.account };
}
