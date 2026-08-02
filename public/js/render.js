// Renders the whole table from a single state object. Every function here is
// an idempotent function of `client.state` / `client.you`; regions only
// rebuild their DOM when their content signature changes, so CSS deal
// animations fire once per new card.

import {
  SEAT_COUNT, SEAT_COORDS, BET_COORDS, SEAT_COORDS_PORTRAIT, BET_COORDS_PORTRAIT,
  VARIANTS, GAME_STATUS, PHASES, EVENTS,
} from '/shared/constants.js';
import { makeCardEl, makeCardBack } from '/js/cards.js';
import { escapeHtml } from '/js/ui.js';
import { renderActionBar, openJoinModal } from '/js/actionBar.js';

const seatsLayer = () => document.getElementById('seats-layer');
const betsLayer = () => document.getElementById('bets-layer');

export function renderAll(client) {
  const { state, you } = client;
  if (!state) return;
  lastClient = client;
  // Settle which way the table lies BEFORE placing anything, so seats and
  // chips are laid out against the shape they will actually be drawn on.
  fitTableStage();
  renderTheme(client);
  renderHeader(client);
  renderSeats(client);
  renderBets(client);
  renderBoard(client);
  renderCenter(client);
  renderActionBar(client);
  document.getElementById('host-menu-btn').classList.toggle('hidden', !you?.isHost);
  document.getElementById('leave-btn').classList.toggle('hidden', !you || you.spectator);
  // The action bar's height can change with its contents, which can change the
  // space left for the table — refit, and re-place if that flipped the shape.
  relayout();
}

// Scale the whole table (felt + seats + bets, all positioned inside #table) as
// one piece to fit the available area on any device. The felt plus a 40px seat
// overhang on every side is the logical stage; we shrink or gently grow it to
// fill the space, so it always fits whole and never clips or scrolls.
//
// The table comes in two shapes and we pick whichever suits the space: the
// usual 900×504 landscape oval, or — when the area is taller than it is wide,
// i.e. a phone held upright — the same table stood on its end (504×900). A
// portrait phone then gets a genuinely vertical table filling the screen
// instead of a letterboxed landscape one shrunk to a third of the size.
// How far seat pods reach past the felt, measured from a full ten-handed
// table. A pod is centred on its point, so it always spills over the rim —
// budget too little and the bottom seat gets shaved off by the area's overflow
// clip; budget too much and the table is needlessly small. Pods spill much
// further vertically than sideways, and further sideways on the wide table, so
// each shape gets its own allowance. A webcam tile makes every pod taller, so
// that cost is only paid when cameras are actually on.
const OVERHANG = {
  landscape: { x: 44, y: 80 },
  upright: { x: 16, y: 68 },
};
const CAM_EXTRA_Y = 34; // half a webcam tile, top and bottom
const FELT_LONG = 900;
const FELT_SHORT = 504;

let portrait = false;

// Which way the table should lie, from the space we actually have to fill.
// Measured on the area (whose size never depends on the table's), so choosing
// a shape can't feed back into the measurement.
function measureArea() {
  const area = document.getElementById('table-area');
  if (!area) return null;
  const cs = getComputedStyle(area);
  const w = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return w > 0 && h > 0 ? { w, h } : null;
}

export function isPortraitTable() {
  return portrait;
}

export function seatCoord(slot) {
  return (portrait ? SEAT_COORDS_PORTRAIT : SEAT_COORDS)[slot];
}

export function betCoord(slot) {
  return (portrait ? BET_COORDS_PORTRAIT : BET_COORDS)[slot];
}

