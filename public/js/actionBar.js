// Bottom action bar: seat lifecycle + betting controls. Renders purely from
// `you.availableActions` — the server computes all legality and bounds.

import { EVENTS, GAME_STATUS, PHASES } from '/shared/constants.js';
import { showToast } from '/js/ui.js';

const bar = () => document.getElementById('action-bar');

let clientRef = null;
let trayOpen = false;
let trayAmount = 0;
let lastTurnKey = '';

export function initActionBar(client) {
  clientRef = client;

  // Join modal wiring.
  document.getElementById('j-cancel').addEventListener('click', closeJoinModal);
  document.getElementById('join-modal').addEventListener('click', (e) => {
    if (e.target.id === 'join-modal') closeJoinModal();
  });
  document.getElementById('j-request').addEventListener('click', submitJoin);
  document.getElementById('j-nickname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('j-buyin').focus();
  });
  document.getElementById('j-buyin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });

  document.getElementById('leave-btn').addEventListener('click', () => {
    if (confirm('Stand up and cash out your stack to the ledger?')) {
      client.send(EVENTS.STAND_UP, {});
    }
  });
}

let joinSeatIndex = null;

export function openJoinModal(client, seatIndex = null) {
  joinSeatIndex = seatIndex;
  const s = client.state.settings;
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(`pp:${client.gameId}`)) || {};
    } catch {
      return {};
    }
  })();
  document.getElementById('j-nickname').value =
    saved.nickname || client.you?.nickname?.replace(/^Guest-\d+$/, '') || '';
  document.getElementById('j-buyin').value = s.defaultBuyIn;
  document.getElementById('j-buyin').min = s.minBuyIn;
  document.getElementById('j-buyin').max = s.maxBuyIn;
  document.getElementById('j-buyin-range').textContent = `(${s.minBuyIn}–${s.maxBuyIn})`;
  document.getElementById('join-modal').classList.remove('hidden');
  document.getElementById('j-nickname').focus();
}

function closeJoinModal() {
  document.getElementById('join-modal').classList.add('hidden');
}

function submitJoin() {
  const nickname = document.getElementById('j-nickname').value.trim();
  const buyIn = parseInt(document.getElementById('j-buyin').value, 10);
  if (!nickname) {
    showToast('Pick a nickname');
    return;
  }
  if (!Number.isInteger(buyIn)) {
    showToast('Enter a buy-in amount');
    return;
  }
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(`pp:${clientRef.gameId}`)) || {};
    } catch {
      return {};
    }
  })();
  localStorage.setItem(`pp:${clientRef.gameId}`, JSON.stringify({ ...saved, nickname }));
  clientRef.send(EVENTS.REQUEST_SEAT, { nickname, buyIn, seatIndex: joinSeatIndex });
  closeJoinModal();
}

// ---- render ----

