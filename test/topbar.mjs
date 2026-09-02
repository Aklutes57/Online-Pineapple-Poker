// The top bar's sliding row of controls.
//
// Three things have to hold, and all three were broken:
//   1. It slides ONLY when the buttons genuinely cannot fit the screen. They
//      used to slide with hundreds of pixels going spare, because an empty
//      counterweight div reserved a full mirror of the table's name — at 760px
//      it kept 267px for nothing and left a 333px row of buttons 170px.
//   2. When it does slide, the range is exactly the overflow and the first
//      button is reachable. `justify-content: center` split the overflow to
//      both sides and put the left half before the scroll origin, where no
//      scroll position can reach it.
//   3. A slide survives a re-render. syncTopBar() rewrote the counterweight's
//      width on every state update, re-laying-out the flex row and dropping
//      the scroll position — mid-slide, on every tick of the fold clock.
//
// Usage: node test/topbar.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-topbar-')), 'test.db');

const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { httpServer } = buildServer();
await new Promise((r) => httpServer.listen(0, r));
const base = `http://localhost:${httpServer.address().port}`;

const args = ['--disable-background-networking', '--disable-component-update', '--no-first-run'];
let browser;
try { browser = await chromium.launch({ args }); }
catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args }); }
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));

await page.goto(base);
await page.click('#start-btn');
await page.fill('#c-nickname', 'Anna');
await page.selectOption('#c-variant', 'holdem');
await page.click('#c-create');
await page.waitForURL('**/games/**');
const url = page.url();
await page.click('.empty-seat-btn');
await page.click('#j-request');
await page.waitForSelector('.seat.me .nameplate');

let bad = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) bad++; };

// How the bar shares its width, and what the buttons actually need.
const layout = () => page.evaluate(() => {
  const bar = document.getElementById('top-bar');
  const actions = document.querySelector('.top-actions');
  const meta = document.querySelector('.top-meta');
  const spacer = document.querySelector('.top-spacer');
  const kids = [...actions.children].filter((k) => k.getClientRects().length > 0);
  const gap = parseFloat(getComputedStyle(actions).columnGap) || 0;
  const need = Math.ceil(kids.reduce((a, k) => a + k.getBoundingClientRect().width, 0)
    + gap * (kids.length - 1));
  const box = actions.getBoundingClientRect();
  return {
    window: window.innerWidth,
    barWidth: Math.round(bar.getBoundingClientRect().width),
    meta: Math.round(meta.getBoundingClientRect().width),
    spacer: Math.round(spacer.getBoundingClientRect().width),
    actions: Math.round(box.width),
    need,
    buttons: kids.length,
    range: Math.round(actions.scrollWidth - actions.clientWidth),
    scrollLeft: Math.round(actions.scrollLeft),
    // Negative means there is slack; positive means it is cut off.
    firstClipped: Math.round(box.left - kids[0].getBoundingClientRect().left),
  };
});

