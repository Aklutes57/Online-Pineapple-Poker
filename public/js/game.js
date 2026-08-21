// Table-page entry: socket lifecycle, token storage, state store, dispatch.

import { EVENTS, NAME_FONTS, DEFAULT_NAME_FONT, SKINS, DEFAULT_SKIN } from '/shared/constants.js';
import { showToast, escapeHtml } from '/js/ui.js';
import { getAccountToken, loadAccount, currentAccount, authHeaders } from '/js/auth.js';
import { initReactions, showReaction } from '/js/reactions.js';
import { play as playSound, setCustomClips } from '/js/sounds.js';
import {
  pushSupported, savedPushEndpoint, currentPushSubscription, enablePush, disablePush,
} from '/js/pwa.js';
import { renderAll, startTimerLoop, fitTableStage, clearChipsOfPods } from '/js/render.js';
import { initActionBar } from '/js/actionBar.js';
import { initPanels, onChatMessage, notifyStateForPanels, openPanel, openLedger, openFair } from '/js/panels.js';
import {
  initWebrtc, joinAV, leaveAV, toggleCamera, toggleMic, toggleDeafen,
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
    // ts: the home page's "Recent tables" list sorts by when you last sat here.
    localStorage.setItem(storageKey, JSON.stringify({ ...saved(), token: res.token, ts: Date.now() }));
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
  // …and only NOW can the chips be placed honestly. renderBets ran inside
  // renderAll, before the tiles were back in their pods, so it was measuring
  // against a pod that was missing the tallest thing in it — which is exactly
  // how a bet ended up drawn over somebody's face.
  clearChipsOfPods();
  renderAvControls();
  // A signed-in player's ledger name comes back from their account; show it in
  // the field, but never overwrite what someone is in the middle of typing.
  const nameField = document.getElementById('real-name');
  if (nameField && document.activeElement !== nameField && state.you?.realName) {
    if (nameField.value.trim() !== state.you.realName) nameField.value = state.you.realName;
  }
  reassertRealName(state);

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
  const voiceBtn = document.getElementById('av-voice');
  const live = document.getElementById('av-live');
  if (!joinBtn || !live) return;

  // Leaving your seat drops you out of the A/V session automatically.
  if (st.joined && !seated) { leaveAV(); return; }

  joinBtn.classList.toggle('hidden', !st.supported || !seated || st.joined);
  voiceBtn?.classList.toggle('hidden', !st.supported || !seated || st.joined);
  live.classList.toggle('hidden', !st.joined);

  // Deafen belongs to LISTENING, not to broadcasting: you hear the table
  // whether or not your own camera is on, and the choice is remembered per
  // device. So it shows whenever there is anyone to hear (or while you are
  // still deafened, which is the state you need it to get out of).
  const deafen = document.getElementById('av-deafen');
  if (deafen) {
    const anyoneBroadcasting = !!client.state?.seats?.some((s) => s && s.mediaOn);
    deafen.classList.toggle('hidden', !st.supported || (!anyoneBroadcasting && !st.deafened));
    deafen.textContent = st.deafened ? 'Undeafen' : 'Deafen';
    deafen.classList.toggle('av-off', st.deafened);
    deafen.title = st.deafened
      ? 'Hear everyone again'
      : 'Deafen — you hear nobody; your own mic is unchanged';
  }

  if (st.joined) {
    const cam = document.getElementById('av-cam');
    const mic = document.getElementById('av-mic');
    // A voice-only session has no camera to toggle and no tile to frame.
    cam.classList.toggle('hidden', !st.hasVideo);
    document.getElementById('av-frame')?.classList.toggle('hidden', !st.hasVideo);
    cam.textContent = st.camOn ? 'Camera on' : 'Camera off';
    cam.classList.toggle('av-off', !st.camOn);
    cam.title = st.camOn ? 'Turn camera off' : 'Turn camera on';
    mic.textContent = st.micOn ? 'Mute mic' : 'Unmute mic';
    mic.classList.toggle('av-off', !st.micOn);
    mic.title = st.micOn
      ? "Mute your mic — they see you, they can't hear you"
      : 'Unmute your mic';
    const leave = document.getElementById('av-leave');
    if (leave) leave.textContent = st.hasVideo ? 'End video' : 'End voice';
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

// ---- the caret menu ----
// The bar keeps three things: the shuffle chip, Chat (whose badges must stay
// visible), and this caret. Everything else lives in the sheet below it.
const menuToggle = document.getElementById('menu-toggle');
const topMenu = document.getElementById('top-menu');

function setMenu(open) {
  if (!menuToggle || !topMenu) return;
  menuToggle.setAttribute('aria-expanded', String(open));
  topMenu.classList.toggle('hidden', !open);
  if (open) {
    // Fixed-positioned so nothing clips it; anchored to the bar's real bottom.
    topMenu.style.top = `${document.getElementById('top-bar').getBoundingClientRect().bottom}px`;
  }
}

function menuOpen() {
  return menuToggle?.getAttribute('aria-expanded') === 'true';
}

menuToggle?.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(!menuOpen());
});

// A one-shot action closes the sheet behind it; pickers and file inputs stay
// open, because choosing from them is not "done with the menu".
topMenu?.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  setMenu(false);
});

document.addEventListener('click', (e) => {
  if (!menuOpen()) return;
  if (topMenu.contains(e.target) || menuToggle.contains(e.target)) return;
  setMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuOpen()) setMenu(false);
});

