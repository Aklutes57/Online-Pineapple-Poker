// The hand replay's board. It is a browser gate because the failure was
// purely visual and silent: every ordinary replay drew its five community
// cards as a vertical column down the middle of the felt, and only
// run-it-twice replays looked right — those were the ones whose cards got
// wrapped in a row.
// Usage: node test/replay-ui.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-rp-')), 'test.db');
const { chromium } = await import('playwright');
const { buildServer } = await import('../server/app.js');
const { EVENTS } = await import('../shared/constants.js');
const { httpServer } = buildServer();
await new Promise(r => httpServer.listen(0, r));
const base = 'http://localhost:' + httpServer.address().port;
const { io: ioc } = await import('socket.io-client');
const sock = (g,t,n,seat) => new Promise(res => { const s = ioc(base,{transports:['websocket'],extraHeaders:{Origin:base},reconnection:false});
  s.on('connect',()=>s.emit(EVENTS.JOIN,{gameId:g,token:t,nickname:n},(r)=>{s.emit(EVENTS.REQUEST_SEAT,{nickname:n,buyIn:200,seatIndex:seat});res({s,r});}));});
const created = await (await fetch(base+'/api/games',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:'Host',settings:{}})})).json();
const host = await sock(created.gameId, created.token, 'Host', 0);
const p1 = await sock(created.gameId, null, 'P1', 1);
await new Promise(r=>setTimeout(r,250));
host.s.emit(EVENTS.HOST_APPROVE_SEAT,{playerId:p1.r.playerId,approve:true});
await new Promise(r=>setTimeout(r,300));
// Check it down to a showdown so a full five-card board is saved.
for (const o of [host,p1]) o.s.on(EVENTS.STATE, (st) => {
  const av = st.you?.availableActions; if (!av || !st.hand) return;
  o.s.emit(EVENTS.ACTION,{handId:st.hand.handId, action: av.canCheck ? 'check' : 'call'});
});
host.s.emit(EVENTS.HOST_START_GAME,{});
await new Promise(r=>setTimeout(r,6000));
const hands = await (await fetch(base+'/api/games/'+created.gameId+'/hands')).json();
const handId = hands.hands?.[0]?.id;
console.log('saved hand:', handId || '(none)');

const args=['--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync'];
let browser; try { browser = await chromium.launch({args}); } catch { browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args}); }
const ctx = await browser.newContext({ viewport:{width:1280,height:800} });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(base+'/hands/'+handId,{waitUntil:'domcontentloaded'});
await page.waitForSelector('#board .card', { timeout: 8000 });
await page.waitForTimeout(600);
const m = await page.evaluate(() => {
  const cards=[...document.querySelectorAll('#board .card')].map(c=>{const b=c.getBoundingClientRect();return {l:Math.round(b.left),t:Math.round(b.top)};});
  const tops=new Set(cards.map(c=>c.t)), lefts=new Set(cards.map(c=>c.l));
  return { count:cards.length, distinctTops:tops.size, distinctLefts:lefts.size,
    layout: tops.size===1 && lefts.size===cards.length ? 'ROW (correct)'
          : lefts.size===1 ? 'COLUMN (the bug)' : 'mixed',
    rows: document.querySelectorAll('#board .board-row').length };
});

let bad = 0;
const check = (name, cond) => { console.log(`  ${cond ? '\u2713' : '\u2717'} ${name}`); if (!cond) bad++; };
check(`the whole board is shown (${m.count} cards)`, m.count === 5);
// #board stacks its children vertically so a second board sits under the
// first. Cards appended straight into it therefore came out as a column
// running down the middle of the felt, which is what this catches.
check(`the board lies in a row, not a column (${m.layout})`, m.layout === 'ROW (correct)');
check('every card is on the same line', m.distinctTops === 1);
check('and none of them sit on top of each other', m.distinctLefts === m.count);
check('the cards are wrapped in a board row', m.rows === 1);
await browser.close(); for (const o of [host,p1]) o.s.disconnect();
await new Promise(r=>httpServer.close(r));
console.log(bad === 0 ? 'REPLAY-UI: all good' : `REPLAY-UI: ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