export function fitTableStage() {
  const table = document.getElementById('table');
  const area = measureArea();
  if (!table || !area) return;

  portrait = area.h > area.w;
  table.classList.toggle('upright', portrait);

  const feltW = portrait ? FELT_SHORT : FELT_LONG;
  const feltH = portrait ? FELT_LONG : FELT_SHORT;
  const pad = portrait ? OVERHANG.upright : OVERHANG.landscape;
  const camY = document.querySelector('#seats-layer video.seat-cam') ? CAM_EXTRA_Y : 0;
  const scale = Math.min(
    area.w / (feltW + pad.x * 2),
    area.h / (feltH + (pad.y + camY) * 2),
    1.25
  );
  table.style.transform = `scale(${scale.toFixed(4)})`;
}

// Rotating the phone changes which shape fits, so the seats and chips have to
// move too — re-place them, then refit. Cheap: seat contents are sig-guarded,
// so this only rewrites the coordinates.
let lastClient = null;
function relayout() {
  const was = portrait;
  fitTableStage();
  if (portrait !== was && lastClient?.state) {
    placeSeats(lastClient);
    renderBets(lastClient);
  }
}

// Refit on any viewport change (rotation, resize, on-screen keyboard, etc.).
if (typeof window !== 'undefined') {
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', () => setTimeout(relayout, 200));
}

// The host's saved table look. Applied as inline styles so it overrides
// table.css while the oval, rail and inner shadow all stay intact.
function renderTheme(client) {
  const theme = client.state.settings.tableTheme;
  const table = document.getElementById('table');
  const sig = JSON.stringify(theme || null);
  if (table.dataset.themeSig === sig) return;
  table.dataset.themeSig = sig;

  if (!theme) {
    table.style.backgroundImage = '';
    table.style.backgroundColor = '';
    table.style.borderColor = '';
    return;
  }
  // The image wins when there is one; the colour is the fallback underneath.
  table.style.backgroundImage = theme.feltImage ? `url("${theme.feltImage}")` : '';
  table.style.backgroundSize = theme.feltImage ? 'cover' : '';
  table.style.backgroundPosition = 'center';
  table.style.backgroundColor = theme.feltColor || '';
  table.style.borderColor = theme.railColor || '';
}

function renderHeader(client) {
  const { state } = client;
  // A live hand always shows the game it was dealt as, even if the host has
  // already switched the table's game for the next hand.
  const variantKey = state.hand?.variant || state.settings.variant;
  const v = VARIANTS[variantKey];
  const badge = document.getElementById('game-badge');
  const handNo = state.hand ? ` · Hand #${state.hand.handNo}` : '';
  // 747 is an ante game — there are no blinds to advertise.
  const stakes = v?.engine === '747'
    ? `Ante ${state.settings.bigBlind}`
    : `Blinds ${state.settings.smallBlind}/${state.settings.bigBlind}`;
  badge.textContent = `${v ? v.label : variantKey} · ${stakes}${handNo}`;
}

// ---- seats ----

function displaySlot(seatIndex, client) {
  const mySeat = client.you?.seatIndex ?? 0;
  return (seatIndex - mySeat + SEAT_COUNT) % SEAT_COUNT;
}

// Position every seat pod around whichever oval we're using. Split out from
// the content render so rotating the phone can re-place the ring on its own.
function placeSeats(client) {
  const layer = seatsLayer();
  if (!layer) return;
  for (let i = 0; i < SEAT_COUNT; i++) {
    const pod = layer.querySelector(`[data-seat="${i}"]`);
    if (!pod) continue;
    const coord = seatCoord(displaySlot(i, client));
    pod.style.left = coord.left + '%';
    pod.style.top = coord.top + '%';
  }
}

function renderSeats(client) {
  const { state } = client;
  const layer = seatsLayer();

  for (let i = 0; i < SEAT_COUNT; i++) {
    let pod = layer.querySelector(`[data-seat="${i}"]`);
    if (!pod) {
      pod = document.createElement('div');
      pod.className = 'seat';
      pod.dataset.seat = i;
      layer.appendChild(pod);
    }
    const seat = state.seats[i];
    if (!seat) {
      renderEmptySeat(pod, i, client);
    } else {
      renderPlayerSeat(pod, seat, i, client);
    }
  }
  placeSeats(client);
}

