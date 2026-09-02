// Test accounts, for the harnesses that go through the real doors.
//
// Playing requires an account now, so every test that creates a table over
// HTTP or joins one over a socket needs one. Doing it through the real signup
// endpoint rather than by reaching into the database keeps these harnesses
// honest: if signup breaks, they break.

let seq = 0;

// A fresh account on a running server. Returns the bearer token, which is what
// the create route wants in an Authorization header and what the socket JOIN
// wants as `accountToken`.
export async function signUp(base, { displayName = 'Player', email, password = 'a good long password' } = {}) {
  seq += 1;
  const address = email || `t${seq}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: address, password, displayName }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(`signup failed for ${displayName}: ${data.error || res.status}`);
  }
  return { token: data.token, account: data.account, email: address, password };
}

// Create a table as a signed-in host, the way the landing page does.
export async function createTable(base, token, { nickname = 'Host', settings = {} } = {}) {
  const res = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nickname, settings, announce: false }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`create failed: ${data.error || res.status}`);
  return data;
}

// Sign a Playwright page in, before it loads anything that needs an account.
// The page must already be on the site's own origin for localStorage to be
// writable — a fresh context starts on about:blank, where it is not.
export async function signInPage(page, base, token) {
  if (page.url() === 'about:blank' || !page.url().startsWith(base)) {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
  }
  await page.evaluate((t) => localStorage.setItem('pp:account', t), token);
}

// The whole opening move for a browser gate: a new account, signed into this
// page, ready to create or join a table through the UI.
export async function signUpInPage(page, base, displayName) {
  const account = await signUp(base, { displayName });
  await signInPage(page, base, account.token);
  return account;
}

// In-process account minting, for the suites that already run the server in
// their own process. Avoids the signup endpoint's rate limit, which a soak or
// a suite with a dozen sockets would otherwise trip. Lazily imported so the
// database is initialised by the time it is called.
let accountsModule = null;
const byName = new Map();

export async function tokenFor(name) {
  if (byName.has(name)) return byName.get(name);
  accountsModule ||= await import('../../server/accounts.js');
  const made = accountsModule.createAccount({
    email: `${name.replace(/[^a-z0-9]/gi, '')}-${byName.size}@test.example`,
    password: 'a good long password',
    displayName: String(name).slice(0, 20) || 'Player',
  });
  if (!made.ok) throw new Error(`could not make a test account for ${name}: ${made.error}`);
  byName.set(name, made.token);
  return made.token;
}

// The Authorization header for a host account, for the create-a-table route.
export async function authFor(name) {
  return { Authorization: `Bearer ${await tokenFor(name)}` };
}
