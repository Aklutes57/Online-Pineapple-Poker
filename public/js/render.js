// Renders the whole table from a single state object. Every function here is
// an idempotent function of `client.state` / `client.you`; regions only
// rebuild their DOM when their content signature changes, so CSS deal
// animations fire once per new card.

import {
  SEAT_COUNT, SEAT_COORDS, BET_COORDS, SEAT_COORDS_PORTRAIT, BET_COORDS_PORTRAIT,
  VARIANTS, GAME_STATUS, PHASES, EVENTS, NAME_FONTS, DEFAULT_NAME_FONT,
} from '/shared/constants.js';
import { makeCardEl, makeCardBack } from '/js/cards.js';
import { escapeHtml } from '/js/ui.js';
import { renderActionBar, openJoinModal } from '/js/actionBar.js';
import { isMuted, toggleMutePlayer } from '/js/webrtc.js';

const seatsLayer = () => document.getElementById('seats-layer');
const betsLayer = () => document.getElementById('bets-layer');

// How long the CSS `deal` animation runs — a card scheduled longer ago than
// this is simply shown. Kept in step with .card.dealt in table.css.
const DEAL_MS = 280;
// False only until the first full paint: someone joining or reloading
// mid-hand sees the table as it stands, not a replay of the deal.
let firstPaintDone = false;

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
  // The whole Host section of the settings sheet exists only for the host.
  document.getElementById('menu-host-sec')?.classList.toggle('hidden', !you?.isHost);
  document.getElementById('leave-btn').classList.toggle('hidden', !you || you.spectator);
  // The Seat sub-menu exists only when you actually hold a seat. Sit out
  // lives here — off the action bar — so a stray tap can't kill your hand.
  const seated = !!you && !you.spectator;
  document.getElementById('menu-seat-group')?.classList.toggle('hidden', !seated);
  const sitBtn = document.getElementById('menu-sit');
  if (sitBtn) {
    // A busted player is auto-away and can only re-buy (the action bar offers
    // it) — an "I'm back" that always errors would just be a trap.
    sitBtn.classList.toggle('hidden', !seated || (you?.stack ?? 0) <= 0);
    sitBtn.textContent = you?.sittingOut ? "I'm back" : 'Sit out';
    sitBtn.title = you?.sittingOut
      ? 'Deal me in again from the next hand'
      : 'Go away for a bit — the table checks or folds for you until you’re back';
  }
  // Straddle choice: only meaningful when the table's straddle is on.
  const straddleBtn = document.getElementById('menu-straddle');
  if (straddleBtn) {
    straddleBtn.classList.toggle('hidden', !seated || !state.settings.straddle);
    straddleBtn.textContent = you?.straddleOptIn === false ? 'Straddle: out' : 'Straddle: in';
  }
  // The action bar's height can change with its contents, which can change the
  // space left for the table — refit, and re-place if that flipped the shape.
  relayout();
  firstPaintDone = true;
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
  landscape: { x: 44, y: 98 },
  upright: { x: 16, y: 88 },
};
const CAM_EXTRA_Y = 74;    // half a webcam tile, top and bottom
const AVATAR_EXTRA_Y = 44; // a profile picture is smaller than a live tile
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
  // Anything stacked above the cards makes every pod taller, so it has to buy
  // vertical room or the top and bottom seats get shaved off.
  const camY = document.querySelector('#seats-layer video.seat-cam')
    ? CAM_EXTRA_Y
    : document.querySelector('#seats-layer .seat-avatar:not(.hidden)')
      ? AVATAR_EXTRA_Y
      : 0;
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

  const clearFelt = () => {
    table.style.backgroundImage = '';
    table.style.backgroundSize = '';
    table.style.borderColor = '';
    for (const v of ['--felt', '--felt-hi', '--felt-dark']) table.style.removeProperty(v);
  };

  if (!theme) {
    clearFelt();
    return;
  }
  clearFelt();
  // The felt is painted by an opaque gradient built from --felt, so a host
  // colour has to move the gradient rather than sit behind it — setting
  // background-color alone would never show. cleanTheme has already proved
  // the value is a plain #rrggbb, so it is safe to build a colour from it.
  if (theme.feltColor) {
    table.style.setProperty('--felt', theme.feltColor);
    table.style.setProperty('--felt-hi', `color-mix(in srgb, ${theme.feltColor} 82%, #ffffff)`);
    table.style.setProperty('--felt-dark', `color-mix(in srgb, ${theme.feltColor} 62%, #000000)`);
  }
  // A picture on the felt is shared table decoration, so it wins over both.
  if (theme.feltImage) {
    table.style.backgroundImage = `url("${theme.feltImage}")`;
    table.style.backgroundSize = 'cover';
    table.style.backgroundPosition = 'center';
  }
  if (theme.railColor) table.style.borderColor = theme.railColor;
}

