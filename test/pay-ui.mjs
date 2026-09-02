// The payment fields on the profile, and the pay buttons they produce at the
// table. A browser gate because the failure is silent in both directions: a
// refused link that vanishes without saying why, and a stored link that opens
// somewhere other than where it claims.
// Usage: node test/pay-ui.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-pay-ui-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const accounts = await import('../server/accounts.js');

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = 'http://localhost:' + httpServer.address().port;

const acct = accounts.createAccount({
  email: 'payui@example.com', password: 'password123', displayName: 'Payee',
});

const args = ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'];
let browser;
try { browser = await chromium.launch({ args }); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args }); }
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('pp:account', t), acct.token);
await page.goto(base + '/me', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pay-venmo', { timeout: 8000 });

let bad = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) bad++; };

// The field has to ASK for a link, or nobody will paste one.
const asks = await page.evaluate(() => ({
  venmoPlaceholder: document.getElementById('pay-venmo').placeholder,
  venmoHint: document.getElementById('pay-venmo').closest('.pay-field').querySelector('.pay-hint').textContent.trim(),
  zelleHint: document.getElementById('pay-zelle').closest('.pay-field').querySelector('.pay-hint').textContent.trim(),
  // The @/$ box in front of the input belongs to a username, not a URL.
  venmoPrefix: !!document.getElementById('pay-venmo').closest('.pay-input').querySelector('.pay-prefix'),
  chimePrefix: !!document.getElementById('pay-chime').closest('.pay-input').querySelector('.pay-prefix'),
}));
check(`the Venmo field asks for a link (${asks.venmoPlaceholder})`,
  asks.venmoPlaceholder.startsWith('https://'));
check('and says where to find it', /share/i.test(asks.venmoHint));
check('no sigil box sits in front of a URL field', asks.venmoPrefix === false);
check('but the handle-only fields keep theirs', asks.chimePrefix === true);
check('Zelle says plainly that it has no link', /no share link/i.test(asks.zelleHint));

// Save a real share link.
await page.fill('#pay-venmo', 'https://venmo.com/u/AceHigh');
await page.fill('#pay-paypal', 'https://www.paypal.com/paypalme/DiaRusso');
await page.click('#pay-save');
await page.waitForFunction(() => document.getElementById('pay-venmo')?.value.includes('account.venmo.com'), null, { timeout: 5000 }).catch(() => {});
const saved = await page.evaluate(() => ({
  venmo: document.getElementById('pay-venmo').value,
  paypal: document.getElementById('pay-paypal').value,
  resolved: [...document.querySelectorAll('.pay-resolved')].map((e) => e.textContent.trim()),
}));
check(`the link is canonicalised in place (${saved.venmo})`,
  saved.venmo === 'https://account.venmo.com/u/AceHigh');
check('and so is the PayPal one', saved.paypal === 'https://paypal.me/DiaRusso');
check('the page shows who the link pays', saved.resolved.some((t) => /@AceHigh/.test(t)));

// A refused link must say so, in place, not disappear.
await page.fill('#pay-venmo', 'https://venmo.com.evil.example/u/Victim');
await page.click('#pay-save');
await page.waitForSelector('.pay-error', { timeout: 5000 }).catch(() => {});
const refused = await page.evaluate(() => ({
  error: document.querySelector('.pay-error')?.textContent.trim() || '',
  venmoStored: document.getElementById('pay-venmo').value,
}));
check(`a lookalike host is refused out loud (${refused.error.slice(0, 48)}…)`, refused.error.length > 0);
check('and the bad link is not left saved', !refused.venmoStored.includes('evil.example'));

// What a table-mate opens. Render the ledger's pay buttons from the shared
// module the panel uses, so this tests the real code path.
const buttons = await page.evaluate(async () => {
  const m = await import('/shared/payments.js');
  const stored = { venmo: 'https://account.venmo.com/u/AceHigh', paypal: 'https://paypal.me/DiaRusso', chime: 'kyle-daley1' };
  return {
    venmo: m.paymentLink('venmo', stored.venmo, { amount: 25 }),
    paypal: m.paymentLink('paypal', stored.paypal, { amount: 25 }),
    chime: m.paymentLink('chime', stored.chime, { amount: 25 }),
    chimeLabel: m.displayHandle('chime', stored.chime),
  };
});
check('the Venmo button opens the player\'s own share link',
  buttons.venmo.href === 'https://account.venmo.com/u/AceHigh' && buttons.venmo.prefilled === false);
check('PayPal carries the amount it documents',
  buttons.paypal.href === 'https://paypal.me/DiaRusso/25' && buttons.paypal.prefilled === true);
check('Chime offers no link, just the handle to copy',
  buttons.chime === null && buttons.chimeLabel === '$kyle-daley1');

await browser.close();
await new Promise((r) => httpServer.close(r));
console.log(bad === 0 ? 'PAY-UI: all good' : `PAY-UI: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
