// The all-in confirm, driven through a real browser: every route to "all of
// it" — the All in button, the tray sized to the top, and a call that costs
// your whole stack — must ask before a chip moves, and must actually commit
// once you say yes. Chips are read off your own nameplate, so this asserts
// what the table shows, not what the client thinks.
//
// Kept out of `npm test` (it needs Chromium); run it with `npm run allin`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-ai-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');

const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;

let bad = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${name}`);
  if (!cond) bad++;
};

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium' })
  .catch(() => chromium.launch());
const mk = async () =>
  (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

// ---- two players, one hand ----
const anna = await mk();
await anna.goto(base);
await anna.click('#start-btn');
await anna.fill('#c-nickname', 'Anna');
await anna.selectOption('#c-variant', 'holdem');
await anna.click('#c-create');
await anna.waitForURL('**/games/**');
const url = anna.url();
await anna.click('.empty-seat-btn');
await anna.click('#j-request');
await anna.waitForSelector('.seat.me .nameplate');

const ben = await mk();
await ben.goto(url);
await ben.click('.empty-seat-btn');
await ben.fill('#j-nickname', 'Ben');
await ben.click('#j-request');
await anna.waitForSelector('#seat-requests button[data-approve="yes"]', { timeout: 10000 });
await anna.locator('#seat-requests button[data-approve="yes"]').first().click();
await ben.waitForSelector('.seat.me .nameplate');

await anna.click('#start-game-btn');
await anna.waitForSelector('.cards-fan.mine .card');

// No client handle on window, so read the stack off your own nameplate.
const stackOf = async (p) =>
  parseInt((await p.textContent('.seat.me .np-stack')).replace(/[^0-9-]/g, ''), 10);
const shrank = (p, from) =>
  p.waitForFunction(
    (b) =>
      parseInt(
        document.querySelector('.seat.me .np-stack').textContent.replace(/[^0-9-]/g, ''),
        10
      ) < b,
    from,
    { timeout: 5000 }
  ).then(() => true, () => false);

const findShover = async () => {
  for (let i = 0; i < 60; i++) {
    for (const [p, n] of [[anna, 'Anna'], [ben, 'Ben']]) {
      if (await p.locator('[data-act="arm-all-in"]').isVisible().catch(() => false)) return [p, n];
    }
    await anna.waitForTimeout(150);
  }
  return [null, null];
};

const [shover, name] = await findShover();
check('someone is offered the All in button', !!shover);
const before = await stackOf(shover);

// ---- route 1: the tray, sized all the way to the top ----
await shover.click('[data-act="open-tray"]');
await shover.waitForSelector('.preset-allin');
await shover.click('.preset-allin');
await shover.click('[data-act="confirm-raise"]');
await shover.waitForSelector('.ab-allin-ask', { timeout: 3000 });
check('the tray maxed out asks before it shoves', true);
check('arming from the tray does not move a chip', (await stackOf(shover)) === before);
await shover.click('[data-act="cancel-all-in"]');
await shover.waitForSelector('.ab-allin-ask', { state: 'detached' });
check('Cancel hands the betting row back',
  await shover.locator('[data-act="open-tray"]').isVisible());

// ---- route 2: the All in button, confirmed ----
await shover.click('[data-act="arm-all-in"]');
await shover.waitForSelector('.ab-allin-ask');
check('the question names the whole stack',
  (await shover.textContent('.ab-allin-ask')).includes('Are you sure you want to go all in?'));
check('arming does not move a chip', (await stackOf(shover)) === before);
await shover.click('[data-act="all-in-confirm"]');
check(`${name}'s confirm commits the stack`, await shrank(shover, before));
check('the shove empties the stack', (await stackOf(shover)) === 0);

// ---- route 3: the other player's call now costs everything ----
const caller = shover === anna ? ben : anna;
await caller.waitForSelector('[data-act="arm-all-in-call"], [data-act="call"]', { timeout: 5000 });
const armed = await caller.locator('[data-act="arm-all-in-call"]').isVisible().catch(() => false);
check('a call that costs the whole stack arms instead of calling', armed);
if (armed) {
  const cBefore = await stackOf(caller);
  await caller.click('[data-act="arm-all-in-call"]');
  await caller.waitForSelector('.ab-allin-ask');
  check('the call asks the same question',
    (await caller.textContent('.ab-allin-ask')).includes('Are you sure you want to go all in?'));
  check('arming the call does not move a chip', (await stackOf(caller)) === cBefore);
  await caller.click('[data-act="all-in-confirm"]');
  check('the call confirm commits', await shrank(caller, cBefore));
}

await browser.close();
httpServer.close();
console.log(bad ? `allin: FAILED (${bad})` : 'allin: all checks passed');
process.exit(bad ? 1 : 0);