function renderEmptySeat(pod, seatIndex, client) {
  const { you, state } = client;
  const canAsk = you && you.status === 'spectating' && state.status !== GAME_STATUS.CLOSED;
  const sig = `empty:${canAsk}`;
  if (pod.dataset.sig === sig) return;
  pod.dataset.sig = sig;
  pod.className = 'seat empty';
  pod.innerHTML = canAsk
    ? `<button class="empty-seat-btn">Sit<br>here</button>`
    : `<div class="empty-label">Empty</div>`;
  if (canAsk) {
    pod.querySelector('button').onclick = () => openJoinModal(client, seatIndex);
  }
}

function renderPlayerSeat(pod, seat, seatIndex, client) {
  const { state, you } = client;
  const hand = state.hand;
  const isMe = you && you.seatIndex === seatIndex;
  const toAct = hand && !hand.finished && hand.toActSeat === seatIndex;
  const discardPhase = hand && (hand.phase === PHASES.DISCARD_PREFLOP || hand.phase === PHASES.DISCARD_POSTFLOP);
  const waitingDiscard = discardPhase && seat.inHand && !seat.folded && seat.cardCount === 3;

  const myCards = isMe && you.holeCards ? you.holeCards : null;
  const shownCards = seat.cards || myCards;
  const won = seat.handResult && seat.handResult.won > 0;

  const decisionPhase = hand && hand.phase === PHASES.DECISION_747;
  const myHandNow = isMe && !seat.folded ? you?.handNow : null;

  const sig = JSON.stringify([
    seat.playerId, seat.nickname, seat.stack, seat.connected, seat.sittingOut,
    seat.inHand, seat.folded, seat.allIn, seat.cardCount, shownCards,
    seat.isDealer, toAct, waitingDiscard, seat.handResult,
    isMe, you?.canDiscard, you?.hasDiscarded,
    decisionPhase ? seat.decided : null, myHandNow,
    hand && !hand.finished ? hand.lastAction?.seat === seatIndex && JSON.stringify(hand.lastAction) : null,
  ]);
  if (pod.dataset.sig === sig) return;
  pod.dataset.sig = sig;

  pod.className = 'seat occupied'
    + (isMe ? ' me' : '')
    + (toAct ? ' to-act' : '')
    + (seat.folded ? ' folded' : '')
    + (seat.sittingOut ? ' away' : '')
    + (!seat.connected ? ' disconnected' : '')
    + (won ? ' winner' : '');

  // Cards fan. A folded seat normally shows nothing, but a folder who
  // voluntarily shows (seat.cards set) gets their cards rendered — the
  // pod's folded styling keeps them visibly dead.
  const fan = document.createElement('div');
  fan.className = 'cards-fan' + (isMe ? ' mine' : '');
  if (seat.inHand && seat.folded && seat.cards) {
    for (const c of seat.cards) fan.appendChild(makeCardEl(c, { dealt: true }));
  } else if (seat.inHand && !seat.folded) {
    if (shownCards) {
      for (let ci = 0; ci < shownCards.length; ci++) {
        const card = makeCardEl(shownCards[ci], {
          dealt: true,
          discardable: isMe && you.canDiscard,
        });
        if (isMe && you.canDiscard) {
          card.onclick = () => client.send(EVENTS.DISCARD, { handId: hand.handId, cardIndex: ci });
        }
        fan.appendChild(card);
      }
    } else {
      for (let ci = 0; ci < seat.cardCount; ci++) fan.appendChild(makeCardBack());
    }
  }

  // Nameplate.
  const plate = document.createElement('div');
  plate.className = 'nameplate';
  const statusBits = [];
  if (!seat.connected) statusBits.push('offline');
  else if (seat.sittingOut) statusBits.push('away');
  if (seat.allIn) statusBits.push('all-in');
  if (waitingDiscard) statusBits.push('discarding…');
  // 747 decision phase: THAT a player locked in is public, never which way.
  if (decisionPhase && seat.inHand && !seat.folded) {
    statusBits.push(seat.decided ? 'locked in ✓' : 'deciding…');
  }
  plate.innerHTML = `
    <div class="np-row">
      <span class="np-name">${escapeHtml(seat.nickname)}</span>
      <span class="np-stack">${seat.stack}</span>
    </div>
    ${statusBits.length ? `<div class="np-status">${statusBits.join(' · ')}</div>` : ''}
    <div class="timer-bar hidden"><div class="timer-fill"></div></div>
  `;

  // Result / last-action bubble.
  let bubble = '';
  if (seat.handResult) {
    const r = seat.handResult;
    bubble = `<div class="np-bubble ${r.won > 0 ? 'win' : ''}">${
      r.won > 0 ? `+${r.won}` : ''
    }${r.desc ? `${r.won > 0 ? ' · ' : ''}${escapeHtml(r.desc)}` : ''}</div>`;
  } else if (hand && !hand.finished && hand.lastAction && hand.lastAction.seat === seatIndex) {
    const a = hand.lastAction;
    const text =
      a.action === 'fold' ? 'fold'
      : a.action === 'check' ? 'check'
      : a.action === 'call' ? `call ${a.amount}`
      : `${a.action === 'bet' ? 'bet' : 'raise'} ${a.amount}`;
    bubble = `<div class="np-bubble">${text}</div>`;
  }

  pod.innerHTML = '';
  pod.appendChild(fan);
  // Live "what do I have" readout — private, shown only under your own fan.
  if (myHandNow) {
    const now = document.createElement('div');
    now.className = 'hand-now' + (myHandNow === 'NATURAL SEVEN' ? ' natural' : '');
    now.textContent = myHandNow;
    pod.appendChild(now);
  }
  if (seat.isDealer) {
    const disc = document.createElement('div');
    disc.className = 'dealer-disc';
    disc.textContent = 'D';
    plate.appendChild(disc);
  }
  pod.appendChild(plate);
  if (bubble) plate.insertAdjacentHTML('beforeend', bubble);
  if (isMe && you.hasDiscarded && discardPhase) {
    plate.insertAdjacentHTML('beforeend', '<div class="np-bubble">discarded ✓</div>');
  }
}