export function renderActionBar(client) {
  const { state, you } = client;
  const el = bar();
  if (!state || !you) {
    el.innerHTML = '';
    return;
  }
  const hand = state.hand;
  const av = you.availableActions;

  // Reset the tray whenever a new decision starts.
  const turnKey = av ? `${hand.handId}:${hand.phase}:${hand.toActSeat}:${hand.currentBet}` : '';
  void turnKey;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    trayOpen = false;
    trayAmount = av ? defaultRaiseAmount(av) : 0;
  }

  let html = '';

  if (you.spectator) {
    if (you.status === 'requesting') {
      html = `
        <span class="ab-note">Seat requested (buy-in ${you.pendingBuyIn}) — waiting for the host…</span>
        <button class="btn btn-ghost" data-act="cancel-request">Cancel</button>`;
    } else {
      html = `
        <span class="ab-note">You're watching this table.</span>
        <button class="btn btn-primary" data-act="open-join">Take a seat</button>`;
    }
  } else if (av) {
    const callLabel =
      av.callAmount > 0
        ? av.callAmount >= you.stack
          ? `All-in ${av.callAmount}`
          : `Call ${av.callAmount}`
        : 'Check';
    html = `
      <div class="ab-actions">
        <button class="btn btn-red ab-btn" data-act="fold">Fold</button>
        <button class="btn ab-btn ab-check" data-act="${av.callAmount > 0 ? 'call' : 'check'}">${callLabel}</button>
        ${av.canRaise
          ? `<button class="btn btn-green ab-btn" data-act="open-tray">${state.hand.currentBet > 0 ? 'Raise' : 'Bet'}</button>`
          : ''}
      </div>
      ${trayOpen && av.canRaise ? trayHtml(av, client) : ''}`;
  } else if (you.canDecide747) {
    // 747: one secret, simultaneous choice. Big buttons, no tray.
    html = `
      <div class="ab-actions">
        <button class="btn btn-red ab-btn" data-act="fold-747">Fold</button>
        <button class="btn btn-green ab-btn" data-act="stay-747">Stay</button>
      </div>
      <span class="ab-note">Beat the dealer's hand to win the pot — choices reveal together.</span>`;
  } else if (you.decided747 && hand && hand.phase === PHASES.DECISION_747) {
    html = `<span class="ab-note">Locked in — waiting for the others…</span>`;
  } else if (hand && hand.phase === PHASES.COUNTDOWN_747 && !hand.finished) {
    html = `<span class="ab-note ab-highlight">Revealing…</span>`;
  } else if (you.canDiscard) {
    html = `<span class="ab-note ab-highlight">🍍 Tap one of your cards to throw it away</span>`;
  } else if (you.hasDiscarded && hand && (hand.phase === PHASES.DISCARD_PREFLOP || hand.phase === PHASES.DISCARD_POSTFLOP)) {
    html = `<span class="ab-note">Discarded — waiting for the others…</span>`;
  } else if (you.canShow) {
    const iFolded = state.seats[you.seatIndex]?.folded;
    html = `
      <span class="ab-note">${iFolded ? 'Hand over — show what you folded?' : 'You took it down without a showdown.'}</span>
      <button class="btn btn-ghost" data-act="show-cards">Show your cards</button>
      ${you.canRabbitHunt ? '<button class="btn btn-ghost ab-small" data-act="rabbit">🐇 Rabbit hunt</button>' : ''}
      <button class="btn btn-ghost ab-small" data-act="sit-out">Sit out</button>`;
  } else if (you.sittingOut) {
    html = `
      <span class="ab-note">You're sitting out.</span>
      <button class="btn btn-green" data-act="sit-in">I'm back</button>`;
  } else if (you.canPreAct) {
    // Pre-action buttons deliberately use data-pre, never data-act: sharing
    // the action selectors would make them indistinguishable from a real
    // check or call, both to scripts and to a mis-click.
    const facingBet = hand.currentBet > (state.seats[you.seatIndex]?.betThisRound ?? 0);
    const opts = facingBet
      ? [['fold', 'Fold'], ['callAny', 'Call any']]
      : [['checkFold', 'Check/Fold'], ['check', 'Check']];
    html = `
      <span class="ab-note">${waitingText(client)}</span>
      <div class="pre-actions">
        ${opts
          .map(
            ([kind, label]) =>
              `<button class="btn pre-btn ${you.preAction === kind ? 'armed' : ''}" data-pre="${kind}">${label}</button>`
          )
          .join('')}
      </div>
      <button class="btn btn-ghost ab-small" data-act="sit-out">Sit out</button>`;
  } else if (state.status === GAME_STATUS.RUNNING || state.status === GAME_STATUS.PAUSED) {
    html = `
      <span class="ab-note">${waitingText(client)}</span>
      ${you.canRabbitHunt ? '<button class="btn btn-ghost ab-small" data-act="rabbit">🐇 Rabbit hunt</button>' : ''}
      <button class="btn btn-ghost ab-small" data-act="sit-out">Sit out</button>`;
  } else {
    html = `<span class="ab-note">Seated with ${you.stack} — waiting for the game to start.</span>`;
  }

  if (el.dataset.sig === html) {
    syncTrayInputs();
    return;
  }
  el.dataset.sig = html;
  el.innerHTML = html;
  bindBarEvents(client, av);
}

function waitingText(client) {
  const hand = client.state.hand;
  if (!hand || hand.finished) return 'Next hand starting soon…';
  const toActSeat = hand.toActSeat;
  const seat = toActSeat !== null ? client.state.seats[toActSeat] : null;
  return seat ? `Waiting for ${seat.nickname}…` : 'Waiting…';
}

function defaultRaiseAmount(av) {
  return Math.min(Math.max(av.minRaiseTo, 0), av.maxRaiseTo);
}

function trayHtml(av, client) {
  const pot = client.state.hand.potTotal;
  const presets = buildPresets(av, pot);
  return `
    <div class="bet-tray">
      <div class="tray-presets">
        ${presets
          .map((p) => `<button class="preset" data-preset="${p.amount}">${p.label}</button>`)
          .join('')}
      </div>
      <div class="tray-controls">
        <button class="step" data-step="-1">−</button>
        <input type="range" id="tray-slider" min="${av.minRaiseTo}" max="${av.maxRaiseTo}" value="${trayAmount}">
        <button class="step" data-step="1">+</button>
        <input type="number" id="tray-amount" min="${av.minRaiseTo}" max="${av.maxRaiseTo}" value="${trayAmount}">
        <button class="btn btn-green" data-act="confirm-raise">
          ${client.state.hand.currentBet > 0 ? 'Raise to' : 'Bet'} <span id="tray-confirm-amt">${trayAmount}</span>
        </button>
      </div>
    </div>`;
}

