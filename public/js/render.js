// Renders the whole table from a single state object. Every function here is
// an idempotent function of `client.state` / `client.you`; regions only
// rebuild their DOM when their content signature changes, so CSS deal
// animations fire once per new card.

import { SEAT_COUNT, SEAT_COORDS, BET_COORDS, VARIANTS, GAME_STATUS, PHASES, EVENTS } from '/shared/constants.js';
import { makeCardEl, makeCardBack } from '/js/cards.js';
import { escapeHtml } from '/js/ui.js';
import { renderActionBar, openJoinModal } from '/js/actionBar.js';

const seatsLayer = () => document.getElementById('seats-layer');
const betsLayer = () => document.getElementById('bets-layer');

export function renderAll(client) {
  const { state, you } = client;
  if (!state) return;
  renderTheme(client);
  renderHeader(client);
  renderSeats(client);
  renderBets(client);
  renderBoard(client);
  renderCenter(client);
  renderActionBar(client);
  document.getElementById('host-menu-btn').classList.toggle('hidden', !you?.isHost);
  document.getElementById('leave-btn').classList.toggle('hidden', !you || you.spectator);
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
  const v = VARIANTS[state.settings.variant];
  const badge = document.getElementById('game-badge');
  const handNo = state.hand ? ` · Hand #${state.hand.handNo}` : '';
  badge.textContent = `${v ? v.label : state.settings.variant} · Blinds ${state.settings.smallBlind}/${state.settings.bigBlind}${handNo}`;
}

// ---- seats ----

function displaySlot(seatIndex, client) {
  const mySeat = client.you?.seatIndex ?? 0;
  return (seatIndex - mySeat + SEAT_COUNT) % SEAT_COUNT;
}

function renderSeats(client) {
  const { state, you } = client;
  const layer = seatsLayer();

  for (let i = 0; i < SEAT_COUNT; i++) {
    let pod = layer.querySelector(`[data-seat="${i}"]`);
    if (!pod) {
      pod = document.createElement('div');
      pod.className = 'seat';
      pod.dataset.seat = i;
      layer.appendChild(pod);
    }
    const slot = displaySlot(i, client);
    const coord = SEAT_COORDS[slot];
    pod.style.left = coord.left + '%';
    pod.style.top = coord.top + '%';

    const seat = state.seats[i];
    if (!seat) {
      renderEmptySeat(pod, i, client);
    } else {
      renderPlayerSeat(pod, seat, i, client);
    }
  }
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

  const sig = JSON.stringify([
    seat.playerId, seat.nickname, seat.stack, seat.connected, seat.sittingOut,
    seat.inHand, seat.folded, seat.allIn, seat.cardCount, shownCards,
    seat.isDealer, toAct, waitingDiscard, seat.handResult,
    isMe, you?.canDiscard, you?.hasDiscarded,
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

  // Cards fan.
  const fan = document.createElement('div');
  fan.className = 'cards-fan' + (isMe ? ' mine' : '');
  if (seat.inHand && !seat.folded) {
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
  const sig = JSON.stringify([parts, client.you?.seatIndex]);
  if (layer.dataset.sig === sig) return;
  layer.dataset.sig = sig;
  layer.innerHTML = '';
  for (const [seatIndex, amount] of parts) {
    const slot = displaySlot(seatIndex, client);
    const coord = BET_COORDS[slot];
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

  if (hand && (hand.collectedPot > 0 || hand.potTotal > 0)) {
    potLine.classList.remove('hidden');
    if (hand.finished && hand.pots) {
      const total = hand.pots.reduce((a, p) => a + p.amount, 0);
      potLine.textContent = hand.pots.length > 1
        ? `Pot: ${total} (${hand.pots.map((p) => p.amount).join(' + ')})`
        : `Pot: ${total}`;
    } else {
      potLine.textContent = `Pot: ${hand.collectedPot}`;
    }
  } else {
    potLine.classList.add('hidden');
  }
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
  } else if (state.status === GAME_STATUS.RUNNING && (!state.hand || (state.hand.finished && !winnersLine(state)))) {
    html = state.hand ? '' : '<p>Waiting for players…</p>';
  } else if (state.hand?.finished) {
    html = `<p class="win-line">${winnersLine(state)}</p>`;
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

    for (const pod of document.querySelectorAll('.seat.occupied')) {
      const bar = pod.querySelector('.timer-bar');
      if (!bar) continue;
      const seatIndex = parseInt(pod.dataset.seat, 10);
      let show = false;
      const clockNames = hand.timerName === 'action' || hand.timerName === 'timebank' || hand.timerName === 'nudge';
      if (deadline && clockNames && hand.toActSeat === seatIndex) show = true;
      if (deadline && hand.timerName === 'discard') {
        const seat = client.state.seats[seatIndex];
        if (seat && seat.inHand && !seat.folded && seat.cardCount === 3) show = true;
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
