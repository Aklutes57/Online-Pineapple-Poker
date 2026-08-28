// Bottom action bar: seat lifecycle + betting controls. Renders purely from
// `you.availableActions` — the server computes all legality and bounds.

import { EVENTS, GAME_STATUS, PHASES } from '/shared/constants.js';
import { drawPickList, resetDrawPicks } from '/js/render.js';
import { showToast, escapeHtml } from '/js/ui.js';

const bar = () => document.getElementById('action-bar');

let clientRef = null;
let trayOpen = false;
let trayAmount = 0;
let lastTurnKey = '';
// True once you have tapped Fold on a hand you could check for free, and the
// bar is waiting for you to confirm.
let foldArmed = false;
// Set when the tray is summoned, so the render that follows knows to put the
// caret in the amount box. Cleared as soon as it has been honoured.
let trayJustOpened = false;
// The shove waiting on a second look: { action, amount } or null. Your whole
// stack is the one bet you cannot take back, so it is always asked about —
// whether it came from the All in button, the bet tray, or a call that happens
// to cost everything you have.
let pendingAllIn = null;

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

  installShortcuts(client);
}

// ---- keyboard ----

// One letter per action, the way every desk-bound player already thinks:
//   f fold · c call · k check · b bet · r raise
// Nothing fires unless the server says the action is legal for you right now,
// so a stray keystroke can never invent a move — and an open fold still has to
// be confirmed, by pressing f again.
const SHORTCUTS = {
  f: 'fold',
  c: 'call',
  k: 'check',
  b: 'raise',
  r: 'raise',
};

