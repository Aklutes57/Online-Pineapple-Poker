// End-to-end UI smoke test with real browsers (Playwright + preinstalled
// Chromium): host creates a table on the landing page, two friends join via
// the invite URL, the host approves them, a hand plays to a finish through
// the real buttons, then chat and the ledger are verified.
// Usage: node test/smoke-ui.js

import { chromium } from 'playwright';
import { buildServer } from '../server/app.js';

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

  // ---- reconnect: reload keeps your seat ----
  await ben.reload();
  await ben.waitForSelector('.seat.me .nameplate');
  await check('reload restores seat via stored token', true);

  console.log('smoke-ui: all checks passed');
} catch (err) {
  await fail(`unexpected error: ${err.message}\n${err.stack}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
