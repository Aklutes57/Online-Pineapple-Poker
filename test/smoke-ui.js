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

// The table controls live behind the Menu caret; anything inside the sheet
// needs it open before Playwright can see it. One-shot buttons close it again.
async function openMenu(page) {
  const open = await page.evaluate(
    () => document.getElementById('menu-toggle')?.getAttribute('aria-expanded') === 'true'
  );
  if (!open) await page.click('#menu-toggle');
  await page.waitForSelector('#top-menu:not(.hidden)');
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
  await openMenu(anna);
  await anna.waitForSelector('#av-join:not(.hidden)');
  await anna.click('#av-join');
  await openMenu(anna);
  await anna.waitForSelector('#av-live:not(.hidden)');
  await anna.waitForFunction(() => {
    const v = document.querySelector('#seats-layer video.seat-cam.mine');
    return v && v.videoWidth > 0;
  }, { timeout: 15000 });
  await check('a seated player can turn on their webcam at their seat', true);
  await anna.click('#av-leave');
  await openMenu(anna);
  await anna.waitForSelector('#av-join:not(.hidden)');
  await check('leaving video restores the Video button', true);

  // Voice-only: the mic joins without a camera; the camera controls stay
  // out of the way and the mute toggle is right there.
  await anna.waitForSelector('#av-voice:not(.hidden)');
  await anna.click('#av-voice');
  await openMenu(anna);
  await anna.waitForSelector('#av-live:not(.hidden)');
  await check('Mic on joins voice without a camera',
    await anna.locator('#av-mic').isVisible()
    && !(await anna.locator('#av-cam').isVisible())
    && (await anna.textContent('#av-leave')) === 'End voice');
  await anna.click('#av-mic');
  await openMenu(anna);
  await check('the mic button mutes and relabels',
    (await anna.textContent('#av-mic')) === 'Unmute mic');
  await anna.click('#av-leave');
  await openMenu(anna);
  await anna.waitForSelector('#av-voice:not(.hidden)');
  await check('ending voice restores the Mic on button', true);
  await anna.keyboard.press('Escape');

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

  // ---- the bet tab: summoned by the Bet button, dismissed by Close, and
  // opening it never resizes the table ----
  {
    let toAct = null;
    for (let i = 0; i < 40 && !toAct; i++) {
      for (const p of [anna, ben, cara]) {
        if (await p.locator('[data-act="open-tray"]').isVisible().catch(() => false)) { toAct = p; break; }
      }
      if (!toAct) await anna.waitForTimeout(150);
    }
    await check('someone is offered a Bet/Raise button', !!toAct);
    await check('the tray does not open itself on your turn',
      !(await toAct.locator('#tray-slider').isVisible().catch(() => false)));
    const feltBefore = await toAct.evaluate(() =>
      JSON.stringify(document.getElementById('table').getBoundingClientRect()));
    await toAct.click('[data-act="open-tray"]');
    await toAct.waitForSelector('#tray-slider');
    await check('the Bet button opens the tray', true);
    await check('opening the tray never resizes the table',
      (await toAct.evaluate(() =>
        JSON.stringify(document.getElementById('table').getBoundingClientRect()))) === feltBefore);
    await toAct.click('.tray-close');
    await toAct.waitForSelector('#tray-slider', { state: 'detached' });
    await check('Close hands back the Fold/Check/Bet row',
      await toAct.locator('[data-act="open-tray"]').isVisible());

    // ---- the bar never moves the felt, whatever it is showing ----
    // The table is sized to the room the bar leaves, so a bar that grew with
    // its contents would resize the table mid-decision. It is a fixed strip;
    // anything bigger rises above it.
    const feltBox = () => toAct.evaluate(() =>
      JSON.stringify(document.getElementById('table').getBoundingClientRect()));
    const shape = await toAct.evaluate(() => {
      const bar = document.getElementById('action-bar').getBoundingClientRect();
      return { w: bar.width, h: bar.height };
    });
    await check('the betting bar is a wide strip, not a tall block',
      shape.w > shape.h * 2);

    // ---- the shove asks first ----
    // Pressing All in must not move a chip: it swaps the row for a question,
    // and Cancel puts the row back exactly as it was. Nothing here commits,
    // so the hand carries on into the play loop below untouched.
    await toAct.click('[data-act="arm-all-in"]');
    await toAct.waitForSelector('.ab-allin-ask');
    await check('All in asks before it shoves',
      (await toAct.textContent('.ab-allin-ask')).includes('Are you sure you want to go all in?'));
    await check('the question replaces the buttons rather than sitting beside them',
      !(await toAct.locator('[data-act="fold"], [data-act="arm-fold"]').first()
        .isVisible().catch(() => false)));
    await check('the confirm button reads All in',
      (await toAct.textContent('[data-act="all-in-confirm"]')).trim() === 'All in');
    await check('being asked about the shove never resizes the table',
      (await feltBox()) === feltBefore);
    await toAct.click('[data-act="cancel-all-in"]');
    await toAct.waitForSelector('.ab-allin-ask', { state: 'detached' });
    await check('Cancel hands the betting row straight back',
      await toAct.locator('[data-act="open-tray"]').isVisible());
    await check('and the table is still exactly where it was',
      (await feltBox()) === feltBefore);
  }

  // ---- play hands by checking/calling until a winner shows ----
  let winnerSeen = false;
  for (let i = 0; i < 80 && !winnerSeen; i++) {
    for (const page of [anna, ben, cara]) {
      try {
        // A stack-sized call now asks first, so the confirm is part of the
        // ordinary "just keep calling" path a player would take.
        const btn = page
          .locator('[data-act="check"], [data-act="call"], [data-act="all-in-confirm"], [data-act="arm-all-in-call"]')
          .first();
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

  // ---- straddling: the host offers it, each player opts in for themselves ----
  await check('no straddle button before the host offers it',
    !(await anna.locator('#straddle-btn').isVisible()));
  await openMenu(anna);
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await anna.check('#h-straddle');
  await anna.click('#h-save');
  await anna.click('#h-done');
  await anna.waitForSelector('#straddle-btn:not(.hidden)');
  await check('turning straddling on puts the button in the top bar', true);
  await check('and it starts OFF — straddling is opted into, never assumed',
    (await anna.textContent('#straddle-btn')) === 'Straddle: off');
  await anna.click('#straddle-btn');
  await anna.waitForFunction(
    () => document.getElementById('straddle-btn').textContent === 'Straddle: on',
    { timeout: 5000 }
  );
  await check('one tap opts you in', true);
  await check('the choice is yours alone — Ben is still out',
    (await ben.textContent('#straddle-btn')) === 'Straddle: off');
  await anna.click('#straddle-btn');
  await anna.waitForFunction(
    () => document.getElementById('straddle-btn').textContent === 'Straddle: off',
    { timeout: 5000 }
  );
  await check('and one more tap opts you back out', true);

  // ---- bomb pot: Omaha and two boards, whatever the table is playing ----
  await openMenu(anna);
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await anna.selectOption('#h-bomb', '1');
  await anna.fill('#h-bomb-ante', '5');
  await anna.click('#h-save');
  await anna.click('#h-done');

  let bombSeen = false;
  for (let i = 0; i < 140 && !bombSeen; i++) {
    for (const page of [anna, ben, cara]) {
      try {
        const btn = page
          .locator('[data-act="check"], [data-act="call"], [data-act="all-in-confirm"], [data-act="arm-all-in-call"]')
          .first();
        if (await btn.isVisible({ timeout: 50 })) await btn.click({ timeout: 500 });
      } catch { /* not this page's turn */ }
    }
    bombSeen = (await anna.locator('#board .board-row').count()) === 2;
    await anna.waitForTimeout(120);
  }
  await check('a bomb pot comes around and deals two boards', bombSeen);
  await check('a bomb pot deals four cards each, not the table\'s game',
    (await anna.locator('.cards-fan.mine .card').count()) === 4);
  await check('the header says what this hand costs',
    (await anna.textContent('#game-badge')).includes('Bomb pot · ante 5'));
  await check('everyone anted into it',
    (await anna.textContent('#pot-line')).includes('15'));
  await check('both boards show where their next card lands',
    (await anna.locator('#board .board-row:nth-child(2) .board-slot').count()) > 0);

  // Back off again — the rest of the run is not a bomb-pot table.
  await openMenu(anna);
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await anna.selectOption('#h-bomb', '0');
  await anna.click('#h-save');
  await anna.click('#h-done');

  // ---- 747 Poker: switch the game mid-session and play a dealer hand ----
  await openMenu(anna);
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
        // A stack-sized call now asks first, so the confirm is part of the
        // ordinary "just keep calling" path a player would take.
        const btn = page
          .locator('[data-act="check"], [data-act="call"], [data-act="all-in-confirm"], [data-act="arm-all-in-call"]')
          .first();
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
  await check('747 header shows the penalty cap',
    (await anna.textContent('#game-badge')).includes('Penalty up to'));
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
  await openMenu(anna);
  await anna.click('#host-menu-btn');
  await anna.waitForSelector('#host-modal:not(.hidden)');
  await anna.selectOption('#h-variant', 'holdem');
  await anna.click('#h-save');
  await anna.click('#h-done');

  // ---- emoji reactions reach the other players ----
  // React is its own top-bar button now — no menu needed.
  await check('React sits in the top bar', await ben.locator('#react-btn').isVisible());
  await check('a guest is offered Sign in on the table',
    await ben.locator('#signin-chip').isVisible());
  await ben.click('#react-btn');
  await ben.waitForSelector('#react-picker:not(.hidden)');
  await ben.click('.react-option[data-emoji="🔥"]');
  await anna.waitForSelector('.floating-reaction');
  const reactionText = await anna.textContent('.floating-reaction');
  await check('a reaction from one player floats up for another', reactionText.includes('🔥'));
  await check('the reaction is attributed', reactionText.includes('Ben'));

  // ---- chat round-trip ----
  // The dock starts folded (the felt is the point), so pulling up the chat is
  // the first thing a player does before typing.
  await ben.click('#panel-toggle');
  await ben.waitForSelector('#chat-input', { state: 'visible' });
  await ben.fill('#chat-input', 'good game everyone');
  await ben.press('#chat-input', 'Enter');
  // Anna still has hers folded: she must be TOLD there is something to read,
  // or a folded dock would quietly swallow the table's chat.
  await anna.waitForFunction(
    () => !document.getElementById('unread-badge').classList.contains('hidden'),
    { timeout: 5000 }
  );
  await check('a folded dock still badges an unread message', true);
  await anna.click('#panel-toggle');
  await anna.waitForSelector('.chat-msg:has-text("good game everyone")');
  await check('chat message delivered to other players', true);

  // ---- ledger: a pop-up, opened beside the chat tabs, closable ----
  await anna.click('#ledger-tab-btn');
  await anna.waitForSelector('#ledger-modal:not(.hidden)');
  await anna.waitForSelector('.sledger .sl-row');
  const nets = await anna.$$eval('.sledger .sl-net', (els) =>
    els.map((el) => parseInt(el.textContent, 10))
  );
  await check('ledger pop-up opens from the chat-side button', true);
  await check('ledger has 3 rows', nets.length === 3);
  await check('ledger nets sum to zero', nets.reduce((a, b) => a + b, 0) === 0);
  await check(
    'ledger sorts winners first',
    nets.every((n, i) => i === 0 || nets[i - 1] >= n)
  );

  // The TABLE TOTAL row cross-foots: with the books balanced, every chip
  // bought in is either back out or still in a stack.
  const totals = await anna.$$eval('.sl-total .sl-num', (els) =>
    els.map((el) => parseInt(el.textContent, 10) || 0)
  );
  await check('table-total row cross-foots', totals[0] === totals[1] + totals[2]);

  // Per-player Details drawer opens, shows the hand info, and closes.
  await anna.click('.sl-row .sl-details');
  await check(
    'a Details drawer opens with hands played',
    (await anna.locator('.sl-more:not(.hidden)').first().textContent()).includes('played')
  );
  await anna.click('.sl-row .sl-details');
  await check(
    'the Details drawer closes again',
    (await anna.locator('.sl-more:not(.hidden)').count()) === 0
  );

  // Settle-up: every payment must be covered by the nets, and the ledger
  // balancing to zero means the suggested transfers square everyone up.
  const settleLines = await anna.$$eval('.settle-list li', (lis) => lis.map((li) => li.textContent));
  const someoneIsUp = nets.some((n) => n > 0);
  await check(
    'settle-up suggests payments when someone is up',
    someoneIsUp ? settleLines.length > 0 : true
  );
  await check('CSV export button is present', await anna.locator('#ledger-csv').isVisible());

  // The books-balance line is the ledger auditing itself, for everyone.
  await check('ledger books balance for the host', await anna.locator('#books-line.ok').isVisible());
  await anna.click('#ledger-close');
  await check('the ledger pop-up closes',
    await anna.locator('#ledger-modal').evaluate((el) => el.classList.contains('hidden')));

  // The Ledger button on the top bar opens the same pop-up for a non-host.
  await ben.click('#ledger-btn');
  await ben.waitForSelector('#ledger-modal:not(.hidden)');
  await ben.waitForSelector('#books-line');
  await check('the top-bar Ledger button opens the pop-up for a guest', true);
  await check('ledger books balance for a guest too', await ben.locator('#books-line.ok').isVisible());
  await ben.click('#ledger-close');

  // The client-format frame: chat docked bottom-left, buttons bottom-right,
  // and the two must never overlap.
  const frame = await anna.evaluate(() => {
    const chat = document.getElementById('side-panel').getBoundingClientRect();
    const bar = document.getElementById('action-bar').getBoundingClientRect();
    return {
      chatLeft: chat.left < innerWidth / 3 && chat.bottom > innerHeight * 0.6,
      barRight: bar.right > (innerWidth * 2) / 3 && bar.bottom > innerHeight * 0.6,
      overlap: chat.right > bar.left && chat.left < bar.right
        && chat.bottom > bar.top && chat.top < bar.bottom,
    };
  });
  await check('chat is docked bottom-left', frame.chatLeft);
  await check('the action buttons sit bottom-right', frame.barRight);
  await check('chat never overlaps the action buttons', !frame.overlap);

  // The dock folds to its tab strip and the felt takes the room back. It
  // starts folded, so open it first and watch the table give the room up.
  const tableBox = () => anna.evaluate(() =>
    JSON.stringify(document.getElementById('table').getBoundingClientRect()));
  const tableH = async () => JSON.parse(await tableBox()).height;
  const tableW = async () => JSON.parse(await tableBox()).width;
  if ((await anna.textContent('#dock-toggle')) === 'Show') {
    const foldedH = await tableH();
    await anna.click('#dock-toggle');
    await anna.waitForTimeout(400);
    await check('pulling up the chat costs the table some room',
      (await tableH()) < foldedH);
  }
  const openH = await tableH();
  await anna.click('#dock-toggle');
  await anna.waitForTimeout(400);
  await check('Hide folds the chat down to its tab strip',
    !(await anna.locator('#tab-chat').isVisible())
    && (await anna.textContent('#dock-toggle')) === 'Show');
  await check('folding the chat gives the table more room', (await tableH()) > openH);
  await check('the felt is a long oval, not a circle', (await tableW()) / (await tableH()) >= 1.8);
  await anna.click('.tab[data-tab="chat"]');
  await anna.waitForTimeout(400);
  await check('picking a tab unfolds the chat again', await anna.locator('#tab-chat').isVisible());

  // Sit out lives behind the menu now — never on the action bar, where a
  // stray tap next to Check could kill a hand.
  await check('no Sit out button on the action bar',
    (await anna.locator('#action-bar [data-act="sit-out"]').count()) === 0);
  await openMenu(anna);
  await check('Sit out lives in the menu Seat group', await anna.locator('#menu-sit').isVisible());
  await anna.keyboard.press('Escape');

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

  // Verifying integrity is a pop-up now, opened from the chip or from
  // Settings > Table > Verify integrity.
  await anna.click('#fair-chip');
  await anna.waitForSelector('#fair-modal:not(.hidden)');
  await check('the shuffle chip opens the integrity pop-up',
    (await anna.textContent('#fair-panel')).length > 0);
  await anna.click('#fair-close');
  await check('the integrity pop-up closes',
    await anna.locator('#fair-modal').evaluate((el) => el.classList.contains('hidden')));
  await openMenu(anna);
  await anna.click('#open-fair');
  await anna.waitForSelector('#fair-modal:not(.hidden)');
  await check('Settings opens Verify integrity too', true);

  await anna.fill('#fair-seed-input', 'smoke-seed-42');
  await anna.click('#fair-seed-form button[type="submit"]');
  await anna.waitForFunction(() =>
    document.getElementById('log-list')?.textContent.includes("set the table's client seed")
  );
  await check('a player can set the table client seed', true);
  await anna.click('#fair-close');

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
  //
  // The felt is an opaque gradient built from --felt, so a host colour has to
  // move the gradient; asserting background-color would pass while the felt
  // stayed the skin's own green, which is exactly the bug this now guards.
  const feltIsPink = (page) => page.waitForFunction(
    () => {
      const t = document.getElementById('table');
      if (!t) return false;
      if (t.style.getPropertyValue('--felt').trim() !== '#7a1f4b') return false;
      // …and it is genuinely what gets painted, not just a variable that is set.
      return getComputedStyle(t).backgroundImage.includes('122, 31, 75');
    },
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
  await check('sign-in offers Keep me signed in, on by default',
    await dana.locator('#a-remember').isChecked());
  await dana.fill('#a-email', 'dana@example.com');
  await dana.fill('#a-password', 'a good long password');
  await dana.click('#a-submit');
  await dana.waitForSelector('.nav-account');
  await check('sign out then sign back in works', true);
  await check('remembered: the session survives closing the browser',
    await dana.evaluate(() => localStorage.getItem('pp:account') !== null));

  // Unchecked, the token lives only for this tab — a shared screen forgets.
  await dana.click('#signout-btn');
  await dana.waitForSelector('#signin-btn');
  await dana.click('#signin-btn');
  await dana.uncheck('#a-remember');
  await dana.fill('#a-email', 'dana@example.com');
  await dana.fill('#a-password', 'a good long password');
  await dana.click('#a-submit');
  await dana.waitForSelector('.nav-account');
  await check('not remembered: signed in for this tab only',
    await dana.evaluate(() =>
      localStorage.getItem('pp:account') === null
      && sessionStorage.getItem('pp:account') !== null));
  await dana.reload();
  await dana.waitForSelector('.nav-account');
  await check('not remembered: a reload keeps you signed in', true);
  await check('the checkbox remembers the choice you made last',
    await dana.evaluate(() => localStorage.getItem('pp:remember') === 'off'));

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
  await openMenu(anna);
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
  await openMenu(anna);
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
  await check('every table skin is offered', skinOptions === 7);
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
  await openMenu(anna);
  await anna.selectOption('#skin', 'tour');
  await anna.keyboard.press('Escape'); // geometry is compared with the sheet shut, like the baseline
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
  // A skin is a complete palette, not a patch: any colour token that resolves
  // to the same value in all three skins is one a skin forgot to override, and
  // the Velvet value leaks into the other rooms. (Structural tokens — radii,
  // widths, ratios — are shared on purpose and are not colours.)
  //
  // The two exceptions are the card stock itself. A room can change its felt,
  // its rails and its chrome, but the deck on the table is one deck: the face
  // is white and the pips are the one red in every skin, so these two ARE
  // meant to be identical everywhere. Card BACKS still vary per skin.
  const SHARED_ON_PURPOSE = ['--card-face', '--card-red'];
  const sharedColours = await anna.evaluate((exempt) => {
    const declared = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!r.selectorText || !r.style) continue;
        if (!/^:root/.test(r.selectorText)) continue;
        for (let i = 0; i < r.style.length; i++) {
          const prop = r.style[i];
          if (prop.startsWith('--')) declared.add(prop);
        }
      }
    }
    const root = document.documentElement;
    const before = root.dataset.skin;
    const skins = ['velvet', 'tour', 'series', 'cwru', 'wabash', 'classic', 'redhawk'];
    const values = {};
    for (const skin of skins) {
      root.dataset.skin = skin;
      const cs = getComputedStyle(root);
      values[skin] = Object.fromEntries([...declared].map((t) => [t, cs.getPropertyValue(t).trim()]));
    }
    root.dataset.skin = before;
    return [...declared].filter((t) => {
      if (exempt.includes(t)) return false;
      const v = values.velvet[t];
      if (!v || !CSS.supports('color', v)) return false;
      return skins.slice(1).every((s) => values[s][t] === v);
    });
  }, SHARED_ON_PURPOSE);
  await check(`no colour token is left on the Velvet value in every skin (${JSON.stringify(sharedColours)})`,
    sharedColours.length === 0);

  await openMenu(anna);
  await anna.selectOption('#skin', 'velvet');
  await anna.keyboard.press('Escape');
  await anna.waitForTimeout(200);

  // ---- a lost invite link is not a lost ledger: the home page lists the
  // tables this device sat at, with the saved ledger a tap away ----
  await ben.goto(base);
  await ben.waitForSelector('#recent-tables:not(.hidden)');
  const gameCode = gameUrl.split('/').pop();
  await check('the home page lists the table this device played at',
    (await ben.evaluate(() => document.getElementById('recent-list').innerHTML)).includes(gameCode));
  await check('the recent-table ledger link serves the saved CSV',
    (await ben.evaluate(async (id) =>
      (await fetch(`/api/games/${id}/ledger.csv`)).status, gameCode)) === 200);

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