// The top bar is three tracks: identity, controls, counterweight. CSS can size
// the first from its content but cannot mirror that width onto the third, so it
// is measured here. Without it the controls centre on whatever the badges left
// over, which is not the middle of the screen.
export function syncTopBar() {
  const meta = document.querySelector('.top-meta');
  const spacer = document.querySelector('.top-spacer');
  if (!meta || !spacer) return;
  // Measured with the counterweight collapsed, so it never measures itself.
  spacer.style.width = '0px';
  const want = Math.round(meta.getBoundingClientRect().width);
  spacer.style.width = `${want}px`;
}

function renderHeader(client) {
  const { state } = client;
  // A live hand always shows the game it was dealt as, even if the host has
  // already switched the table's game for the next hand.
  const variantKey = state.hand?.variant || state.settings.variant;
  const v = VARIANTS[variantKey];
  const badge = document.getElementById('game-badge');
  const handNo = state.hand ? ` · Hand #${state.hand.handNo}` : '';
  // 747 is an ante game — there are no blinds to advertise. The penalty cap
  // matters as much as the ante (it's what a lost challenge costs), so both
  // live in the badge — but only in 747.
  const cap747 = state.settings.penaltyCap747;
  const stakes = v?.engine === '747'
    ? `Ante ${state.settings.ante747 > 0 ? state.settings.ante747 : state.settings.bigBlind}`
      + (cap747 > 0 ? ` · Penalty up to ${cap747}` : '')
    : `Blinds ${state.settings.smallBlind}/${state.settings.bigBlind}`;
  badge.textContent = `${v ? v.label : variantKey} · ${stakes}${handNo}`;
  renderTournamentClock(state);
  syncTopBar();
}

// The tournament clock: which level, how long until the blinds go up, and
// whether you can still buy in. Absent entirely on a cash game.
function renderTournamentClock(state) {
  const el = document.getElementById('tourney-clock');
  if (!el) return;
  const t = state.tournament;
  el.classList.toggle('hidden', !t);
  if (!t) {
    tourneyDeadline = null;
    return;
  }
  // Kept as a deadline rather than a countdown so the tick is local and the
  // number doesn't jump around between broadcasts.
  tourneyDeadline = t.started && t.msToNextLevel !== null ? Date.now() + t.msToNextLevel : null;
  el.dataset.level = String(t.level);
  el.dataset.rebuys = t.rebuysOpen ? 'open' : 'closed';
  paintTourneyClock();
}

let tourneyDeadline = null;

function paintTourneyClock() {
  const el = document.getElementById('tourney-clock');
  if (!el || el.classList.contains('hidden')) return;
  const level = el.dataset.level || '1';
  const rebuys = el.dataset.rebuys === 'open' ? '' : ' · registration closed';
  if (tourneyDeadline === null) {
    el.textContent = `Tournament · level ${level} — clock starts on the first hand`;
    return;
  }
  const left = Math.max(0, tourneyDeadline - Date.now());
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  el.textContent = `Level ${level} · ${mins}:${String(secs).padStart(2, '0')} to the next${rebuys}`;
}

