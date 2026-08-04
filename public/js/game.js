// Table-page entry: socket lifecycle, token storage, state store, dispatch.

import { EVENTS, NAME_FONTS, DEFAULT_NAME_FONT, SKINS, DEFAULT_SKIN } from '/shared/constants.js';
import { showToast, escapeHtml } from '/js/ui.js';
import { getAccountToken, loadAccount, currentAccount, authHeaders } from '/js/auth.js';
import { initReactions, showReaction } from '/js/reactions.js';
import { play as playSound, setCustomClips } from '/js/sounds.js';
import {
  pushSupported, savedPushEndpoint, currentPushSubscription, enablePush, disablePush,
} from '/js/pwa.js';
import { renderAll, startTimerLoop, fitTableStage } from '/js/render.js';
import { initActionBar } from '/js/actionBar.js';
import { initPanels, onChatMessage, notifyStateForPanels } from '/js/panels.js';
import {
  initWebrtc, joinAV, leaveAV, toggleCamera, toggleMic,
  syncSeats as syncAvSeats, avState, setOnChange,
} from '/js/webrtc.js';

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

// The boot cover only ever comes down — a later state must not re-run the fade.
let bootCleared = false;
function clearBoot() {
  if (bootCleared) return;
  bootCleared = true;
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 500);
}
// If the socket never answers, don't sit behind the cover forever — the
// reconnect banner and the table underneath are more useful than a spinner.
setTimeout(clearBoot, 10000);

