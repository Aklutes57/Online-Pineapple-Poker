// Table-page entry: socket lifecycle, token storage, state store, dispatch.

import { EVENTS } from '/shared/constants.js';
import { showToast, escapeHtml } from '/js/ui.js';
import { getAccountToken, loadAccount, currentAccount, authHeaders } from '/js/auth.js';
import { initReactions, showReaction } from '/js/reactions.js';
import { play as playSound, setCustomClips } from '/js/sounds.js';
import {
  pushSupported, savedPushEndpoint, currentPushSubscription, enablePush, disablePush,
} from '/js/pwa.js';
import { renderAll, startTimerLoop } from '/js/render.js';
import { initActionBar } from '/js/actionBar.js';
import { initPanels, onChatMessage, notifyStateForPanels } from '/js/panels.js';

const gameId = location.pathname.split('/').pop();
const storageKey = `pp:${gameId}`;

export const client = {
  gameId,
  state: null,
  you: null,
  lastSeq: 0,
  send,
  myTurnAt: 0,
  soundOn: localStorage.getItem('pp:sound') !== 'off',
};

const socket = io();

function saved() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || {};
  } catch {
    return {};
  }
}

function join() {
  const { token, nickname } = saved();
  const accountToken = getAccountToken();
  const pushEndpoint = savedPushEndpoint();
  socket.emit(EVENTS.JOIN, { gameId, token, nickname, accountToken, pushEndpoint }, (res) => {
    if (!res?.ok) {
      location.href = '/?error=notfound';
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify({ ...saved(), token: res.token }));
    applyState(res.state);
  });
}

socket.on('connect', join);

socket.on(EVENTS.STATE, applyState);

socket.on(EVENTS.CHAT_MSG, (msg) => onChatMessage(msg));

socket.on(EVENTS.REACTION, (msg) => showReaction(msg));

socket.on(EVENTS.ERROR_MSG, ({ message }) => showToast(message || 'Something went wrong'));

socket.on(EVENTS.TABLE_CLOSED, ({ reason }) => {
  const overlay = document.getElementById('closed-overlay');
  document.getElementById('closed-reason').textContent =
    reason === 'host' ? 'The host closed this table. Final results:' : 'This table was closed.';
  renderClosedLedger();
  overlay.classList.remove('hidden');
});

socket.on('disconnect', () => {
  setConnBanner(true);
});

socket.io.on('reconnect', () => {
  setConnBanner(false);
});

let lastCoolerHandId = null;
let lastResultHandId = null;
let priorIsHost = null;

function applyState(state) {
  if (!state || state.seq <= client.lastSeq) return;
  client.lastSeq = state.seq;
  // 747's stay/fold decision counts as "your turn" for the chime.
  const wasMyTurn = !!client.you?.availableActions || !!client.you?.canDecide747;
  const previousStack = client.you?.stack;
  client.state = state;
  client.you = state.you;
  renderAll(client);
  notifyStateForPanels(client);

  // Tell you when host changes hands, so a silent hand-off (or reclaim) is
  // never a surprise. Skipped on the very first state so joining isn't noisy.
  const nowHost = !!state.you?.isHost;
  if (priorIsHost !== null && priorIsHost !== nowHost) {
    showToast(nowHost
      ? "You're the host now — you can accept players and open the ⚙️ Host menu."
      : `You're no longer the host — ${state.hostName || 'someone else'} is hosting now.`);
  }
  priorIsHost = nowHost;

  if (!wasMyTurn && (client.you?.availableActions || client.you?.canDecide747)) {
    playSound('yourTurn', { enabled: client.soundOn });
  }

  const hand = state.hand;
  if (hand?.finished && hand.handId !== lastResultHandId) {
    lastResultHandId = hand.handId;
    const mySeat = client.you?.seatIndex;
    const iWon = mySeat !== null && (hand.winners || []).some((w) => w.seat === mySeat);
    if (iWon) playSound('win', { enabled: client.soundOn });
    else if (previousStack > 0 && client.you?.stack === 0) {
      playSound('bust', { enabled: client.soundOn });
    }
  }

  // The cooler callout fires once per hand, and its sound outranks the
  // ordinary win chime.
  if (hand?.cooler && hand.handId !== lastCoolerHandId) {
    lastCoolerHandId = hand.handId;
    showCoolerBanner(hand.cooler);
    playSound(hand.cooler.trigger, { enabled: client.soundOn });
  }
}