// A player's chosen face for their own name, resolved through the shared list
// so nothing a client sends can reach the style attribute directly.
function nameFontStack(key) {
  return (NAME_FONTS[key] || NAME_FONTS[DEFAULT_NAME_FONT]).stack;
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
    seat.mediaOn, seat.camFrame, seat.avatarUrl, isMuted(seat.playerId), seat.nameFont,
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
  //
  // The pod rebuilds on every state change, so the deal choreography can't
  // live in the DOM: each card's when-it-becomes-visible moment is kept on
  // the pod as a wall-clock timestamp. A rebuild mid-deal re-applies the
  // remaining delay (negative delays resume an animation midway), so an
  // early action never snaps half-dealt cards in. New cards come out one at
  // a time, sweeping around the table from the dealer's left like a real
  // deal; a reveal (showdown or a folder showing) flips the whole hand in
  // one quick sweep instead of re-dealing it.
  const now = Date.now();
  const handKey = hand ? String(hand.handId) : '';
  const sameHand = pod.dataset.handKey === handKey;
  const facesRevealed = !!shownCards && !(sameHand && pod.dataset.faces === '1');
  pod.dataset.handKey = handKey;
  pod.dataset.faces = shownCards ? '1' : '0';
  const dealerSeat = state.seats.findIndex((s) => s?.isDealer);
  const dealOrder = dealerSeat >= 0 ? (seatIndex - dealerSeat - 1 + SEAT_COUNT) % SEAT_COUNT : 0;
  let showAt = [];
  if (sameHand) {
    try { showAt = JSON.parse(pod.dataset.showAt || '[]'); } catch { /* rebuilt */ }
  }
  const prevScheduled = showAt.length;
  const reveal = facesRevealed && (seat.folded || hand?.finished || prevScheduled > 0);
  // A card you may throw away must never be invisible while it is clickable.
  const instant = isMe && !!you?.canDiscard;
  const scheduleFor = (ci) => {
    // Joining or reloading mid-hand replays nothing: the action clock is
    // already running and the table state is old news to everyone else.
    if (!firstPaintDone || instant) return now - DEAL_MS;
    if (ci >= prevScheduled) return now + (reveal ? 0 : (ci - prevScheduled) * 420) + dealOrder * 40;
    if (reveal) return now + dealOrder * 40;
    return showAt[ci];
  };
  const cardOpts = (ci, extra = {}) => {
    const t = scheduleFor(ci);
    showAt[ci] = t;
    return { dealt: t + DEAL_MS > now, delay: t - now, ...extra };
  };

  const fan = document.createElement('div');
  fan.className = 'cards-fan' + (isMe ? ' mine' : '');
  if (seat.inHand && seat.folded && seat.cards) {
    for (let ci = 0; ci < seat.cards.length; ci++) {
      fan.appendChild(makeCardEl(seat.cards[ci], cardOpts(ci)));
    }
  } else if (seat.inHand && !seat.folded) {
    if (shownCards) {
      for (let ci = 0; ci < shownCards.length; ci++) {
        const card = makeCardEl(shownCards[ci], cardOpts(ci, { discardable: isMe && you.canDiscard }));
        if (isMe && you.canDiscard) {
          card.onclick = () => client.send(EVENTS.DISCARD, { handId: hand.handId, cardIndex: ci });
        }
        fan.appendChild(card);
      }
    } else {
      for (let ci = 0; ci < seat.cardCount; ci++) {
        fan.appendChild(makeCardBack(cardOpts(ci)));
      }
    }
  }
  pod.dataset.showAt = JSON.stringify(showAt.slice(0, fan.children.length));

  // Four- and five-card games (PLO, 747) deal fans wide enough to reach into
  // the next seat, so the fan carries its size for the CSS to shrink by.
  const dealt = fan.children.length;
  if (dealt >= 4) fan.classList.add(dealt >= 5 ? 'fan-5' : 'fan-4');

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
    statusBits.push(seat.decided ? 'locked in' : 'deciding…');
  }
  plate.innerHTML = `
    <div class="np-row">
      <span class="np-name" style="font-family: ${nameFontStack(seat.nameFont)}">${escapeHtml(seat.nickname)}</span>
      <span class="np-stack">${seat.stack}</span>
    </div>
    ${statusBits.length ? `<div class="np-status">${statusBits.join(' · ')}</div>` : ''}
    ${seat.mediaOn && !isMe
      ? `<button class="np-mute${isMuted(seat.playerId) ? ' on' : ''}" data-mute="${seat.playerId}"
           title="${isMuted(seat.playerId) ? 'Unmute' : 'Mute'} ${escapeHtml(seat.nickname)} (just for you)"
           >${isMuted(seat.playerId) ? 'Muted' : 'Mute'}</button>`
      : ''}
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
  // The profile picture sits exactly where the webcam tile goes, so a player
  // with the camera off still has a face at the table. webrtc.js hides it the
  // moment a live tile covers the same spot.
  if (seat.avatarUrl) {
    const avatar = document.createElement('img');
    avatar.className = 'seat-avatar';
    avatar.src = seat.avatarUrl;
    avatar.alt = '';
    pod.appendChild(avatar);
  }
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
  const muteBtn = plate.querySelector('[data-mute]');
  if (muteBtn) {
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMutePlayer(muteBtn.dataset.mute);
      renderAll(client);
    });
  }
  if (bubble) plate.insertAdjacentHTML('beforeend', bubble);
  if (isMe && you.hasDiscarded && discardPhase) {
    plate.insertAdjacentHTML('beforeend', '<div class="np-bubble">discarded</div>');
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
  clearChipsOfPods();
}

// Move each bet chip off everything in its seat pod. The anchors are tuned for
// a bare pod, but a pod grows: a last-action bubble appears, a webcam tile is
// twice the height of anything else, a profile picture sits above the cards.
// Rather than hand-tune twenty coordinates for every combination, a chip that
// is covered searches outward from its anchor for the nearest clear spot —
// correct at any pod height, and what the orientation gate asserts.
//
// Done arithmetically on one set of measurements rather than by nudging the
// element and re-reading it, so a crowded ten-handed table costs one layout
// read per chip instead of a hundred.
export function clearChipsOfPods() {
  const layer = betsLayer();
  const table = document.getElementById('table');
  if (!table || !layer.children.length) return;
  const box = layer.getBoundingClientRect();
  const felt = table.getBoundingClientRect();
  if (!box.width || !box.height) return;

  const obstacles = [
    ...document.querySelectorAll(
      '#seats-layer .nameplate, #seats-layer .card, #seats-layer .seat-avatar,'
      + ' #seats-layer .np-bubble, #seats-layer video.seat-cam'
    ),
  ].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  // The middle of the felt is not somewhere to hide either — the board and the
  // pot live there — and nothing may leave the felt.
  const centre = document.getElementById('table-center');
  if (centre) {
    const r = centre.getBoundingClientRect();
    if (r.width > 0) obstacles.push(r);
  }
  if (!obstacles.length) return;

  const clash = (x, y, w, h) => obstacles.some((o) =>
    x - w / 2 < o.right - 1 && x + w / 2 > o.left + 1
    && y - h / 2 < o.bottom - 1 && y + h / 2 > o.top + 1);

  const cx = felt.left + felt.width / 2;
  const cy = felt.top + felt.height / 2;
  const stepPx = Math.max(6, Math.min(felt.width, felt.height) * 0.02);

  for (const chip of layer.children) {
    const r = chip.getBoundingClientRect();
    if (!r.width) continue;
    const x0 = r.left + r.width / 2;
    const y0 = r.top + r.height / 2;
    if (!clash(x0, y0, r.width, r.height)) continue;

    // Search outward, trying the direction of the middle of the felt first so
    // a displaced chip still reads as belonging to the seat it came from.
    const toCentre = Math.atan2(cy - y0, cx - x0);
    let best = null;
    // 40 rings: a webcam-heavy arc (three tiles and full fans in a cluster)
    // needs the search to reach well past the pods into the open felt.
    for (let ring = 1; ring <= 40 && !best; ring++) {
      for (let i = 0; i < 12 && !best; i++) {
        // 0, +30, -30, +60, -60 … around the line to the centre.
        const turn = (Math.ceil(i / 2) * (Math.PI / 6)) * (i % 2 === 0 ? 1 : -1);
        const a = toCentre + turn;
        const x = x0 + Math.cos(a) * stepPx * ring;
        const y = y0 + Math.sin(a) * stepPx * ring;
        // Stay on the felt: a chip pushed off the table is no better than one
        // sitting on a name.
        if (x < felt.left + 8 || x > felt.right - 8 || y < felt.top + 8 || y > felt.bottom - 8) continue;
        if (!clash(x, y, r.width, r.height)) best = { x, y };
      }
    }
    if (!best) continue; // nowhere clear — leave it on its anchor
    chip.style.left = `${((best.x - box.left) / box.width) * 100}%`;
    chip.style.top = `${((best.y - box.top) / box.height) * 100}%`;
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
    // The board rebuilds whole, so the deal choreography lives in remembered
    // per-card timestamps (same scheme as the seats): only cards past what
    // was already scheduled animate, one at a time — a flop arrives 1-2-3,
    // not as a block — and a rebuild mid-stagger resumes rather than snaps.
    // A new handId resets everything, because a bomb pot's board can open
    // on a full flop.
    const now = Date.now();
    const handKey = hand ? String(hand.handId) : '';
    const sameHand = board.dataset.handKey === handKey;
    let showAt = [];
    let showAt2 = [];
    if (sameHand) {
      try {
        showAt = JSON.parse(board.dataset.showAt || '[]');
        showAt2 = JSON.parse(board.dataset.showAt2 || '[]');
      } catch { /* rebuilt */ }
    }
    const schedule = (arr, i) => {
      if (!firstPaintDone) return now - DEAL_MS;
      return i < arr.length ? arr[i] : now + (i - arr.length) * 300;
    };
    const opts = (arr, i) => {
      const t = schedule(arr, i);
      arr[i] = t;
      return { dealt: t + DEAL_MS > now, delay: t - now };
    };
    board.dataset.sig = sig;
    board.dataset.handKey = handKey;
    board.innerHTML = '';
    board.classList.toggle('two-boards', !!second);

    const firstRow = document.createElement('div');
    firstRow.className = 'board-row';
    for (let i = 0; i < cards.length; i++) {
      firstRow.appendChild(makeCardEl(cards[i], opts(showAt, i)));
    }
    // Rabbit hunt cards are the run-out that never happened — shown dimmed
    // so they can't be mistaken for the real board. They share the first
    // row's schedule so they trail in after the real cards.
    if (rabbit) {
      for (let i = 0; i < rabbit.length; i++) {
        const el = makeCardEl(rabbit[i], opts(showAt, cards.length + i));
        el.classList.add('rabbit');
        firstRow.appendChild(el);
      }
    }
    // The streets still to come: dashed outlines where cards will land, so
    // the board always shows its shape. Community games only — 747's dealer
    // area draws itself, and a second run-out board fills all five at once.
    const communityGame = hand
      ? !hand.dealer
      : VARIANTS[state.settings.variant]?.engine !== '747';
    if (!second && communityGame) {
      for (let i = cards.length + (rabbit ? rabbit.length : 0); i < 5; i++) {
        const slot = document.createElement('div');
        slot.className = 'board-slot';
        firstRow.appendChild(slot);
      }
    }
    board.appendChild(firstRow);

    if (second) {
      const secondRow = document.createElement('div');
      secondRow.className = 'board-row';
      for (let i = 0; i < second.length; i++) {
        secondRow.appendChild(makeCardEl(second[i], opts(showAt2, i)));
      }
      board.appendChild(secondRow);
    }
    board.dataset.showAt = JSON.stringify(showAt.slice(0, cards.length + (rabbit ? rabbit.length : 0)));
    board.dataset.showAt2 = JSON.stringify(showAt2.slice(0, second ? second.length : 0));
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
  // Same one-at-a-time deal as the seats (remembered timestamps, resumable
  // mid-animation); the reveal flips the whole hand with a small sweep.
  const now = Date.now();
  const handKey = String(hand.handId);
  const sameHand = board.dataset.handKey === handKey;
  const wasRevealed = sameHand && board.dataset.dealerFaces === '1';
  let showAt = [];
  if (sameHand) {
    try { showAt = JSON.parse(board.dataset.dealerShowAt || '[]'); } catch { /* rebuilt */ }
  }
  const opts = (i, revealSweep) => {
    let t;
    if (!firstPaintDone) t = now - DEAL_MS;
    else if (revealSweep && !wasRevealed) t = now + i * 100;
    else if (i < showAt.length) t = showAt[i];
    else t = now + (i - showAt.length) * 300;
    showAt[i] = t;
    return { dealt: t + DEAL_MS > now, delay: t - now };
  };
  board.dataset.sig = sig;
  board.dataset.handKey = handKey;
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
    for (let i = 0; i < d.cards.length; i++) {
      row.appendChild(makeCardEl(d.cards[i], opts(i, true)));
    }
  } else {
    for (let i = 0; i < d.cardCount; i++) {
      row.appendChild(makeCardBack(opts(i, false)));
    }
  }
  board.appendChild(row);
  board.dataset.dealerFaces = d.cards ? '1' : '0';
  board.dataset.dealerShowAt = JSON.stringify(showAt.slice(0, d.cards ? d.cards.length : d.cardCount));
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
          Start the game
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

    paintTourneyClock();
    syncTopBar();

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
