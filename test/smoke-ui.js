// End-to-end UI smoke test with real browsers (Playwright + preinstalled
// Chromium): host creates a table on the landing page, two friends join via
// the invite URL, the host approves them, a hand plays to a finish through
// the real buttons, then chat and the ledger are verified.
// Usage: node test/smoke-ui.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-smoke-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');

const SCREENSHOT_DIR = process.env.PP_SHOT_DIR || '.';

let browser = null;
let failed = false;
const pages = {};

function log(msg) {
  console.log(`  ${msg}`);
}

async function fail(msg) {
  failed = true;
  console.error(`SMOKE FAIL: ${msg}`);
  for (const [name, page] of Object.entries(pages)) {
    try {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/smoke-fail-${name}.png` });
      console.error(`  screenshot: ${SCREENSHOT_DIR}/smoke-fail-${name}.png`);
    } catch {
      /* page may be gone */
    }
  }
  await browser?.close();
  process.exit(1);
}

async function check(name, cond) {
  if (cond) {
    log(`ok: ${name}`);
  } else {
    await fail(name);
  }
}

// ---- boot server ----

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;
log(`server at ${base}`);

// ---- launch browser ----

try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
}

async function newPage(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  pages[name] = page;
  page.on('pageerror', (err) => console.error(`  [${name}] pageerror: ${err.message}`));
  return page;
}

try {
  // ---- host creates a table from the landing page ----
  const anna = await newPage('anna');
  await anna.goto(base);
  await anna.click('#start-btn');
  await anna.fill('#c-nickname', 'Anna');
  await anna.selectOption('#c-variant', 'holdem');
  await anna.click('#c-create');
  await anna.waitForURL('**/games/**');
  const gameUrl = anna.url();
  await check('landing flow creates a game URL', /\/games\/\w+/.test(gameUrl));

  // Host sits down (auto-approved).
  await anna.click('.empty-seat-btn');
  await anna.click('#j-request');
  await anna.waitForSelector('.seat.me .nameplate');
  await check('host is seated', true);

  // ---- two friends join via the invite link ----
  const ben = await newPage('ben');
  await ben.goto(gameUrl);
  await ben.click('[data-act="open-join"]');
  await ben.fill('#j-nickname', 'Ben');
  await ben.click('#j-request');

  const cara = await newPage('cara');
  await cara.goto(gameUrl);
  await cara.click('[data-act="open-join"]');
  await cara.fill('#j-nickname', 'Cara');
  await cara.click('#j-request');

  // ---- host approves both ----
  await anna.waitForSelector('#seat-requests button[data-approve="yes"]');
  while (await anna.locator('#seat-requests button[data-approve="yes"]').count()) {
    await anna.locator('#seat-requests button[data-approve="yes"]').first().click();
    await anna.waitForTimeout(150);
  }
  await ben.waitForSelector('.seat.me .nameplate');
  await cara.waitForSelector('.seat.me .nameplate');
  await check('friends seated after approval', true);

  // ---- start the game ----
  await anna.click('#start-game-btn');
  await anna.waitForSelector('.cards-fan.mine .card');
  await check('hole cards visible to host', true);

  // ---- play hands by checking/calling until a winner shows ----
  let winnerSeen = false;
  for (let i = 0; i < 80 && !winnerSeen; i++) {
    for (const page of [anna, ben, cara]) {
      try {
        const btn = page.locator('[data-act="check"], [data-act="call"]').first();
        if (await btn.isVisible({ timeout: 50 })) await btn.click({ timeout: 500 });
      } catch {
        /* not this page's turn or button re-rendered — fine */
      }
    }
    if (await anna.locator('.np-bubble.win').first().isVisible({ timeout: 50 }).catch(() => false)) {
      winnerSeen = true;
    }
    await anna.waitForTimeout(120);
  }
  await check('a hand played to a finish (winner shown)', winnerSeen);

  // ---- emoji reactions reach the other players ----
  await ben.click('#react-btn');
  await ben.waitForSelector('#react-picker:not(.hidden)');
  await ben.click('.react-option[data-emoji="🔥"]');
  await anna.waitForSelector('.floating-reaction');
  const reactionText = await anna.textContent('.floating-reaction');
  await check('a reaction from one player floats up for another', reactionText.includes('🔥'));
  await check('the reaction is attributed', reactionText.includes('Ben'));

  // ---- chat round-trip ----
  await ben.fill('#chat-input', 'good game everyone');
  await ben.press('#chat-input', 'Enter');
  await anna.waitForSelector('.chat-msg:has-text("good game everyone")');
  await check('chat message delivered to other players', true);

  // ---- ledger ----
  await anna.click('.tab[data-tab="ledger"]');
  await anna.waitForSelector('table.ledger tbody tr');
  const nets = await anna.$$eval('table.ledger tbody tr td:last-child', (tds) =>
    tds.map((td) => parseInt(td.textContent, 10))
  );
  await check('ledger has 3 rows', nets.length === 3);
  await check('ledger nets sum to zero', nets.reduce((a, b) => a + b, 0) === 0);

  // Settle-up: every payment must be covered by the nets, and the ledger
  // balancing to zero means the suggested transfers square everyone up.
  const settleLines = await anna.$$eval('.settle-list li', (lis) => lis.map((li) => li.textContent));
  const someoneIsUp = nets.some((n) => n > 0);
  await check(
    'settle-up suggests payments when someone is up',
    someoneIsUp ? settleLines.length > 0 : true
  );
  await check('CSV export button is present', await anna.locator('#ledger-csv').isVisible());

  // ---- hand replay opens from the log and steps through ----
  await anna.click('.tab[data-tab="log"]');
  await anna.waitForSelector('.replay-link');
  const replayHref = await anna.getAttribute('.replay-link', 'href');
  const replay = await newPage('replay');
  await replay.goto(base + replayHref);
  await replay.waitForSelector('#replay-body:not(.hidden)');
  await check('replay page loads a saved hand', true);
  await check('replay renders the seats', (await replay.locator('#seats-layer .seat').count()) >= 2);

  const endPosition = await replay.textContent('#rp-position');
  await replay.click('#rp-first');
  const startPosition = await replay.textContent('#rp-position');
  await check('replay steps back to the start', startPosition.startsWith('0 /') && endPosition !== startPosition);
  await replay.click('#rp-next');
  await check('replay steps forward', (await replay.textContent('#rp-position')).startsWith('1 /'));

  await replay.click('#rp-react-picker .react-option[data-emoji="😱"]');
  await replay.waitForSelector('.reaction-chip');
  await check('a reaction can be left on a saved hand', true);

  // ---- reconnect: reload keeps your seat ----
  await ben.reload();
  await ben.waitForSelector('.seat.me .nameplate');
  await check('reload restores seat via stored token', true);

  // ---- accounts are optional: guests above never signed in and played fine ----
  await check('guests played a full hand without any account', winnerSeen);

  // ---- sign up through the UI, then host a table as that account ----
  const dana = await newPage('dana');
  await dana.goto(base);
  await dana.click('#signin-btn');
  await dana.click('#a-switch'); // switch to "create an account"
  await dana.fill('#a-name', 'Dana');
  await dana.fill('#a-email', 'dana@example.com');
  await dana.fill('#a-password', 'a good long password');
  await dana.click('#a-submit');
  await dana.waitForSelector('.nav-account');
  await check('sign-up from the landing page works', true);

  const navName = await dana.textContent('.nav-account');
  await check('header shows the display name', navName.trim() === 'Dana');

  // Creating a table now prefills the nickname from the profile.
  await dana.click('#start-btn');
  const prefilled = await dana.inputValue('#c-nickname');
  await check('create-table nickname prefills from the profile', prefilled === 'Dana');
  await dana.click('#c-create');
  await dana.waitForURL('**/games/**');
  await dana.waitForSelector('#account-chip:not(.hidden)');
  await check('table header shows the account chip', true);

  // ---- profile page ----
  await dana.goto(`${base}/me`);
  await dana.waitForSelector('#signed-in:not(.hidden)');
  const profileName = await dana.textContent('#profile-name');
  await check('profile page shows the account', profileName.trim() === 'Dana');
  await dana.waitForSelector('#alltime-summary .stat-tile');
  await check('all-time ledger summary renders', true);
  await dana.waitForSelector('#stats-block .stat-tile');
  await check('poker stat block renders', true);

  // ---- invite list and Discord webhook validation through the UI ----
  await dana.fill('#n-email', 'friend@example.com');
  await dana.fill('#n-label', 'Ben');
  await dana.click('#n-add');
  await dana.waitForSelector('[data-remove-contact]');
  await check('an email joins the auto-invite list', true);

  await dana.fill('#n-webhook', 'https://evil.example/api/webhooks/1/x');
  await dana.click('#n-add-webhook');
  await dana.waitForSelector('#toast.show');
  await check('a non-Discord webhook URL is refused', await dana.locator('[data-remove-target]').count() === 0);

  await dana.fill('#n-webhook', 'https://discord.com/api/webhooks/123456789/abcdefghijklmnop');
  await dana.click('#n-add-webhook');
  await dana.waitForSelector('[data-remove-target]');
  const webhookShown = await dana.textContent('#target-list');
  await check('a real Discord webhook connects', true);
  await check('the webhook secret is never shown back', !webhookShown.includes('abcdefghijklmnop'));

  // ---- table theme follows the host to a new table ----
  await dana.locator('#t-felt').evaluate((el) => {
    el.value = '#7a1f4b';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dana.click('#t-save');
  await dana.waitForTimeout(400);
  await dana.goto(base);
  await dana.click('#start-btn');
  await dana.click('#c-create');
  await dana.waitForURL('**/games/**');
  await dana.waitForSelector('#table');
  const feltColor = await dana.locator('#table').evaluate((el) => el.style.backgroundColor);
  await check('saved felt colour applies to a newly hosted table', feltColor === 'rgb(122, 31, 75)');

  // A guest opening the same table sees the host's look too.
  const guestView = await newPage('guestview');
  await guestView.goto(dana.url());
  await guestView.waitForSelector('#table');
  const guestFelt = await guestView.locator('#table').evaluate((el) => el.style.backgroundColor);
  await check("guests see the host's table look", guestFelt === 'rgb(122, 31, 75)');

  await dana.goto(`${base}/me`);
  await dana.waitForSelector('#signed-in:not(.hidden)');

  // ---- sign out, sign back in ----
  await dana.click('#signout-btn');
  await dana.waitForURL(`${base}/`);
  await dana.click('#signin-btn');
  await dana.fill('#a-email', 'dana@example.com');
  await dana.fill('#a-password', 'a good long password');
  await dana.click('#a-submit');
  await dana.waitForSelector('.nav-account');
  await check('sign out then sign back in works', true);

  // ---- wrong password is rejected in the UI ----
  await dana.click('#signout-btn');
  await dana.waitForSelector('#signin-btn');
  await dana.click('#signin-btn');
  await dana.fill('#a-email', 'dana@example.com');
  await dana.fill('#a-password', 'definitely the wrong one');
  await dana.click('#a-submit');
  await dana.waitForSelector('#auth-error:not(.hidden)');
  await check('wrong password shows an error and does not sign in', true);

  // ---- PWA: manifest, service worker, offline assets, push surface ----
  const swActive = await anna.evaluate(() =>
    navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false)
  );
  await check('service worker registers and activates', swActive);

  const manifest = await anna.evaluate(() =>
    fetch('/manifest.webmanifest').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  );
  await check('manifest is served and parses', !!manifest);
  await check('manifest declares name, start_url and icons',
    manifest.name === 'Pineapple Poker' && manifest.start_url === '/' && manifest.icons.length >= 2);
  await check('manifest is linked from the page',
    await anna.locator('link[rel="manifest"]').count() === 1);
  await check('app icon is reachable',
    await anna.evaluate(() => fetch('/icons/icon-192.png').then((r) => r.ok).catch(() => false)));
  await check('offline page is reachable',
    await anna.evaluate(() => fetch('/offline.html').then((r) => r.ok).catch(() => false)));

  const vapid = await anna.evaluate(() =>
    fetch('/api/push/vapid-key').then((r) => r.json()).catch(() => ({}))
  );
  await check('vapid public key served', typeof vapid.key === 'string' && vapid.key.length > 80);
  await check('push bell is present at the table', await anna.locator('#push-bell').count() === 1);

  console.log('smoke-ui: all checks passed');
} catch (err) {
  await fail(`unexpected error: ${err.message}\n${err.stack}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