function applyState(state) {
  if (!state || state.seq <= client.lastSeq) return;
  client.lastSeq = state.seq;
  // 747's stay/fold decision counts as "your turn" for the chime.
  const wasMyTurn = !!client.you?.availableActions || !!client.you?.canDecide747;
  const previousStack = client.you?.stack;
  client.state = state;
  client.you = state.you;
  clearBoot();
  renderAll(client);
  notifyStateForPanels(client);
  syncAvSeats(state); // put each live webcam back into its (re-rendered) seat
  fitTableStage();    // webcam tiles make pods taller — refit around them
  renderAvControls();

  // Tell you when host changes hands, so a silent hand-off (or reclaim) is
  // never a surprise. Skipped on the very first state so joining isn't noisy.
  const nowHost = !!state.you?.isHost;
  if (priorIsHost !== null && priorIsHost !== nowHost) {
    showToast(nowHost
      ? "You're the host now — you can accept players and open the Host menu."
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
  e.currentTarget.textContent = client.soundOn ? 'Sound on' : 'Sound off';
});
document.getElementById('sound-toggle').textContent = client.soundOn ? 'Sound on' : 'Sound off';

// ---- turn alerts bell ----

const bell = document.getElementById('push-bell');

async function syncBell() {
  if (!pushSupported()) {
    bell.classList.add('hidden');
    return;
  }
  const subscription = await currentPushSubscription();
  bell.textContent = subscription ? 'Alerts on' : 'Alerts off';
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

// ---- voice + webcam controls ----

function renderAvControls() {
  const st = avState();
  const seated = !!client.you && !client.you.spectator;
  const joinBtn = document.getElementById('av-join');
  const live = document.getElementById('av-live');
  if (!joinBtn || !live) return;

  // Leaving your seat drops you out of the A/V session automatically.
  if (st.joined && !seated) { leaveAV(); return; }

  joinBtn.classList.toggle('hidden', !st.supported || !seated || st.joined);
  live.classList.toggle('hidden', !st.joined);
  if (st.joined) {
    const cam = document.getElementById('av-cam');
    const mic = document.getElementById('av-mic');
    cam.textContent = st.camOn ? 'Camera on' : 'Camera off';
    cam.classList.toggle('av-off', !st.camOn);
    cam.title = st.camOn ? 'Turn camera off' : 'Turn camera on';
    mic.textContent = st.micOn ? 'Mic on' : 'Mic off';
    mic.classList.toggle('av-off', !st.micOn);
    mic.title = st.micOn ? 'Mute mic' : 'Unmute mic';
  }
}

// ---- shared table picture + your own webcam frame ----
// Both are uploaded straight to the table using the per-game player token, so
// guests can do it too — no account needed to decorate the table you're at.
function uploadImage(file, path, okMessage, onDone) {
  if (!file) return;
  const token = saved().token;
  if (!token) {
    showToast('Join the table first');
    return;
  }
  file.arrayBuffer().then((buf) =>
    fetch(`/api/games/${gameId}/${path}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Player-Token': token },
      body: buf,
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(okMessage, { ok: true });
          onDone?.(body);
        } else {
          showToast(body.error || 'Upload failed');
        }
      })
      .catch(() => showToast('Upload failed'))
  );
}

// ---- your profile picture ----
// Signed in: the server also writes it to the account, so it follows you to
// every future table. A guest's browser remembers the upload URL and re-asserts
// it on each connect, so guests keep a face too.
const AVATAR_KEY = 'pp:avatar';

function pushAvatar() {
  let url = null;
  try {
    url = localStorage.getItem(AVATAR_KEY);
  } catch { /* private browsing */ }
  if (url) client.send(EVENTS.SET_AVATAR, { url });
}
socket.on('connect', () => setTimeout(pushAvatar, 250));

document.getElementById('avatar-btn')?.addEventListener('click', () =>
  document.getElementById('avatar-input').click()
);
document.getElementById('avatar-input')?.addEventListener('change', (e) => {
  uploadImage(e.target.files[0], 'avatar', 'Profile picture updated', ({ url }) => {
    try {
      if (url) localStorage.setItem(AVATAR_KEY, url);
    } catch { /* private browsing */ }
  });
  e.target.value = '';
});

document.getElementById('table-img-btn')?.addEventListener('click', () =>
  document.getElementById('table-img-input').click()
);
document.getElementById('table-img-input')?.addEventListener('change', (e) => {
  uploadImage(e.target.files[0], 'table-image', 'Table picture updated for everyone');
  e.target.value = '';
});
document.getElementById('av-frame')?.addEventListener('click', () =>
  document.getElementById('cam-frame-input').click()
);
document.getElementById('cam-frame-input')?.addEventListener('change', (e) => {
  uploadImage(e.target.files[0], 'cam-frame', 'Webcam frame updated');
  e.target.value = '';
});

// ---- how the table looks on YOUR screen ----
// Nobody else is affected: this is a device preference, applied before the
// first paint so the table never flashes the wrong room.
const skinSel = document.getElementById('skin');
function applySkin(key) {
  const skin = SKINS[key] ? key : DEFAULT_SKIN;
  // Set on <html>, matching what /js/skin.js does before first paint.
  document.documentElement.dataset.skin = skin;
  return skin;
}
{
  // skin.js already applied it in <head>; read it back rather than guessing.
  const saved = applySkin(document.documentElement.dataset.skin || DEFAULT_SKIN);
  if (skinSel) {
    skinSel.innerHTML = Object.entries(SKINS)
      .map(([key, s]) => `<option value="${key}">${s.label}</option>`)
      .join('');
    skinSel.value = SKINS[saved] ? saved : DEFAULT_SKIN;
    skinSel.addEventListener('change', () => {
      const applied = applySkin(skinSel.value);
      try {
        localStorage.setItem('pp:skin', applied);
      } catch { /* private browsing */ }
      showToast(`Table look: ${SKINS[applied].label}`, { ok: true });
    });
  }
}

// ---- the font your name is shown in ----
const fontSel = document.getElementById('name-font');
if (fontSel) {
  fontSel.innerHTML = Object.entries(NAME_FONTS)
    .map(([key, f]) => `<option value="${key}" style="font-family:${f.stack}">${f.label}</option>`)
    .join('');
  const savedFont = localStorage.getItem('pp:nameFont') || DEFAULT_NAME_FONT;
  fontSel.value = NAME_FONTS[savedFont] ? savedFont : DEFAULT_NAME_FONT;
  fontSel.style.fontFamily = NAME_FONTS[fontSel.value].stack;
  const pushFont = () => {
    localStorage.setItem('pp:nameFont', fontSel.value);
    fontSel.style.fontFamily = NAME_FONTS[fontSel.value].stack;
    client.send(EVENTS.SET_NAME_FONT, { font: fontSel.value });
  };
  fontSel.addEventListener('change', pushFont);
  // Re-assert it on every (re)connect so the table sees your choice.
  socket.on('connect', () => setTimeout(pushFont, 250));
}

initWebrtc(client, socket);
setOnChange(renderAvControls);
document.getElementById('av-join')?.addEventListener('click', async () => {
  const r = await joinAV();
  if (!r.ok && r.error) showToast(r.error);
  renderAvControls();
});
document.getElementById('av-cam')?.addEventListener('click', toggleCamera);
document.getElementById('av-mic')?.addEventListener('click', toggleMic);
document.getElementById('av-leave')?.addEventListener('click', leaveAV);
window.addEventListener('pagehide', leaveAV);
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
