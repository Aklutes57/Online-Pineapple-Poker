// Shared client-side account helper. Accounts are optional everywhere:
// every function degrades to "signed out" rather than throwing.

const TOKEN_KEY = 'pp:account';

export function getAccountToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setAccountToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing — signed-in state just won't persist */
  }
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

export async function signup({ email, password, displayName }) {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Could not create the account' };
  setAccountToken(data.token);
  cachedAccount = data.account;
  return { ok: true, account: data.account };
}

export async function signin({ email, password }) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Could not sign in' };
  setAccountToken(data.token);
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