console.log('\n-- it must not slide while the screen has room --');
for (const [w, h] of [[1280, 800], [1100, 800], [1024, 768], [900, 700], [800, 700], [760, 700]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(350);
  const m = await layout();
  const roomOnScreen = m.need + m.meta <= m.window;
  check(`${w}px: ${m.buttons} buttons need ${m.need}px, given ${m.actions}px`
    + ` — ${m.range > 0 ? `slides ${m.range}px` : 'no slide'}`,
    roomOnScreen ? m.range === 0 : true);
}

// The counterweight is sized in pixels, so it is stale until something
// recomputes it — and "something" used to be an interval tick a few frames
// later, which is long enough to watch the row jump into sliding and back.
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(400);
await page.setViewportSize({ width: 800, height: 700 });
// By the frame after the resize the bar must already be right. Note this does
// NOT isolate the recompute in relayout(): an interval tick also calls
// syncTopBar and corrects a stale counterweight ~50ms later, which is inside
// this window. Measured directly, removing the relayout call leaves the row
// sliding 123px for that ~50ms — a visible jump — but the two paths race and
// no stable assertion separates them, so this check is a floor, not a proof.
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const immediately = await layout();
check(`a resize does not leave the row sliding even for a frame`
  + ` (spacer ${immediately.spacer}px, slides ${immediately.range}px)`,
  immediately.range === 0);

// Centring is what the counterweight is for, and it has to survive the fix.
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(350);
const wide = await layout();
check(`on a wide screen the counterweight still centres the row (spacer ${wide.spacer}px vs meta ${wide.meta}px)`,
  Math.abs(wide.spacer - wide.meta) <= 2);

// Now force a genuine overflow: turn the table's straddle on, which adds two
// more buttons, and go narrow enough that they truly cannot fit.
await page.click('#menu-toggle');
await page.waitForSelector('#top-menu:not(.hidden)');
await page.click('#host-menu-btn');
await page.waitForSelector('#host-modal:not(.hidden)');
await page.check('#h-straddle');
await page.click('#h-save');
await page.waitForTimeout(500);
// Reload rather than trying to dismiss the modal — the setting is on the
// server now, and a fresh page is the state a player would actually see.
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.setViewportSize({ width: 760, height: 700 });
await page.waitForSelector('#straddle-btn:not(.hidden)', { timeout: 8000 });
await page.waitForTimeout(600);

console.log('\n-- when it genuinely cannot fit --');
const tight = await layout();
check(`${tight.buttons} buttons need ${tight.need}px in ${tight.actions}px, so it slides (${tight.range}px)`,
  tight.range > 0);
check('the counterweight has given up all its width first',
  tight.spacer === 0);
check('and the first button is reachable at rest, not stranded left of the origin',
  tight.firstClipped <= 0);

const reach = await page.evaluate(async () => {
  const actions = document.querySelector('.top-actions');
  actions.scrollLeft = 99999;
  await new Promise((d) => setTimeout(d, 250));
  const box = actions.getBoundingClientRect();
  const kids = [...actions.children].filter((k) => k.getClientRects().length > 0);
  const last = kids[kids.length - 1].getBoundingClientRect();
  return {
    at: Math.round(actions.scrollLeft),
    max: Math.round(actions.scrollWidth - actions.clientWidth),
    lastStillClipped: Math.round(last.right - box.right),
  };
});
check(`sliding right reaches the end (${reach.at} of ${reach.max}) and shows the last button`,
  reach.at === reach.max && reach.lastStillClipped <= 1);

// The bug the report was about: it resets while you slide it over. Slide to
// the END, which is where you are when you have slid over to reach the last
// button — and where a re-render's momentary re-layout clamps the position and
// then fails to put it back. A position in the middle of the range survives
// the same re-render, so testing one would prove nothing.
await page.evaluate(() => {
  const actions = document.querySelector('.top-actions');
  actions.scrollLeft = actions.scrollWidth - actions.clientWidth;
});
const held = await page.evaluate(async () => {
  const actions = document.querySelector('.top-actions');
  const start = Math.round(actions.scrollLeft);
  let worst = start;
  for (let i = 0; i < 30; i++) {
    await new Promise((d) => setTimeout(d, 100));
    const now = Math.round(actions.scrollLeft);
    if (Math.abs(now - start) > Math.abs(worst - start)) worst = now;
  }
  return { start, worst, ended: Math.round(actions.scrollLeft) };
});
check(`the slide holds for 3s of live state updates (set ${held.start}, worst ${held.worst}, ended ${held.ended})`,
  Math.abs(held.worst - held.start) <= 2);

// …and across a re-render provoked deliberately. The straddle switch has a
// twin in the settings sheet, and that is the one to use: clicking the bar's
// own button would focus a control scrolled out of view at the START of the
// row, and the browser then scrolls it into view — correct behaviour, and
// nothing to do with the bug. Toggling from outside the bar relabels a button
// inside it with no focus of its own.
await page.click('#menu-toggle');
await page.waitForSelector('#top-menu:not(.hidden)');
await page.click('#menu-straddle');
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const afterToggle = await page.evaluate(() => {
  const actions = document.querySelector('.top-actions');
  return {
    at: Math.round(actions.scrollLeft),
    max: Math.round(actions.scrollWidth - actions.clientWidth),
  };
});
check(`a button relabelled from outside the bar does not move the slide`
  + ` (at ${afterToggle.at} of ${afterToggle.max})`,
  afterToggle.max > 0 && afterToggle.at === afterToggle.max);

await browser.close();
await new Promise((r) => httpServer.close(r));
console.log(bad === 0 ? 'TOPBAR: all good' : `TOPBAR: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