// ---- bets ----

function renderBets(client) {
  const { state } = client;
  const layer = betsLayer();
  const hand = state.hand;
  const parts = [];
  if (hand && !hand.finished) {
    for (let i = 0; i < SEAT_COUNT; i++) {
      const seat = state.seats[i];
      if (seat && seat.betThisRound > 0) parts.push([i, seat.betThisRound]);
    }
  }
  // Orientation is part of the signature: turning the phone moves every chip.
  const sig = JSON.stringify([parts, client.you?.seatIndex, portrait]);
  if (layer.dataset.sig === sig) return;
  layer.dataset.sig = sig;
  layer.innerHTML = '';
  for (const [seatIndex, amount] of parts) {
    const slot = displaySlot(seatIndex, client);
    const coord = betCoord(slot);
    const chip = document.createElement('div');
    chip.className = 'bet-chip';
    chip.style.left = coord.left + '%';
    chip.style.top = coord.top + '%';
    chip.textContent = amount;
    layer.appendChild(chip);
  }
}

// ---- board & pot ----

function renderBoard(client) {
  const { state } = client;
  const hand = state.hand;
  const board = document.getElementById('board');
  const potLine = document.getElementById('pot-line');

  // 747: the center shows the dealer's hand, not a community board (the
  // server reuses `board` for the revealed dealer cards, so skip it here).
  if (hand?.dealer) {
    renderDealer(board, hand);
    renderPotLine(potLine, state, hand);
    return;
  }
  board.classList.remove('dealer-area');

  const cards = hand ? hand.board : [];
  const second = hand?.board2 || null;
  const rabbit = hand?.rabbit || null;
  const sig = `${cards.join(',')}|${(second || []).join(',')}|${(rabbit || []).join(',')}`;
  if (board.dataset.sig !== sig) {
    board.dataset.sig = sig;
    board.innerHTML = '';
    board.classList.toggle('two-boards', !!second);

    const firstRow = document.createElement('div');
    firstRow.className = 'board-row';
    for (const c of cards) firstRow.appendChild(makeCardEl(c, { dealt: true }));
    // Rabbit hunt cards are the run-out that never happened — shown dimmed
    // so they can't be mistaken for the real board.
    if (rabbit) {
      for (const c of rabbit) {
        const el = makeCardEl(c, { dealt: true });
        el.classList.add('rabbit');
        firstRow.appendChild(el);
      }
    }
    board.appendChild(firstRow);

    if (second) {
      const secondRow = document.createElement('div');
      secondRow.className = 'board-row';
      for (const c of second) secondRow.appendChild(makeCardEl(c, { dealt: true }));
      board.appendChild(secondRow);
    }
  }

  renderPotLine(potLine, state, hand);
}

