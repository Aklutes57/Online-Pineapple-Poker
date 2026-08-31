// The running tab in the profile page, and marking money off it.
//
// A browser gate because everything interesting here is in the browser: the
// numbers are computed server-side and tested in test-stats.js, but "the tab
// is reachable from settings", "the Mark paid button fills the form with the
// right pair", "the figures move when a payment is recorded" and "Undo puts
// the debt back" are all page behaviour, and all silent when broken.
// Usage: node test/ledger-ui.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-lg-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const accounts = await import('../server/accounts.js');
const stats = await import('../server/stats.js');
const { createGame } = await import('../server/gameManager.js');

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = 'http://localhost:' + httpServer.address().port;

// One finished night: Dee hosts and wins 250, Eli loses it. No sockets — the
// engine is exercised elsewhere; what is on trial here is the page.
const dee = accounts.createAccount({ email: 'dee@example.com', password: 'password123', displayName: 'Dee' });
const eli = accounts.createAccount({ email: 'eli@example.com', password: 'password123', displayName: 'Eli' });
const { game, host } = createGame(
  { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
  'Dee', dee.account.id
);
game.hostAccountId = dee.account.id;
host.accountId = dee.account.id;
host.connected = true;
game.requestSeat(host, 300, 0);
const eliP = game.addPlayer('Eli', eli.account.id);
eliP.connected = true;
game.requestSeat(eliP, 300, 1);
if (eliP.status === 'requesting') game.approveSeat(eliP.id, true);
host.stack = 550;
eliP.stack = 50;
game.handNo = 9;
stats.syncSessionResults(game);
game.close('done');

const args = ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'];
let browser;
try { browser = await chromium.launch({ args }); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args }); }
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));

// Signed in as Eli — the one who owes, and NOT the host. A player has to be
// able to mark off money they handed over without going through the host.
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('pp:account', t), eli.token);
await page.goto(base + '/me', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#running-block table.ledger', { timeout: 8000 });

let bad = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) bad++; };
// A control that never appears is a failed check, not a hung test: the point
// of a gate is to say what broke, and a thirty-second timeout says nothing.
const clickIfThere = async (sel) => {
  try { await page.click(sel, { timeout: 4000 }); return true; } catch { return false; }
};

const read = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#running-block table.ledger tbody tr')].map((tr) => {
    const td = [...tr.children].map((c) => c.textContent.trim());
    return { name: td[0], nights: td[1], net: td[2], paid: td[3], outstanding: td[4] };
  });
  const block = document.getElementById('running-block');
  return {
    rows,
    settle: [...document.querySelectorAll('.settle-block .settle-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    paidList: [...document.querySelectorAll('.paid-block .settle-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    form: {
      from: document.getElementById('sp-from')?.selectedOptions[0]?.textContent.trim(),
      to: document.getElementById('sp-to')?.selectedOptions[0]?.textContent.trim(),
      amount: document.getElementById('sp-amount')?.value,
    },
    // The section is in a settings page laid out for a phone as well as a
    // desk; a table that pushes the page sideways is a bug you only see.
    overflows: block.scrollWidth > block.clientWidth + 1,
    pickerHidden: document.getElementById('ledger-picker')?.classList.contains('hidden'),
  };
});

const start = await read();
check('the running tab is on the profile page with both players', start.rows.length === 2);
check('it shows what the cards did', start.rows.some((r) => r.net === '+250') && start.rows.some((r) => r.net === '-250'));
check('nothing is paid off yet', start.rows.every((r) => r.paid === '—'));
check('and the whole 250 is outstanding',
  start.rows.some((r) => r.outstanding === '-250') && start.rows.some((r) => r.outstanding === '+250'));
check('the settle-up names who pays whom',
  start.settle.length === 1 && /Eli pays Dee 250/.test(start.settle[0]));
check('nothing has been marked off', start.paidList.length === 0 && /Nothing marked off/.test(
  await page.textContent('.paid-block')));
check('the form opens on the payment this player owes',
  start.form.from === 'Eli' && start.form.to === 'Dee' && start.form.amount === '250');
check('one tab needs no picking', start.pickerHidden === true);
check('and the section does not push the page sideways', start.overflows === false);

