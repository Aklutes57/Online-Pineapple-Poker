// Table-page entry: socket lifecycle, token storage, state store, dispatch.

import { EVENTS } from '/shared/constants.js';
import { showToast, escapeHtml } from '/js/ui.js';
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
  socket.emit(EVENTS.JOIN, { gameId, token, nickname }, (res) => {
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

function applyState(state) {
  if (!state || state.seq <= client.lastSeq) return;
  client.lastSeq = state.seq;
  const wasMyTurn = !!client.you?.availableActions;
  client.state = state;
  client.you = state.you;
  renderAll(client);
  notifyStateForPanels(client);
  if (!wasMyTurn && client.you?.availableActions) {
    playTurnSound();
  }
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

// ---- sound: tiny WebAudio blip on your turn, no asset files ----

let audioCtx = null;
function playTurnSound() {
  if (!client.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  } catch {
    /* sound is best-effort */
  }
}

document.getElementById('sound-toggle').addEventListener('click', (e) => {
  client.soundOn = !client.soundOn;
  localStorage.setItem('pp:sound', client.soundOn ? 'on' : 'off');
  e.currentTarget.textContent = client.soundOn ? '🔊' : '🔇';
});
document.getElementById('sound-toggle').textContent = client.soundOn ? '🔊' : '🔇';

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
startTimerLoop(client);
join();