function renderPotLine(potLine, state, hand) {
  // A riding 747 pot only sits at game level BETWEEN hands (it becomes the
  // next hand's carry-in), so both lines can never double-count.
  const riding = state.carryPot > 0 ? `Riding pot: ${state.carryPot}` : '';
  let potText = '';
  if (hand && (hand.collectedPot > 0 || hand.potTotal > 0)) {
    if (hand.finished && hand.pots) {
      const total = hand.pots.reduce((a, p) => a + p.amount, 0);
      potText = hand.pots.length > 1
        ? `Pot: ${total} (${hand.pots.map((p) => p.amount).join(' + ')})`
        : `Pot: ${total}`;
    } else {
      potText = `Pot: ${hand.collectedPot}`;
    }
  }
  const text = [potText, riding].filter(Boolean).join(' · ');
  potLine.classList.toggle('hidden', !text);
  potLine.textContent = text;
}

// The 747 dealer's hand in the middle of the table: card backs while the
// hand is live, the revealed five (with its description) at showdown.
function renderDealer(board, hand) {
  const d = hand.dealer;
  const sig = `dealer:${d.cardCount}:${(d.cards || []).join(',')}:${d.desc || ''}`;
  if (board.dataset.sig === sig) return;
  board.dataset.sig = sig;
  board.classList.add('dealer-area');
  board.classList.remove('two-boards');
  board.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'dealer-title';
  label.textContent = d.desc ? `Dealer — ${d.desc}` : 'Dealer';
  board.appendChild(label);

  const row = document.createElement('div');
  row.className = 'board-row';
  if (d.cards) {
    for (const c of d.cards) row.appendChild(makeCardEl(c, { dealt: true }));
  } else {
    for (let i = 0; i < d.cardCount; i++) row.appendChild(makeCardBack());
  }
  board.appendChild(row);
}

// ---- center message ----