function typingSomewhere() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function installShortcuts(client) {
  document.addEventListener('keydown', (e) => {
    // Never steal a key from the chat box, the bet amount, or a modal's form.
    if (typingSomewhere()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const want = SHORTCUTS[e.key.toLowerCase()];
    if (!want) return;
    const av = client.you?.availableActions;
    if (!av) return; // not your turn — the bar is showing something else
    // A shove waiting on its confirm owns the bar: none of these letters is on
    // screen, so none of them may fire. The confirm is a deliberate click.
    if (pendingAllIn) return;

    if (want === 'fold') {
      // Same two-step as the button: an open fold arms, a second f confirms.
      handleAct(client, av.canCheck ? (foldArmed ? 'fold-confirm' : 'arm-fold') : 'fold', av);
    } else if (want === 'call' && av.callAmount > 0) {
      // c on a call that costs everything asks first, exactly as the button does.
      handleAct(client, av.callAmount >= client.you.stack ? 'arm-all-in-call' : 'call', av);
    } else if (want === 'check' && av.canCheck) {
      handleAct(client, 'check', av);
    } else if (want === 'raise' && av.canRaise) {
      if (!trayOpen) handleAct(client, 'open-tray', av);
      return; // leave the tray open and focused; Enter commits
    } else {
      return; // that action is not available — do nothing at all
    }
    e.preventDefault();
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
    // The tray never opens itself: Bet/Raise summons it, Close puts it away.
    trayOpen = false;
    foldArmed = false;
    pendingAllIn = null;
    trayAmount = av ? defaultRaiseAmount(av) : 0;
  }

  let html = '';

  if (you.spectator) {
    if (you.status === 'requesting') {
      html = `
        <span class="ab-note">Seat requested (buy-in ${you.pendingBuyIn}) — waiting for the host…</span>
        <button class="btn btn-ghost" data-act="cancel-request">Cancel</button>`;
    } else if (you.status === 'waitlisted') {
      html = `
        <span class="ab-note">Table's full — you're in the queue for the next free seat.</span>
        <button class="btn btn-ghost" data-act="leave-waitlist">Leave the queue</button>`;
    } else {
      // Someone the host has already let in sits straight back down; only a
      // first-timer waits, so don't promise a queue that isn't there.
      html = `
        <span class="ab-note">${you.seatOnRequest
          ? "You're watching this table — sit back down whenever you like."
          : "You're watching this table."}</span>
        <button class="btn btn-primary" data-act="open-join">${
          you.seatOnRequest ? 'Buy back in' : 'Take a seat'}</button>`;
    }
  } else if (av && pendingAllIn) {
    html = `
      <span class="ab-note ab-highlight ab-allin-ask">Are you sure you want to go all in?</span>
      <span class="ab-note">That's your whole stack — ${pendingAllIn.cost} chips.</span>
      <div class="ab-actions">
        <button class="btn ab-btn ab-allin ab-confirm" data-act="all-in-confirm">All in</button>
        <button class="btn ab-btn btn-ghost" data-act="cancel-all-in">Cancel</button>
      </div>`;
  } else if (av) {
    // Your whole stack expressed as a "raise to" total for this street, which
    // is the unit the server validates in.
    const allInTo = you.stack + (state.seats[you.seatIndex]?.betThisRound ?? 0);
    const callIsAllIn = av.callAmount > 0 && av.callAmount >= you.stack;
    // Shoving is always legal in no-limit even when the stack is smaller than
    // the pot or than a full raise — the server already allows a short all-in
    // raise. A pot-limit table is the one exception: its cap can sit below the
    // stack, so only claim "all in" when the max really is the whole stack.
    const canShove = av.canRaise && av.maxRaiseTo >= allInTo;
    const callLabel =
      av.callAmount > 0
        ? callIsAllIn
          ? `All in ${av.callAmount}`
          : `Call ${av.callAmount}`
        : 'Check';
    // Folding when checking is free gives up a hand for nothing — always a
    // misclick, never a play. It takes a second tap, and only in that case:
    // folding to a bet is a real decision and stays one tap.
    const openFold = av.canCheck;
    const foldAct = openFold ? (foldArmed ? 'fold-confirm' : 'arm-fold') : 'fold';
    const foldLabel = openFold && foldArmed ? 'Really fold?' : 'Fold';
    html = `
      <div class="ab-actions">
        <button class="btn btn-red ab-btn${openFold && foldArmed ? ' ab-confirm' : ''}"
                data-act="${foldAct}"
                title="${openFold ? 'Nobody has bet — you can check for free' : 'Give up the hand'}"
                >${foldLabel}</button>
        <button class="btn ab-btn ab-check${callIsAllIn ? ' ab-allin' : ''}"
                data-act="${av.callAmount > 0 ? (callIsAllIn ? 'arm-all-in-call' : 'call') : 'check'}"
                >${callLabel}</button>
        ${av.canRaise
          ? `<button class="btn btn-green ab-btn" data-act="open-tray">${state.hand.currentBet > 0 ? 'Raise' : 'Bet'}</button>`
          : ''}
        ${canShove && !callIsAllIn
          ? `<button class="btn ab-btn ab-allin" data-act="arm-all-in" data-amount="${allInTo}"
                     title="Shove your whole stack — ${allInTo}"
                     >All in <span class="ab-amt">${allInTo}</span></button>`
          : ''}
      </div>
      ${trayOpen && av.canRaise ? trayHtml(av, client) : ''}`;
  } else if (you.canVoteRunItTwice) {
    // Everyone in the hand has to agree, so this is a plain yes/no — and
    // saying nothing counts as "once".
    html = `
      <div class="ab-actions">
        <button class="btn btn-green ab-btn" data-act="rit-yes">Run it twice</button>
        <button class="btn ab-btn" data-act="rit-no">Just once</button>
      </div>
      <span class="ab-note">All-in — deal two boards? Everyone has to agree.</span>`;
  } else if (hand && hand.phase === PHASES.RIT_VOTE) {
    html = '<span class="ab-note">Waiting on the others to answer…</span>';
  } else if (you.canRebuy) {
    const { minBuyIn, maxBuyIn, defaultBuyIn } = state.settings;
    const suggested = Math.min(Math.max(defaultBuyIn, minBuyIn), maxBuyIn);
    html = `
      <span class="ab-note ab-highlight">You're out of chips.</span>
      <div class="ab-actions">
        <button class="btn btn-green ab-btn" data-act="rebuy" data-amount="${suggested}">Re-buy ${suggested}</button>
        <button class="btn ab-btn" data-act="rebuy-other">Other amount</button>
        <button class="btn btn-red ab-btn" data-act="stand-up">Leave seat</button>
      </div>
      ${you.canShow
        // Busting out doesn't cost you the right to show the hand you just
        // played — this branch used to swallow the Show button entirely.
        ? '<button class="btn btn-ghost ab-small" data-act="show-cards">Show your cards</button>'
        : ''}`;
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
  } else if (hand && !hand.finished
             && (hand.phase === PHASES.COUNTDOWN_747 || hand.phase === PHASES.REVEAL_747)) {
    // The showdown is dealt out, so say which beat the table is watching.
    const beat = {
      reveal747: 'Cards up…',
      reveal747card: 'Dealing the fifth card…',
      reveal747dealer: "The dealer's card…",
    }[hand.timerName];
    html = `<span class="ab-note ab-highlight">${beat || 'Revealing…'}</span>`;
  } else if (you.canDraw) {
    const picks = drawPickList().length;
    html = `
      <span class="ab-note ab-highlight">${picks === 0
        ? 'Tap the cards you want to throw — or stand pat.'
        : `Throwing ${picks} — tap a card again to keep it.`}</span>
      <div class="ab-actions">
        <button class="btn btn-green ab-btn" data-act="draw-confirm">${
          picks === 0 ? 'Stand pat' : `Draw ${picks}`}</button>
      </div>`;
  } else if (you.hasDrawn && hand && hand.phase === PHASES.DRAW) {
    html = '<span class="ab-note">Drawn — waiting for the others…</span>';
  } else if (you.canDiscard) {
    html = `<span class="ab-note ab-highlight">Tap one of your cards to throw it away</span>`;
  } else if (you.hasDiscarded && hand && (hand.phase === PHASES.DISCARD_PREFLOP || hand.phase === PHASES.DISCARD_POSTFLOP)) {
    html = `<span class="ab-note">Discarded — waiting for the others…</span>`;
  } else if (you.canShow) {
    const iFolded = state.seats[you.seatIndex]?.folded;
    html = `
      <span class="ab-note">${iFolded ? 'Hand over — show what you folded?' : 'You took it down without a showdown.'}</span>
      <button class="btn btn-ghost" data-act="show-cards">Show your cards</button>
      ${you.canRabbitHunt ? '<button class="btn btn-ghost ab-small" data-act="rabbit">Rabbit hunt</button>' : ''}`;
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
      </div>`;
  } else if (state.status === GAME_STATUS.RUNNING || state.status === GAME_STATUS.PAUSED) {
    html = `
      <span class="ab-note">${waitingText(client)}</span>
      ${you.canRabbitHunt ? '<button class="btn btn-ghost ab-small" data-act="rabbit">Rabbit hunt</button>' : ''}`;
  } else {
    html = `<span class="ab-note">Seated with ${you.stack} — waiting for the game to start.</span>`;
  }

  // Dead money rides along with whatever the bar is already saying. It is not
  // a bet, so it is deliberately not part of the raise tray — and canPost is
  // only ever true off-turn, because on your turn Bet is the right control.
  if (you.canPost) {
    html += '<button class="btn btn-ghost ab-small" data-act="post-pot"'
      + ' title="Put chips in the pot. It is not a bet: nobody has to call it,'
      + ' and it does not change whose turn it is.">Post to pot</button>';
  }

  if (el.dataset.sig === html) {
    syncTrayInputs();
    return;
  }
  el.dataset.sig = html;
  // The bar itself is a fixed-height strip the page grid reserves; everything
  // it says lives in .ab-inner, which hangs off the strip's bottom edge and
  // grows upward over the felt when it needs to. That is what keeps the table
  // exactly the same size whether you are folding, sizing a raise, or being
  // asked whether you really meant to shove.
  el.innerHTML = `<div class="ab-inner">${html}</div>`;
  bindBarEvents(client, av);
}

function waitingText(client) {
  const hand = client.state.hand;
  if (!hand || hand.finished) return 'Next hand starting soon…';
  const toActSeat = hand.toActSeat;
  const seat = toActSeat !== null ? client.state.seats[toActSeat] : null;
  // Escaped: this string is written via innerHTML, and a nickname is
  // attacker-chosen text. Every other nickname sink escapes; this one must too.
  return seat ? `Waiting for ${escapeHtml(seat.nickname)}…` : 'Waiting…';
}

function defaultRaiseAmount(av) {
  return Math.min(Math.max(av.minRaiseTo, 0), av.maxRaiseTo);
}

function trayHtml(av, client) {
  const pot = client.state.hand.potTotal;
  const presets = buildPresets(av, pot);
  const verb = client.state.hand.currentBet > 0 ? 'Raise to' : 'Bet';
  // A stack too short for a full raise has exactly one legal size — all of it.
  // A slider whose ends are the same number is just a confusing way to say so.
  if (av.minRaiseTo >= av.maxRaiseTo) {
    return `
      <div class="bet-tray">
        <div class="tray-row">
          <span class="ab-note">Your stack is the only size left.</span>
          <button class="btn btn-green" data-act="confirm-raise">
            ${verb} <span id="tray-confirm-amt">${av.maxRaiseTo}</span>
          </button>
          <button class="tray-close" data-act="open-tray">Close</button>
        </div>
      </div>`;
  }
  // One row, left to right: the sizes you might pick, then the slider and the
  // exact number, then the button that does it. The tray runs ALONG the bar
  // rather than stacking above it, so it covers as little felt as it can.
  return `
    <div class="bet-tray">
      <div class="tray-row">
        <div class="tray-presets">
          ${presets
            .map((p) => `<button class="preset${p.top ? ' preset-allin' : ''}" data-preset="${p.amount}">${p.label}</button>`)
            .join('')}
          <button class="tray-close" data-act="open-tray">Close</button>
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
      </div>
    </div>`;
}

function buildPresets(av, pot) {
  const { minRaiseTo, maxRaiseTo, callAmount } = av;
  const { state, you } = clientRef;
  const currentBet = state.hand.currentBet;
  const allInTo = you.stack + (state.seats[you.seatIndex]?.betThisRound ?? 0);
  const potRaise = currentBet + pot + callAmount; // raise "to" a pot-size bet
  const clamp = (v) => Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(v)));
  const list = [
    { label: '¼ pot', amount: clamp(currentBet + (pot + callAmount) / 4) },
    { label: '½ pot', amount: clamp(currentBet + (pot + callAmount) / 2) },
    { label: '¾ pot', amount: clamp(currentBet + (pot + callAmount) * 0.75) },
    { label: 'Pot', amount: clamp(potRaise) },
    // The top of the range is the whole stack unless a pot-limit cap bites first.
    { label: maxRaiseTo >= allInTo ? 'All in' : 'Max', amount: maxRaiseTo, top: true },
  ];
  // Drop duplicates (a short stack collapses every fraction onto the shove).
  // The top entry always wins its amount: keeping the FIRST of each amount used
  // to label a shove "¼ pot" and drop the All in button altogether, which is
  // the one button a short stack is looking for.
  const byAmount = new Map();
  for (const p of list) {
    if (!byAmount.has(p.amount) || p.top) byAmount.set(p.amount, p);
  }
  return [...byAmount.values()].sort((a, b) => a.amount - b.amount);
}

function bindBarEvents(client, av) {
  const el = bar();
  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleAct(client, btn.dataset.act, av, btn.dataset.amount));
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
    // Enter is the bet. Opening the tray and reaching for the mouse to press a
    // button you are already looking at is the slow way round.
    number.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      handleAct(clientRef, 'confirm-raise', av);
    });
  }
  // Opening the tray puts the caret in the amount, with the suggested size
  // selected so the first digit you type replaces it rather than appending.
  if (trayJustOpened) {
    trayJustOpened = false;
    const target = number || el.querySelector('[data-act="confirm-raise"]');
    target?.focus();
    if (number) number.select?.();
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

// Your whole stack expressed as a "raise to" total for this street — the unit
// the server validates in, and the number a shove has to reach to count as one.
function wholeStackTo(client) {
  const { state, you } = client;
  return you.stack + (state.seats[you.seatIndex]?.betThisRound ?? 0);
}

// Holds a shove one beat, so the bar can ask before the chips go in. Stores the
// exact move that was legal at the moment of the tap; the confirm just replays
// it. Any turn change wipes it (see the turn-key reset in renderActionBar), so
// a stale confirm can never fire into a different decision.
function armAllIn(client, move) {
  pendingAllIn = { ...move, cost: client.you.stack };
  bar().dataset.sig = '';
  renderActionBar(client);
}

function handleAct(client, act, av, arg = null) {
  const hand = client.state.hand;
  switch (act) {
    case 'open-join':
      openJoinModal(client, null);
      break;
    case 'cancel-request':
      client.send(EVENTS.CANCEL_SEAT_REQUEST, {});
      break;
    case 'leave-waitlist':
      client.send(EVENTS.LEAVE_WAITLIST, {});
      break;
    case 'fold':
      foldArmed = false;
      client.send(EVENTS.ACTION, { handId: hand.handId, action: 'fold' });
      break;
    // First tap on a free check: arm the confirm rather than fold.
    case 'arm-fold':
      foldArmed = true;
      bar().dataset.sig = '';
      renderActionBar(client);
      break;
    case 'fold-confirm':
      foldArmed = false;
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
      trayJustOpened = trayOpen;
      bar().dataset.sig = '';
      renderActionBar(client);
      break;
    case 'confirm-raise': {
      const amount = clampAmount(trayAmount, av);
      const action = hand.currentBet > 0 ? 'raise' : 'bet';
      // Sizing the slider all the way to the top is still a shove, so it gets
      // the same second look the All in button does.
      if (amount >= wholeStackTo(client)) {
        trayOpen = false;
        armAllIn(client, { action, amount });
        break;
      }
      client.send(EVENTS.ACTION, { handId: hand.handId, action, amount });
      trayOpen = false;
      break;
    }
    // Every route to "all of it" arms the confirm instead of firing. The chips
    // are clamped against the server's own bounds here, at the moment the
    // button was pressed, so a stale bar can never send an amount that would
    // be refused — the confirm only replays what was already checked.
    case 'arm-all-in':
      armAllIn(client, {
        action: hand.currentBet > 0 ? 'raise' : 'bet',
        amount: clampAmount(parseInt(arg, 10), av),
      });
      break;
    // Calling a bet that costs everything you have is a shove too, however it
    // is labelled.
    case 'arm-all-in-call':
      armAllIn(client, { action: 'call' });
      break;
    case 'all-in-confirm': {
      const pending = pendingAllIn;
      pendingAllIn = null;
      if (!pending) break;
      const payload = { handId: hand.handId, action: pending.action };
      if (pending.amount !== undefined) payload.amount = pending.amount;
      client.send(EVENTS.ACTION, payload);
      trayOpen = false;
      break;
    }
    case 'cancel-all-in':
      pendingAllIn = null;
      bar().dataset.sig = '';
      renderActionBar(client);
      break;
    case 'stay-747':
      client.send(EVENTS.DECISION_747, { handId: hand.handId, stay: true });
      break;
    case 'fold-747':
      client.send(EVENTS.DECISION_747, { handId: hand.handId, stay: false });
      break;
    case 'show-cards':
      client.send(EVENTS.SHOW_CARDS, { handId: hand.handId });
      break;
    case 'sit-in':
      client.send(EVENTS.SIT_IN, {});
      break;
    case 'rabbit':
      client.send(EVENTS.RABBIT_HUNT, { handId: hand.handId });
      break;
    case 'rit-yes':
      client.send(EVENTS.RUN_IT_TWICE_VOTE, { handId: hand.handId, yes: true });
      break;
    case 'rit-no':
      client.send(EVENTS.RUN_IT_TWICE_VOTE, { handId: hand.handId, yes: false });
      break;
    case 'rebuy':
      client.send(EVENTS.REBUY, { amount: parseInt(arg, 10) });
      break;
    case 'rebuy-other': {
      const { minBuyIn } = client.state.settings;
      const raw = prompt(`Re-buy how many chips? (at least ${minBuyIn} — no cap)`);
      const amount = parseInt(raw, 10);
      if (Number.isInteger(amount)) client.send(EVENTS.REBUY, { amount });
      break;
    }
    case 'draw-confirm': {
      // An empty list is standing pat, and has to be sent like any other
      // answer — the table is waiting on it.
      client.send(EVENTS.DRAW_CARDS, { indices: drawPickList() });
      resetDrawPicks();
      break;
    }
    case 'post-pot': {
      const raw = prompt(
        'Post how many chips into the pot?\n\n'
        + 'It is dead money: nobody has to call it, it does not change whose '
        + 'turn it is, and you only get it back by winning the pot.'
      );
      const amount = parseInt(raw, 10);
      if (Number.isInteger(amount) && amount > 0) client.send(EVENTS.POST_TO_POT, { amount });
      break;
    }
    case 'stand-up':
      // Leaving the seat folds you out of a live hand — never on a stray tap.
      if (confirm('Leave your seat? If a hand is running, your hand is folded.')) {
        client.send(EVENTS.STAND_UP, {});
      }
      break;
  }
}