// The bar's Ledger button opens the ledger pop-up; the menu's panel doors
// open the side panel already turned to the right tab.
document.getElementById('ledger-btn')?.addEventListener('click', openLedger);
document.getElementById('open-log')?.addEventListener('click', () => openPanel('log'));
document.getElementById('open-fair')?.addEventListener('click', openFair);

// Sit out / I'm back from the Seat sub-menu. The label tracks you.sittingOut
// (renderAll repaints it on every state), so one button serves both ways.
document.getElementById('menu-sit')?.addEventListener('click', () => {
  client.send(client.you?.sittingOut ? EVENTS.SIT_IN : EVENTS.SIT_OUT, {});
});

// Straddling is your own call, and an opt-in one: the table option only makes
// it available. Straddle puts you in for the FIRST straddle, two big blinds
// under the gun; Re-straddle puts you in for posting double behind somebody
// else's. Separate switches, because agreeing to two big blinds is not
// agreeing to sixteen.
for (const [id, deep] of [
  ['menu-straddle', false], ['straddle-btn', false],
  ['menu-restraddle', true], ['restraddle-btn', true],
]) {
  document.getElementById(id)?.addEventListener('click', () => {
    const now = deep ? client.you?.straddleDeepOptIn : client.you?.straddleOptIn;
    client.send(EVENTS.SET_STRADDLE, { on: now !== true, deep });
  });
}

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
  // localStorage is the source of truth; skin.js only got there first so the
  // first paint is right. Reading it here too means the picker is correct even
  // if that script never ran.
  let stored = null;
  try {
    stored = localStorage.getItem('pp:skin');
  } catch { /* private browsing */ }
  const saved = applySkin(stored || document.documentElement.dataset.skin || DEFAULT_SKIN);
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
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute('content',
          getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
      }
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

// ---- the name the ledger settles up under ----
// Separate from the username on your seat: the felt can say whatever you like,
// while the ledger and Settle up say who actually gets paid.
const REAL_NAME_KEY = 'pp:realName';
// Set up below when the field exists; called once per connection from
// applyState, when the server's answer is actually in hand.
let reassertRealName = () => {};
let reassertedRealName = false;
socket.on('connect', () => { reassertedRealName = false; });
const realNameInput = document.getElementById('real-name');
if (realNameInput) {
  try {
    realNameInput.value = localStorage.getItem(REAL_NAME_KEY) || '';
  } catch { /* private browsing */ }
  const pushRealName = () => {
    const name = realNameInput.value.replace(/\s+/g, ' ').trim();
    try {
      if (name) localStorage.setItem(REAL_NAME_KEY, name);
      else localStorage.removeItem(REAL_NAME_KEY);
    } catch { /* still applies for this session */ }
    client.send(EVENTS.SET_REAL_NAME, { name: name || null });
  };
  // On blur rather than on every keystroke — one broadcast per edit, not one
  // per letter typed.
  realNameInput.addEventListener('change', pushRealName);
  realNameInput.addEventListener('blur', pushRealName);
  // Guests have no account to hold it, so this browser re-asserts what it
  // remembers. A signed-in player's account is the source of truth and is
  // applied server-side on JOIN, so we must never push over it: the key is a
  // single global one, and a shared laptop would otherwise publish whoever
  // used it last under the name of whoever is playing now — and, worse, write
  // that into their account permanently.
  //
  // Driven off the state rather than a fixed delay, so it cannot race the JOIN
  // ack on a slow connection: re-assert only once the server has told us it
  // has nothing of its own.
  reassertRealName = (state) => {
    if (reassertedRealName) return;
    if (!state?.you) return;
    reassertedRealName = true;
    // getAccountToken(), not currentAccount(): the account object arrives from
    // an async fetch that the first state can easily beat, and a signed-in
    // player must be recognised as one from the very first tick or the stale
    // value goes out anyway. The token is read straight from localStorage.
    if (getAccountToken()) return;         // signed in: the account owns this
    if (state.you.realName) return;        // the server has one; leave it alone
    const name = realNameInput.value.trim();
    if (name) pushRealName();
  };
}

initWebrtc(client, socket);
setOnChange(() => {
  renderAvControls();
  // A camera coming on or going off changes the shape of a pod without any
  // state arriving, so the chips have to be re-placed against it.
  clearChipsOfPods();
});
document.getElementById('av-join')?.addEventListener('click', async () => {
  const r = await joinAV();
  if (!r.ok && r.error) showToast(r.error);
  renderAvControls();
});
// Voice without the camera: your mic joins the same session, your profile
// picture keeps your seat. Mute mic / End voice take it from there.
document.getElementById('av-voice')?.addEventListener('click', async () => {
  const r = await joinAV({ voiceOnly: true });
  if (!r.ok && r.error) showToast(r.error);
  renderAvControls();
});
document.getElementById('av-cam')?.addEventListener('click', toggleCamera);
document.getElementById('av-mic')?.addEventListener('click', toggleMic);
document.getElementById('av-deafen')?.addEventListener('click', toggleDeafen);
document.getElementById('av-leave')?.addEventListener('click', leaveAV);
window.addEventListener('pagehide', leaveAV);
loadAccount().then(async (account) => {
  client.account = account;
  if (!account) {
    // No account: offer the door right on the table (guests stay welcome).
    document.getElementById('signin-chip')?.classList.remove('hidden');
    return;
  }
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