let coolerTimeout = null;
function showCoolerBanner(cooler) {
  const banner = document.getElementById('cooler-banner');
  banner.innerHTML = `<strong>${escapeHtml(cooler.headline)}</strong> ${escapeHtml(cooler.detail)}`;
  banner.className = `cooler-banner cooler-${cooler.trigger}`;
  clearTimeout(coolerTimeout);
  coolerTimeout = setTimeout(() => banner.classList.add('hidden'), 6000);
}

function send(event, payload = {}) {
  socket.emit(event, payload);
}

function setConnBanner(disconnected) {
  document.body.classList.toggle('disconnected', disconnected);
}

function renderClosedLedger() {
  const rows = client.state?.ledger || [];
  const host = document.getElementById('closed-ledger');
  if (!rows.length) {
    host.textContent = '';
    return;
  }
  host.innerHTML = `
    <table class="ledger">
      <thead><tr><th>Player</th><th>Buy-ins</th><th>Final</th><th>Net</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr><td>${escapeHtml(r.nickname)}</td><td>${r.buyIns}</td><td>${r.cashOuts + r.stack}</td>
          <td class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : ''}${r.net}</td></tr>`
        )
        .join('')}</tbody>
    </table>`;
}

// ---- four-color deck (per-player display preference) ----

function applyDeckPref() {
  const on = localStorage.getItem('pp:fourColor') === 'on';
  document.body.classList.toggle('four-color', on);
  const btn = document.getElementById('deck-toggle');
  btn.title = on ? 'Four-color deck is on' : 'Four-color deck: diamonds blue, clubs green';
  btn.style.opacity = on ? '1' : '0.6';
}

document.getElementById('deck-toggle').addEventListener('click', () => {
  const on = localStorage.getItem('pp:fourColor') === 'on';
  try {
    localStorage.setItem('pp:fourColor', on ? 'off' : 'on');
  } catch { /* private browsing */ }
  applyDeckPref();
  showToast(on ? 'Standard deck colors' : 'Four-color deck on');
});

applyDeckPref();

document.getElementById('sound-toggle').addEventListener('click', (e) => {
  client.soundOn = !client.soundOn;
  localStorage.setItem('pp:sound', client.soundOn ? 'on' : 'off');
  e.currentTarget.textContent = client.soundOn ? '🔊' : '🔇';
});
document.getElementById('sound-toggle').textContent = client.soundOn ? '🔊' : '🔇';

// ---- turn alerts bell ----

const bell = document.getElementById('push-bell');

async function syncBell() {
  if (!pushSupported()) {
    bell.classList.add('hidden');
    return;
  }
  const subscription = await currentPushSubscription();
  bell.textContent = subscription ? '🔔' : '🔕';
  bell.title = subscription
    ? 'Turn alerts are on for this device'
    : "Get a notification when it's your turn and you're away";
}

bell.addEventListener('click', async () => {
  const subscription = await currentPushSubscription();
  if (subscription) {
    await disablePush();
    showToast('Turn alerts off on this device');
  } else {
    const result = await enablePush();
    showToast(result.ok ? "You'll get a ping when it's your turn" : result.error);
  }
  await syncBell();
  join(); // re-JOIN carries the new pushEndpoint (or its removal) to the table
});

syncBell();

document.getElementById('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Invite link copied — send it to your friends');
  } catch {
    prompt('Copy this link:', location.href);
  }
});

// ---- boot ----

initActionBar(client);
initPanels(client);
initReactions(client);
startTimerLoop(client);
loadAccount().then(async (account) => {
  client.account = account;
  if (!account) return;
  const chip = document.getElementById('account-chip');
  if (chip) {
    chip.textContent = account.displayName;
    chip.classList.remove('hidden');
  }
  // Your own uploaded clips replace the built-in patches for you.
  try {
    const res = await fetch('/api/me/theme', { headers: authHeaders() });
    if (res.ok) setCustomClips((await res.json()).sounds || {});
  } catch {
    /* built-in sounds are the fallback */
  }
});
join();
