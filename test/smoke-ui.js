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

// Fake camera/mic so the in-app video/voice can be exercised headlessly.
const mediaArgs = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
try {
  browser = await chromium.launch({ args: mediaArgs });
} catch {
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: mediaArgs });
}

async function newPage(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  pages[name] = page;
  page.on('pageerror', (err) => console.error(`  [${name}] pageerror: ${err.message}`));
  return page;
}

try {
  // ---- host creates a table from the landing page ----
  const anna = await newPage('anna');
  await anna.goto(base);
  // The install button is always offered on the landing page (Android + iOS +
  // desktop), not just when Chrome happens to fire its prompt event.
  await check('install button is visible on the landing page',
    !(await anna.locator('#install-btn').getAttribute('class')).includes('hidden'));
  await anna.click('#start-btn');
  await anna.fill('#c-nickname', 'Anna');
  await anna.selectOption('#c-variant', 'holdem');
  // The 7-2 bounty is a toggle with a custom payout; leave it off for this
  // run but prove the control gates the amount field.
  await check('7-2 payout starts disabled', await anna.locator('#c-72-amount').isDisabled());
  await anna.check('#c-72');
  await check('7-2 toggle enables the payout', !(await anna.locator('#c-72-amount').isDisabled()));
  await anna.uncheck('#c-72');
  await anna.click('#c-create');
  await anna.waitForURL('**/games/**');
  const gameUrl = anna.url();
  await check('landing flow creates a game URL', /\/games\/\w+/.test(gameUrl));

  // Host sits down (auto-approved).
  await anna.click('.empty-seat-btn');
  await anna.click('#j-request');
  await anna.waitForSelector('.seat.me .nameplate');
  await check('host is seated', true);

  // ---- an upright phone gets an upright table ----
  await anna.setViewportSize({ width: 390, height: 844 });
  await anna.waitForTimeout(500);
  const upright = await anna.evaluate(() => {
    const t = document.getElementById('table');
    const r = t.getBoundingClientRect();
    const area = document.getElementById('table-area').getBoundingClientRect();
    const clipped = [...document.querySelectorAll('#seats-layer .seat.occupied')].some((s) => {
      const b = s.getBoundingClientRect();
      return b.left < area.left - 1 || b.right > area.right + 1
        || b.top < area.top - 1 || b.bottom > area.bottom + 1;
    });
    return { cls: t.classList.contains('upright'), taller: r.height > r.width, clipped };
  });
  await check('a portrait screen turns the table upright', upright.cls && upright.taller);
  await check('no seat is cut off on a portrait screen', !upright.clipped);
  await anna.setViewportSize({ width: 1280, height: 800 });
  await anna.waitForTimeout(500);
  await check('going back to landscape lays the table down again',
    await anna.evaluate(() => !document.getElementById('table').classList.contains('upright')));

  // ---- in-app webcam + voice: a seated player can turn it on ----
  await anna.waitForSelector('#av-join:not(.hidden)');
  await anna.click('#av-join');
  await anna.waitForSelector('#av-live:not(.hidden)');
  await anna.waitForFunction(() => {
    const v = document.querySelector('#seats-layer video.seat-cam.mine');
    return v && v.videoWidth > 0;
  }, { timeout: 15000 });
  await check('a seated player can turn on their webcam at their seat', true);
  await anna.click('#av-leave');
  await anna.waitForSelector('#av-join:not(.hidden)');
  await check('leaving video restores the Video button', true);

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
  // A pending request must be noticeable even with the panel closed: the badge
  // on the 💬 button shows the count for the host.
  await check('host gets a seat-request badge on the panel button',
    !(await anna.locator('#seatreq-badge').getAttribute('class')).includes('hidden')
    && Number(await anna.textContent('#seatreq-badge')) >= 1);
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

  // The live hand readout under your own cards (preflop it always has
  // something to say — at worst "<rank> High").
  await anna.waitForSelector('.seat.me .hand-now');
  const readout = await anna.textContent('.seat.me .hand-now');
  await check('live hand readout shows under your cards', readout.trim().length > 0);

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

  // ---- 747 Poker: switch the game mid-session and play a dealer hand ----
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await anna.selectOption('#h-variant', '747');
  await anna.click('#h-save');
  await anna.click('#h-done');

  // Play out whatever community hand may still be live, until the 747
  // decision buttons appear.
  let sawDecision = false;
  for (let i = 0; i < 100 && !sawDecision; i++) {
    for (const page of [anna, ben, cara]) {
      try {
        const btn = page.locator('[data-act="check"], [data-act="call"]').first();
        if (await btn.isVisible({ timeout: 50 })) await btn.click({ timeout: 500 });
      } catch {
        /* fine */
      }
    }
    if (await anna.locator('[data-act="stay-747"]').isVisible({ timeout: 50 }).catch(() => false)) {
      sawDecision = true;
    }
    await anna.waitForTimeout(150);
  }
  await check('747 deals and offers Stay / Fold', sawDecision);
  await check('747 header shows the ante', (await anna.textContent('#game-badge')).includes('Ante'));
  await check('747 dealer cards are face down in the middle',
    (await anna.locator('#board .card.back').count()) === 4);

  await anna.click('[data-act="stay-747"]');
  await anna.waitForSelector('.seat.me .np-status:has-text("locked in")');
  await check('locking in is shown on the seat', true);
  await ben.click('[data-act="stay-747"]');
  await cara.click('[data-act="fold-747"]');

  await ben.waitForSelector('.countdown-747', { timeout: 5000 });
  await check('3-2-1 countdown appears once everyone locks in', true);
  await anna.waitForSelector('.dealer-title:has-text("Dealer —")', { timeout: 15000 });
  await check('dealer hand revealed with its description', true);
  await check('747 stayers hold five cards',
    (await anna.locator('.seat.me .card').count()) === 5);

  // Cara folded — after the hand she can still show what she threw away.
  await cara.click('[data-act="show-cards"]');
  await anna.waitForFunction(() =>
    document.getElementById('log-list')?.textContent.includes('Cara shows')
  );
  await check('a folder can show their cards after the hand', true);

  // Back to hold'em for the rest of the run — and the riding pot (if the
  // dealer swept) must liquidate without breaking anything.
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await anna.selectOption('#h-variant', 'holdem');
  await anna.click('#h-save');
  await anna.click('#h-done');

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

  // ---- provably-fair: live readout + client-seed control + replay panel ----
  await check('the live table shows a provably-fair chip',
    !(await anna.locator('#fair-chip').getAttribute('class')).includes('hidden'));
  const fairFloat = await anna.textContent('#fair-chip');
  await check('the fair chip shows a hashed float for the hand', /Shuffle\s*0\.\d{4}/.test(fairFloat));

  await anna.click('#fair-chip');
  await anna.waitForSelector('#tab-fair:not(.hidden)');
  await check('the Fair tab shows the client seed', (await anna.textContent('#fair-panel')).length > 0);

  await anna.fill('#fair-seed-input', 'smoke-seed-42');
  await anna.click('#fair-seed-form button[type="submit"]');
  await anna.waitForFunction(() =>
    document.getElementById('log-list')?.textContent.includes("set the table's client seed")
  );
  await check('a player can set the table client seed', true);

  // The replay verifier re-checks the deck commitment in the browser and
  // confirms every shown card — while folded hands stay sealed.
  await replay.waitForSelector('#rp-fairness h3');
  await check('the replay fairness panel renders with the commitment',
    /Verifying integrity/i.test(await replay.textContent('#rp-fairness')));
  await replay.click('#fp-verify');
  await replay.waitForSelector('#fp-result .fp-checks');
  await check('the in-browser verifier confirms the deal',
    /Verified/.test(await replay.textContent('#fp-result')));

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

  // ---- payment methods: link a handle so table-mates can pay from the ledger ----
  await dana.waitForSelector('#pay-fields input[data-pay="venmo"]');
  await check('payment method fields render on the profile', true);
  await dana.fill('#pay-fields input[data-pay="venmo"]', '@DanaPays');
  await dana.click('#pay-save');
  await dana.waitForSelector('#toast.show');
  await dana.reload();
  await dana.waitForSelector('#pay-fields input[data-pay="venmo"]');
  await check('a saved payment handle persists (@ stripped)',
    (await dana.inputValue('#pay-fields input[data-pay="venmo"]')) === 'DanaPays');

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
  // #table is static markup, so it exists before the first state arrives —
  // wait for the theme to actually be applied rather than racing it.
  const feltIsPink = (page) => page.waitForFunction(
    () => document.getElementById('table')?.style.backgroundColor === 'rgb(122, 31, 75)',
    { timeout: 10000 }
  ).then(() => true, () => false);

  await dana.waitForSelector('#table');
  await check('saved felt colour applies to a newly hosted table', await feltIsPink(dana));

  // A guest opening the same table sees the host's look too.
  const guestView = await newPage('guestview');
  await guestView.goto(dana.url());
  await guestView.waitForSelector('#table');
  await check("guests see the host's table look", await feltIsPink(guestView));

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

  // ---- four-color deck toggle ----
  await anna.click('#deck-toggle');
  await check('four-color deck toggles on',
    await anna.evaluate(() => document.body.classList.contains('four-color')));
  await anna.reload();
  await anna.waitForSelector('.seat.me .nameplate');
  await check('four-color preference survives a reload',
    await anna.evaluate(() => document.body.classList.contains('four-color')));
  await check('cards carry per-suit classes',
    (await anna.locator('.card[class*="suit-"]').count()) > 0);

  // ---- host can change the game mid-session ----
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await check('host modal offers a game selector',
    (await anna.locator('#h-variant option').count()) === 5);
  await anna.selectOption('#h-variant', 'plo');
  await anna.click('#h-save');
  await anna.click('#h-done');
  await anna.waitForFunction(() =>
    document.getElementById('log-list')?.textContent.includes('Game changes to Pot Limit Omaha')
  );
  await check('game change is announced in the log', true);

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
    manifest.name === 'Reg-Poker Online' && manifest.start_url === '/' && manifest.icons.length >= 2);
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

  // ---- per-player table skins: same room, three different looks ----
  const skinOptions = await anna.locator('#skin option').count();
  await check('every table skin is offered', skinOptions === 3);
  const geometry = async () => anna.evaluate(() => {
    const r = (sel) => [...document.querySelectorAll(sel)].map((e) => {
      const b = e.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    });
    return JSON.stringify({ btns: r('#top-bar button'), seats: r('#seats-layer .seat') });
  });
  const velvetGeo = await geometry();
  const velvetFelt = await anna.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--felt').trim());
  await anna.selectOption('#skin', 'tour');
  await anna.waitForTimeout(300);
  const tourFelt = await anna.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--felt').trim());
  await check('picking a skin repaints the room', tourFelt !== velvetFelt && tourFelt.length > 0);
  await check('a skin never moves anything', (await geometry()) === velvetGeo);
  await anna.reload();
  await anna.waitForSelector('#top-bar');
  await check('the chosen skin survives a reload',
    await anna.evaluate(() => document.documentElement.dataset.skin === 'tour'));
  await check('the skin is applied before the first paint, not after',
    await anna.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--felt').trim() !== ''));
  await anna.selectOption('#skin', 'velvet');
  await anna.waitForTimeout(200);

  // ---- tournament format lives in the create pop-up, cash game is default ----
  const tess = await newPage('tess');
  await tess.goto(base);
  await tess.click('#start-btn');
  await check('a new table is a cash game by default',
    await tess.inputValue('#c-format') === 'cash');
  await check('the tournament clock settings stay hidden for a cash game',
    (await tess.locator('#c-tourney-row').getAttribute('class')).includes('hidden'));
  await tess.selectOption('#c-format', 'tournament');
  await check('picking a tournament reveals its clock settings',
    !(await tess.locator('#c-tourney-row').getAttribute('class')).includes('hidden'));
  await tess.fill('#c-nickname', 'Tess');
  await tess.fill('#c-level', '12');
  await tess.fill('#c-rebuy', '30');
  await tess.click('#c-create');
  await tess.waitForURL('**/games/**');
  await tess.click('.empty-seat-btn');
  await tess.click('#j-request');
  await tess.waitForSelector('.seat.me .nameplate');
  await tess.waitForSelector('#tourney-clock:not(.hidden)');
  const clockText = await tess.textContent('#tourney-clock');
  await check('a tournament table shows its clock', /level 1/i.test(clockText));

  console.log('smoke-ui: all checks passed');
} catch (err) {
  await fail(`unexpected error: ${err.message}\n${err.stack}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