// A part payment: 100 of the 250, marked off by the player who paid it.
check('the settle line offers to mark itself paid', await clickIfThere('.settle-block .pay-mark'));
await page.fill('#sp-amount', '100');
await page.fill('#sp-note', 'Venmo');
await page.click('#sp-save');
await page.waitForFunction(() => /150/.test(document.querySelector('.settle-block .settle-list li')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
const mid = await read();
check('a part payment leaves what the cards did alone',
  mid.rows.some((r) => r.net === '-250'));
check('but takes the money off what is still owed',
  mid.rows.some((r) => r.outstanding === '-150') && mid.rows.some((r) => r.outstanding === '+150'));
check('and says so against both players',
  mid.rows.some((r) => r.paid === 'paid 100') && mid.rows.some((r) => r.paid === 'got 100'));
check('the settle-up now asks for the rest, not the whole debt',
  mid.settle.length === 1 && /Eli pays Dee 150/.test(mid.settle[0]));
check('the payment is listed with its note',
  mid.paidList.length === 1 && /Eli paid Dee 100/.test(mid.paidList[0]) && /Venmo/.test(mid.paidList[0]));

// Undo puts it back exactly as it was.
check('a recorded payment can be undone', await clickIfThere('.paid-block .pay-undo'));
await page.waitForFunction(() => /250/.test(document.querySelector('.settle-block .settle-list li')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
const undone = await read();
check('undoing a payment puts the debt back',
  undone.settle.length === 1 && /Eli pays Dee 250/.test(undone.settle[0]));
check('and clears it off the list of what has been paid', undone.paidList.length === 0);

// ---- hosting a tab is not standing to settle other people's debts ----
// A separate tab, whose host is square and whose two players owe each other,
// so there is a settle line the host is not part of. Different players, so
// Eli stays on exactly one tab and the picker check above still means what it
// says.
const zed = accounts.createAccount({ email: 'zed@example.com', password: 'password123', displayName: 'Zed' });
const moe = accounts.createAccount({ email: 'moe@example.com', password: 'password123', displayName: 'Moe' });
const nia = accounts.createAccount({ email: 'nia@example.com', password: 'password123', displayName: 'Nia' });
const zg = createGame(
  { smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 1000, defaultBuyIn: 200 },
  'Zed', zed.account.id
);
zg.game.hostAccountId = zed.account.id;
const moeP = zg.game.addPlayer('Moe', moe.account.id);
moeP.connected = true;
zg.game.requestSeat(moeP, 200, 1);
if (moeP.status === 'requesting') zg.game.approveSeat(moeP.id, true);
const niaP = zg.game.addPlayer('Nia', nia.account.id);
niaP.connected = true;
zg.game.requestSeat(niaP, 200, 2);
if (niaP.status === 'requesting') zg.game.approveSeat(niaP.id, true);
moeP.stack = 100;   // Moe -100
niaP.stack = 300;   // Nia +100 — Zed hosted but never sat down
zg.game.handNo = 6;
stats.syncSessionResults(zg.game);
zg.game.close('done');

const hostPage = await ctx.newPage();
await hostPage.goto(base + '/', { waitUntil: 'domcontentloaded' });
await hostPage.evaluate((t) => localStorage.setItem('pp:account', t), zed.token);
await hostPage.goto(base + '/me', { waitUntil: 'domcontentloaded' });
await hostPage.waitForSelector('#running-block .settle-block', { timeout: 8000 });
const asHost = await hostPage.evaluate(() => ({
  settle: [...document.querySelectorAll('.settle-block .settle-list li')]
    .map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  markButtons: document.querySelectorAll('.settle-block .pay-mark').length,
  hint: document.querySelector('.pay-record .hint')?.textContent.replace(/\s+/g, ' ').trim() || '',
}));
check('the host can see what the table owes',
  asHost.settle.length === 1 && /Moe pays Nia 100/.test(asHost.settle[0]));
check('but is offered no way to mark off a debt between two other players',
  asHost.markButtons === 0);
check('and the page says why', /theirs to record/.test(asHost.hint));

// The server is the boundary that counts — a client that skips the page's own
// check must still be refused.
// Deliberately a payment that is valid in every other respect — both players
// are on this tab, the amount is sane — so the only thing left to refuse it
// is who is asking.
const refusedByServer = await hostPage.evaluate(async (ids) => {
  const token = localStorage.getItem('pp:account');
  const res = await fetch(`/api/me/ledgers/${ids.host}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fromAccountId: ids.from, toAccountId: ids.to, amount: 100 }),
  });
  return { status: res.status, body: await res.json() };
}, { host: zed.account.id, from: moe.account.id, to: nia.account.id });
check('and the server refuses it outright, not just the page',
  refusedByServer.status === 400 && /payer or the payee/.test(refusedByServer.body.error || ''));

// The same request from one of the two people in it goes through, which is
// what proves the refusal above was about standing and nothing else.
const allowed = await hostPage.evaluate(async (ids) => {
  const res = await fetch(`/api/me/ledgers/${ids.host}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ids.token}` },
    body: JSON.stringify({ fromAccountId: ids.from, toAccountId: ids.to, amount: 100 }),
  });
  return { status: res.status, body: await res.json() };
}, { host: zed.account.id, from: moe.account.id, to: nia.account.id, token: moe.token });
check('the payer of that same payment is allowed to record it',
  allowed.status === 200 && allowed.body.ok === true);

// The same section on a phone. Five columns of numbers is exactly the shape
// that quietly pushes a settings page sideways, and this game is played on
// phones at a table.
const phone = await ctx.newPage();
await phone.goto(base + '/me', { waitUntil: 'domcontentloaded' });
await phone.setViewportSize({ width: 390, height: 844 });
await phone.waitForSelector('#running-block table.ledger', { timeout: 8000 });
await phone.waitForTimeout(300);
const small = await phone.evaluate(() => {
  const block = document.getElementById('running-block');
  const overflowing = [...block.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
    .map((el) => el.tagName.toLowerCase() + '.' + (el.className || ''));
  return {
    pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    overflowing: overflowing.slice(0, 4),
  };
});
check('on a phone the page does not scroll sideways', small.pageScrolls === false);
check(`nothing in the section hangs off the screen (${small.overflowing.join(', ') || 'nothing'})`,
  small.overflowing.length === 0);

await browser.close();
await new Promise((r) => httpServer.close(r));
console.log(bad === 0 ? 'LEDGER-UI: all good' : `LEDGER-UI: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