function renderCenter(client) {
  const { state, you } = client;
  const el = document.getElementById('center-message');
  let html = '';

  if (state.status === GAME_STATUS.LOBBY) {
    if (you?.isHost) {
      const seated = state.seats.filter(Boolean).length;
      html = `
        <p>Share the invite link, approve seats, then deal the first hand.</p>
        <button class="btn btn-green" id="start-game-btn" ${seated < 2 ? 'disabled' : ''}>
          ▶ Start the game
        </button>`;
    } else {
      html = '<p>Waiting for the host to start the game…</p>';
    }
  } else if (state.status === GAME_STATUS.PAUSED) {
    html = `<p>Game paused${you?.isHost ? ' — resume from the Host menu' : ''}</p>`;
  } else if (state.pauseRequested) {
    html = '<p>Pausing after this hand…</p>';
  } else if (state.hand && !state.hand.finished && state.hand.phase === PHASES.COUNTDOWN_747) {
    // The number itself ticks in the timer loop between broadcasts.
    html = '<div class="countdown-747" id="cd747-num">3</div>';
  } else if (state.hand?.finished) {
    let natural = state.hand.naturalSevenSeats?.length
      ? '<p class="natural-banner">🎉 NATURAL SEVEN! 🎉</p>'
      : '';
    if (state.hand.sixTwo) {
      natural += `<p class="natural-banner">🎉 ${escapeHtml(state.hand.sixTwo.nickname)} wins with the 6-2! 🎉</p>`;
    }
    const wl = winnersLine(state);
    if (wl) {
      html = `${natural}<p class="win-line">${wl}</p>`;
    } else if (state.hand.carryOut > 0) {
      html = `<p class="win-line">Nobody beat the dealer — ${state.hand.carryOut} rides to the next hand</p>`;
    } else {
      html = '';
    }
  } else if (state.status === GAME_STATUS.RUNNING && !state.hand) {
    html = '<p>Waiting for players…</p>';
  }

  if (el.dataset.sig !== html) {
    el.dataset.sig = html;
    el.innerHTML = html;
    const startBtn = document.getElementById('start-game-btn');
    if (startBtn) startBtn.onclick = () => client.send(EVENTS.HOST_START_GAME, {});
  }
}

function winnersLine(state) {
  const winners = state.hand?.winners;
  if (!winners || !winners.length) return '';
  const bySeat = new Map();
  for (const w of winners) {
    bySeat.set(w.seat, (bySeat.get(w.seat) || 0) + w.amount);
  }
  return [...bySeat.entries()]
    .map(([seatIdx, amount]) => {
      const seat = state.seats[seatIdx];
      return seat ? `${escapeHtml(seat.nickname)} wins ${amount}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

// ---- countdown bars (the only thing animating between broadcasts) ----

const timerMemo = { deadline: null, startedAt: 0 };

export function startTimerLoop(client) {
  function tick() {
    const hand = client.state?.hand;
    const deadline = hand && !hand.finished ? hand.deadline : null;

    if (deadline !== timerMemo.deadline) {
      timerMemo.deadline = deadline;
      timerMemo.startedAt = Date.now();
    }

    // The 3-2-1 reveal countdown ticks here, between broadcasts.
    const cdNum = document.getElementById('cd747-num');
    if (cdNum && deadline && hand.timerName === 'countdown747') {
      const left = Math.max(0, deadline - Date.now());
      cdNum.textContent = String(Math.max(1, Math.ceil(left / 1000)));
    }

    for (const pod of document.querySelectorAll('.seat.occupied')) {
      const bar = pod.querySelector('.timer-bar');
      if (!bar || !hand) continue;
      const seatIndex = parseInt(pod.dataset.seat, 10);
      let show = false;
      const clockNames = hand.timerName === 'action' || hand.timerName === 'timebank' || hand.timerName === 'nudge';
      if (deadline && clockNames && hand.toActSeat === seatIndex) show = true;
      if (deadline && hand.timerName === 'discard') {
        const seat = client.state.seats[seatIndex];
        if (seat && seat.inHand && !seat.folded && seat.cardCount === 3) show = true;
      }
      // 747 decision clock: every live seat that hasn't locked in yet.
      if (deadline && hand.timerName === 'decision747') {
        const seat = client.state.seats[seatIndex];
        if (seat && seat.inHand && !seat.folded && seat.decided === false) show = true;
      }
      bar.classList.toggle('hidden', !show);
      if (show) {
        const total = Math.max(1, deadline - timerMemo.startedAt);
        const left = Math.max(0, deadline - Date.now());
        const frac = Math.min(1, left / total);
        const fill = bar.querySelector('.timer-fill');
        fill.style.width = (frac * 100).toFixed(1) + '%';
        fill.classList.toggle('timebank', hand.timerName === 'timebank');
        fill.classList.toggle('urgent', left < 6000 && hand.timerName !== 'timebank');
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