function buildPresets(av, pot) {
  const { minRaiseTo, maxRaiseTo, callAmount } = av;
  const currentBet = clientRef.state.hand.currentBet;
  const potRaise = currentBet + pot + callAmount; // raise "to" a pot-size bet
  const clamp = (v) => Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(v)));
  const list = [
    { label: 'Min', amount: minRaiseTo },
    { label: '⅓ pot', amount: clamp(currentBet + (pot + callAmount) / 3) },
    { label: '½ pot', amount: clamp(currentBet + (pot + callAmount) / 2) },
    { label: '¾ pot', amount: clamp(currentBet + (pot + callAmount) * 0.75) },
    { label: 'Pot', amount: clamp(potRaise) },
    { label: 'Max', amount: maxRaiseTo },
  ];
  // Drop duplicates (tiny pots collapse the fractions together).
  const seen = new Set();
  return list.filter((p) => {
    if (seen.has(p.amount)) return false;
    seen.add(p.amount);
    return true;
  });
}

function bindBarEvents(client, av) {
  const el = bar();
  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleAct(client, btn.dataset.act, av));
  });
  el.querySelectorAll('[data-pre]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.pre;
      // Clicking the armed one disarms it.
      const next = client.you?.preAction === kind ? null : kind;
      client.send(EVENTS.SET_PREACTION, { handId: client.state.hand.handId, kind: next });
    });
  });
  el.querySelectorAll('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      trayAmount = parseInt(btn.dataset.preset, 10);
      syncTrayInputs();
    });
  });
  el.querySelectorAll('.step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bb = client.state.settings.bigBlind;
      trayAmount = clampAmount(trayAmount + parseInt(btn.dataset.step, 10) * bb, av);
      syncTrayInputs();
    });
  });
  const slider = document.getElementById('tray-slider');
  const number = document.getElementById('tray-amount');
  if (slider) {
    slider.addEventListener('input', () => {
      trayAmount = parseInt(slider.value, 10);
      syncTrayInputs();
    });
  }
  if (number) {
    number.addEventListener('input', () => {
      const v = parseInt(number.value, 10);
      if (Number.isInteger(v)) {
        trayAmount = clampAmount(v, av);
        syncTrayInputs(true);
      }
    });
  }
}

function clampAmount(v, av) {
  return Math.max(av.minRaiseTo, Math.min(av.maxRaiseTo, v));
}

function syncTrayInputs(skipNumber = false) {
  const slider = document.getElementById('tray-slider');
  const number = document.getElementById('tray-amount');
  const confirmAmt = document.getElementById('tray-confirm-amt');
  if (slider) slider.value = trayAmount;
  if (number && !skipNumber) number.value = trayAmount;
  if (confirmAmt) confirmAmt.textContent = trayAmount;
}

function handleAct(client, act, av) {
  const hand = client.state.hand;
  switch (act) {
    case 'open-join':
      openJoinModal(client, null);
      break;
    case 'cancel-request':
      client.send(EVENTS.CANCEL_SEAT_REQUEST, {});
      break;
    case 'fold':
      client.send(EVENTS.ACTION, { handId: hand.handId, action: 'fold' });
      break;
    case 'check':
      client.send(EVENTS.ACTION, { handId: hand.handId, action: 'check' });
      break;
    case 'call':
      client.send(EVENTS.ACTION, { handId: hand.handId, action: 'call' });
      break;
    case 'open-tray':
      trayOpen = !trayOpen;
      bar().dataset.sig = '';
      renderActionBar(client);
      break;
    case 'confirm-raise': {
      const amount = clampAmount(trayAmount, av);
      const action = hand.currentBet > 0 ? 'raise' : 'bet';
      client.send(EVENTS.ACTION, { handId: hand.handId, action, amount });
      trayOpen = false;
      break;
    }
    case 'stay-747':
      client.send(EVENTS.DECISION_747, { handId: hand.handId, stay: true });
      break;
    case 'fold-747':
      client.send(EVENTS.DECISION_747, { handId: hand.handId, stay: false });
      break;
    case 'show-cards':
      client.send(EVENTS.SHOW_CARDS, { handId: hand.handId });
      break;
    case 'sit-out':
      client.send(EVENTS.SIT_OUT, {});
      break;
    case 'sit-in':
      client.send(EVENTS.SIT_IN, {});
      break;
    case 'rabbit':
      client.send(EVENTS.RABBIT_HUNT, { handId: hand.handId });
      break;
  }
}
