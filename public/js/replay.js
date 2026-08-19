// Hand replayer: rebuilds the table state at any point in the timeline by
// replaying events from the start, so stepping backwards is exact rather
// than an attempt to undo.

import '/js/pwa.js'; // registers the service worker on replay pages too
import { SEAT_COUNT, SEAT_COORDS, BET_COORDS, REACTIONS, VARIANTS } from '/shared/constants.js';
import { makeCardEl, makeCardBack } from '/js/cards.js';
import { showToast, escapeHtml } from '/js/ui.js';
import { authHeaders, loadAccount, currentAccount } from '/js/auth.js';
import * as fair from '/shared/fairness.js';

const handId = location.pathname.split('/').pop();

// Honor the player's four-color deck preference on replays too.
try {
  document.body.classList.toggle('four-color', localStorage.getItem('pp:fourColor') === 'on');
} catch { /* private browsing */ }
let hand = null;
let step = 0;
let playing = null;

async function load() {
  await loadAccount();
  let data;
  try {
    const res = await fetch(`/api/hands/${handId}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('missing');
    data = await res.json();
  } catch {
    document.getElementById('replay-missing').classList.remove('hidden');
    return;
  }
  hand = data.hand;
  document.getElementById('replay-body').classList.remove('hidden');
  document.getElementById('hand-title').textContent =
    `Hand #${hand.handNo} · ${VARIANTS[hand.variant]?.label || hand.variant} · pot ${hand.pot}`;

  const scrub = document.getElementById('rp-scrub');
  scrub.max = hand.timeline.length;
  scrub.addEventListener('input', () => goTo(Number(scrub.value)));

  renderReactionPicker();
  renderReactions(hand.reactions);
  renderFairness(hand.fairness);
  goTo(hand.timeline.length); // open on the finished hand
}

// ---- provably-fair panel + independent, in-browser verifier ----

const fmtFloat = (f) => (typeof f === 'number' ? f.toFixed(12) : '—');
const short = (h) => (typeof h === 'string' && h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h || '—');

function renderFairness(f) {
  const panel = document.getElementById('rp-fairness');
  if (!panel) return;
  if (!f) {
    panel.innerHTML = '';
    return;
  }
  const verifiable = !!(f.deckCommit && Array.isArray(f.slotCommits) && Array.isArray(f.openings));
  panel.innerHTML = `
    <h3>Verifying integrity</h3>
    <p class="fp-float" title="A [0,1) fingerprint hashed from this hand's seeds">${fmtFloat(f.float)}</p>
    <dl class="fp-list">
      <dt>Server commit</dt><dd class="mono" title="${escapeHtml(f.serverCommit || '')}">${escapeHtml(short(f.serverCommit))}</dd>
      <dt>Client seed</dt><dd class="mono">${escapeHtml(f.clientSeed || '—')}</dd>
      <dt>Hand nonce</dt><dd class="mono">${escapeHtml(String(f.nonce ?? '—'))}</dd>
      <dt>Deck commit</dt><dd class="mono" title="${escapeHtml(f.deckCommit || '')}">${escapeHtml(short(f.deckCommit))}</dd>
    </dl>
    ${verifiable
      ? `<button class="btn btn-primary fp-verify" id="fp-verify">Verify this deal in your browser</button>
         <div id="fp-result"></div>`
      : `<p class="fp-note">No verification data was recorded for this hand.</p>`}
    <p class="fp-note">The deck was committed before any card was dealt, so no card could change after the action. Folded hands stay sealed — only the board and cards shown down can be checked.</p>
  `;

  if (verifiable) {
    document.getElementById('fp-verify').addEventListener('click', () => verifyInBrowser(f));
  }
}

async function verifyInBrowser(f) {
  const out = document.getElementById('fp-result');
  out.innerHTML = '<p class="fp-note">Re-checking the commitment in your browser…</p>';

  // The cards actually visible in this replay: the board plus any hand shown
  // down. These are exactly what the openings should prove.
  const publicCards = [...(hand.board || []).filter(Boolean)];
  for (const p of hand.players) if (Array.isArray(p.cards)) for (const c of p.cards) publicCards.push(c);

  let res;
  try {
    res = await fair.verifyReveal({
      deckCommit: f.deckCommit,
      slotCommits: f.slotCommits,
      openings: f.openings,
      publicCards,
    });
  } catch {
    out.innerHTML = '<p class="fp-bad">✗ Verification could not run in this browser.</p>';
    return;
  }

  out.innerHTML = `
    <ul class="fp-checks">
      <li class="${res.deckCommitOk ? 'fp-ok' : 'fp-bad'}">${res.deckCommitOk ? '✓' : '✗'} The 52 slot commitments hash to the deck commitment published during the hand</li>
      <li class="${res.openingsOk ? 'fp-ok' : 'fp-bad'}">${res.openingsOk ? '✓' : '✗'} Every revealed card matches its committed slot</li>
      <li class="${res.allPublicProven ? 'fp-ok' : 'fp-bad'}">${res.allPublicProven ? '✓' : '✗'} Every card shown this hand is proven against the commitment</li>
    </ul>
    <p class="${res.ok ? 'fp-ok' : 'fp-bad'}"><strong>${res.ok ? 'Verified — the deck was locked in before the deal and every shown card checks out.' : 'Verification failed — this deal does not match its commitment.'}</strong></p>
    <p class="fp-note">${res.provenCards.length} card${res.provenCards.length === 1 ? '' : 's'} proven. Folded hands were never revealed and cannot be recovered.</p>
  `;
}

// Rebuilds the whole state from event 0 to `index`.
// What a forced bet is called in the log. Straddles are a chain — the second
// one is twice the first, the third twice that — so they are numbered.
const STRADDLE_NAMES = ['straddle', 'straddle', 'double straddle', 'triple straddle', 'quad straddle'];
function postName(event) {
  if (event.kind === 'ante') return 'ante';
  if (event.kind === 'sb') return 'small blind';
  if (event.kind === 'straddle') return STRADDLE_NAMES[event.level || 1] || `${event.level}x straddle`;
  return 'big blind';
}

function stateAt(index) {
  const seats = new Map();
  for (const p of hand.players) {
    seats.set(p.seat, {
      ...p,
      stack: p.startStack,
      bet: 0,
      folded: false,
      revealed: false,
      cardsShown: null,
      won: 0,
    });
  }
  let board = [];
  let pot = 0;
  const lines = [];

  for (const event of hand.timeline.slice(0, index)) {
    const seat = event.seat !== undefined ? seats.get(event.seat) : null;
    switch (event.type) {
      case 'post':
        if (seat) {
          seat.stack -= event.amount - seat.bet;
          seat.bet = event.amount;
        }
        pot += event.amount;
        lines.push(`${seat?.nickname ?? '?'} posts the ${postName(event)} (${event.amount})`);
        break;
      case 'board':
        board = event.board;
        for (const s of seats.values()) s.bet = 0;
        lines.push(`${cap(event.street)}: ${event.cards.join(' ')}`);
        break;
      case 'action': {
        if (seat) {
          if (event.action === 'fold') seat.folded = true;
          else {
            seat.stack -= event.amount - seat.bet;
            seat.bet = event.amount;
          }
        }
        if (typeof event.pot === 'number') pot = event.pot;
        lines.push(`${seat?.nickname ?? '?'} ${describeAction(event)}`);
        break;
      }
      case 'discard':
        lines.push(`${seat?.nickname ?? '?'} discards a card`);
        break;
      // 747: the simultaneous stay/fold reveal.
      case 'decision':
        if (seat && !event.stay) seat.folded = true;
        lines.push(`${seat?.nickname ?? '?'} ${event.stay ? 'stays' : 'folds'}`);
        break;
      case 'reveal':
        if (seat) {
          seat.revealed = true;
          seat.cardsShown = event.cards;
        }
        lines.push(`${seat?.nickname ?? '?'} shows ${event.cards.join(' ')} — ${event.desc}`);
        break;
      case 'payout':
        if (seat) {
          seat.won += event.amount;
          seat.stack += event.amount;
        }
        lines.push(`${seat?.nickname ?? '?'} wins ${event.amount}`);
        break;
    }
  }
  return { seats, board, pot, lines };
}

function describeAction(event) {
  const suffix = event.allIn ? ' (all-in)' : event.timedOut ? ' (time)' : '';
  switch (event.action) {
    case 'fold': return `folds${suffix}`;
    case 'check': return `checks${suffix}`;
    case 'call': return `calls ${event.amount}${suffix}`;
    case 'bet': return `bets ${event.amount}${suffix}`;
    default: return `raises to ${event.amount}${suffix}`;
  }
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function goTo(index) {
  step = Math.max(0, Math.min(hand.timeline.length, index));
  const view = stateAt(step);
  renderSeats(view);
  renderBoard(view);
  renderLog(view);
  document.getElementById('rp-scrub').value = step;
  document.getElementById('rp-position').textContent = `${step} / ${hand.timeline.length}`;
}

function renderSeats(view) {
  const layer = document.getElementById('seats-layer');
  const bets = document.getElementById('bets-layer');
  layer.innerHTML = '';
  bets.innerHTML = '';

  // Seat 0 of the replay sits at the bottom so the layout reads naturally.
  const seatNumbers = [...view.seats.keys()].sort((a, b) => a - b);
  const anchor = seatNumbers[0] ?? 0;

  for (const [seatIndex, seat] of view.seats) {
    const slot = (seatIndex - anchor + SEAT_COUNT) % SEAT_COUNT;
    const pod = document.createElement('div');
    pod.className = 'seat occupied' + (seat.folded ? ' folded' : '') + (seat.won > 0 ? ' winner' : '');
    pod.style.left = SEAT_COORDS[slot].left + '%';
    pod.style.top = SEAT_COORDS[slot].top + '%';

    const fan = document.createElement('div');
    fan.className = 'cards-fan';
    if (!seat.folded) {
      const cards = seat.cardsShown || (step >= hand.timeline.length ? seat.cards : null);
      if (cards) for (const c of cards) fan.appendChild(makeCardEl(c));
      else for (let i = 0; i < seat.cardCount; i++) fan.appendChild(makeCardBack());
    } else if (seat.cards && step >= hand.timeline.length) {
      // A folded player who chose to show at the table: the live view draws
      // the fan behind the folded styling, and so should the replay.
      for (const c of seat.cards) fan.appendChild(makeCardEl(c));
    }
    pod.appendChild(fan);

    const plate = document.createElement('div');
    plate.className = 'nameplate';
    plate.innerHTML = `
      <div class="np-row">
        <span class="np-name">${escapeHtml(seat.nickname)}</span>
        <span class="np-stack">${seat.stack}</span>
      </div>
      ${seat.won > 0 ? `<div class="np-bubble win">+${seat.won}</div>` : ''}`;
    pod.appendChild(plate);
    layer.appendChild(pod);

    if (seat.bet > 0) {
      const chip = document.createElement('div');
      chip.className = 'bet-chip';
      chip.style.left = BET_COORDS[slot].left + '%';
      chip.style.top = BET_COORDS[slot].top + '%';
      chip.textContent = seat.bet;
      bets.appendChild(chip);
    }
  }
}

function renderBoard(view) {
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (const c of view.board) board.appendChild(makeCardEl(c));
  document.getElementById('pot-line').textContent = `Pot: ${view.pot}`;

  const message = document.getElementById('center-message');
  if (step >= hand.timeline.length && hand.cooler) {
    message.innerHTML = `<p class="win-line">${escapeHtml(hand.cooler.headline)}</p>`;
  } else {
    message.innerHTML = '';
  }
}

function renderLog(view) {
  document.getElementById('rp-log').innerHTML = view.lines.length
    ? view.lines.map((l, i) =>
        `<div class="log-line ${i === view.lines.length - 1 ? 'current' : ''}">${escapeHtml(l)}</div>`
      ).join('')
    : '<p class="empty-note">Step forward to walk through the hand.</p>';
  const log = document.getElementById('rp-log');
  log.scrollTop = log.scrollHeight;
}

// ---- controls ----

document.getElementById('rp-first').addEventListener('click', () => { stop(); goTo(0); });
document.getElementById('rp-prev').addEventListener('click', () => { stop(); goTo(step - 1); });
document.getElementById('rp-next').addEventListener('click', () => { stop(); goTo(step + 1); });
document.getElementById('rp-last').addEventListener('click', () => { stop(); goTo(hand.timeline.length); });
document.getElementById('rp-play').addEventListener('click', togglePlay);

function togglePlay() {
  if (playing) {
    stop();
    return;
  }
  if (step >= hand.timeline.length) goTo(0);
  document.getElementById('rp-play').textContent = 'Pause';
  playing = setInterval(() => {
    if (step >= hand.timeline.length) {
      stop();
      return;
    }
    goTo(step + 1);
  }, 900);
}

function stop() {
  if (!playing) return;
  clearInterval(playing);
  playing = null;
  document.getElementById('rp-play').textContent = 'Play';
}

document.addEventListener('keydown', (e) => {
  if (!hand) return;
  if (e.key === 'ArrowRight') { stop(); goTo(step + 1); }
  if (e.key === 'ArrowLeft') { stop(); goTo(step - 1); }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});

document.getElementById('share-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Replay link copied');
  } catch {
    prompt('Copy this link:', location.href);
  }
});

// ---- reactions ----

function renderReactionPicker() {
  const picker = document.getElementById('rp-react-picker');
  picker.innerHTML = REACTIONS.map(
    (emoji) => `<button class="react-option" data-emoji="${emoji}">${emoji}</button>`
  ).join('');
  picker.addEventListener('click', async (e) => {
    const option = e.target.closest('[data-emoji]');
    if (!option) return;
    const account = currentAccount();
    const nickname = account?.displayName || localStorage.getItem('pp:lastNickname') || 'Guest';
    const res = await fetch(`/api/hands/${handId}/reactions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ emoji: option.dataset.emoji, nickname }),
    });
    if (res.ok) renderReactions((await res.json()).reactions);
  });
}

function renderReactions(reactions) {
  document.getElementById('rp-reactions').innerHTML = reactions.length
    ? reactions
        .map(
          (r) =>
            `<span class="reaction-chip" title="${escapeHtml(r.who.join(', '))}">${r.emoji} ${r.count}</span>`
        )
        .join('')
    : '<p class="empty-note">No reactions yet.</p>';
}

load();
