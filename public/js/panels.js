// Side panel (Chat / Log / Ledger tabs), seat-request queue, and host modal.

import { EVENTS, GAME_STATUS, VARIANTS } from '/shared/constants.js';
import { settleUp } from '/shared/settle.js';
import { escapeHtml, showToast } from '/js/ui.js';
import { PAYMENT_SERVICES, paymentUrl, displayHandle } from '/shared/payments.js';

let clientRef = null;
let chatLog = [];
let unread = 0;
let lastLogSig = '';

export function initPanels(client) {
  clientRef = client;

  // Tabs.
  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-body').forEach((b) => b.classList.add('hidden'));
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
      if (tab.dataset.tab === 'chat') clearUnread();
    });
  });

  // The header fairness chip opens the Fair tab.
  document.getElementById('fair-chip')?.addEventListener('click', () => {
    const p = document.getElementById('side-panel');
    p.classList.add('open');
    p.classList.remove('collapsed');
    document.querySelector('.tab[data-tab="fair"]')?.click();
  });

  // Mobile drawer toggle.
  const panel = document.getElementById('side-panel');
  document.getElementById('panel-toggle').addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) clearUnread();
  });
  document.getElementById('panel-close').addEventListener('click', () => {
    panel.classList.remove('open');
  });
  document.getElementById('panel-arrow')?.addEventListener('click', () => {
    panel.classList.remove('open');
  });

  // Drag the drawer to put it away: it tracks the finger 1:1 and commits when
  // the swipe has clearly left (past a third of its width, or a quick fling).
  // Vertical scrolling inside the chat list stays untouched — the drag only
  // arms once the movement is decisively sideways.
  let touch = null;
  panel.addEventListener('touchstart', (e) => {
    if (!panel.classList.contains('open')) return;
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, dx: 0, t: Date.now(), armed: false };
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = e.touches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    if (!touch.armed) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      touch.armed = true;
      panel.classList.add('dragging');
    }
    touch.dx = Math.max(0, dx); // only ever slides the way it closes
    panel.style.transform = `translateX(${touch.dx}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (!touch) return;
    const quick = touch.dx > 40 && Date.now() - touch.t < 260;
    const far = touch.dx > panel.getBoundingClientRect().width / 3;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (touch.armed && (quick || far)) panel.classList.remove('open');
    touch = null;
  });

  // Chat form.
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    client.send(EVENTS.CHAT, { text });
    input.value = '';
  });

  // Host modal.
  document.getElementById('h-variant').innerHTML = Object.values(VARIANTS)
    .map((v) => `<option value="${v.key}">${escapeHtml(v.label)}</option>`)
    .join('');
  document.getElementById('host-menu-btn').addEventListener('click', () => openHostModal(client));
  document.getElementById('h-done').addEventListener('click', closeHostModal);
  document.getElementById('host-modal').addEventListener('click', (e) => {
    if (e.target.id === 'host-modal') closeHostModal();
  });
  document.getElementById('h-72-on').addEventListener('change', (e) => {
    document.getElementById('h-72').disabled = !e.target.checked;
  });
  // Picking 747 opens its two settings right there in the host pop-up, so the
  // ante and the penalty cap are set at the moment you switch to it.
  document.getElementById('h-variant').addEventListener('change', sync747Fields);
  document.getElementById('h-save').addEventListener('click', () => {
    client.send(EVENTS.HOST_UPDATE_SETTINGS, {
      variant: document.getElementById('h-variant').value,
      smallBlind: parseInt(document.getElementById('h-sb').value, 10),
      bigBlind: parseInt(document.getElementById('h-bb').value, 10),
      actionTime: parseInt(document.getElementById('h-timer').value, 10),
      timeBank: parseInt(document.getElementById('h-timebank').value, 10),
      bombPotEvery: parseInt(document.getElementById('h-bomb').value, 10),
      sevenDeuceBounty: document.getElementById('h-72-on').checked
        ? parseInt(document.getElementById('h-72').value, 10) || 0
        : 0,
      straddle: document.getElementById('h-straddle').checked,
      rabbitHunt: document.getElementById('h-rabbit').checked,
      runItTwice: document.getElementById('h-rit').checked,
      levelMinutes: parseInt(document.getElementById('h-level').value, 10) || 15,
      rebuyMinutes: Math.max(0, parseInt(document.getElementById('h-rebuy').value, 10) || 0),
      ante747: parseInt(document.getElementById('h-747-ante').value, 10) || 0,
      penaltyCap747: Math.max(0, parseInt(document.getElementById('h-747-cap').value, 10) || 0),
    });
    showToast('Settings saved — they apply from the next hand', { ok: true });
  });
  document.getElementById('h-pause').addEventListener('click', () => {
    const paused = clientRef.state.status === GAME_STATUS.PAUSED || clientRef.state.pauseRequested;
    client.send(EVENTS.HOST_PAUSE, { paused: !paused });
  });
  document.getElementById('h-close-table').addEventListener('click', () => {
    if (confirm('Close the table for everyone? The ledger below is the final word.')) {
      client.send(EVENTS.HOST_CLOSE_TABLE, {});
    }
  });

  // Seat-request approvals (delegated).
  document.getElementById('seat-requests').addEventListener('click', (e) => {
    const seatBtn = e.target.closest('button[data-approve]');
    if (seatBtn) {
      client.send(EVENTS.HOST_APPROVE_SEAT, {
        playerId: seatBtn.dataset.player,
        approve: seatBtn.dataset.approve === 'yes',
      });
      return;
    }
    const waitBtn = e.target.closest('button[data-wait]');
    if (waitBtn) {
      client.send(EVENTS.HOST_APPROVE_WAITLIST, {
        playerId: waitBtn.dataset.player,
        approve: waitBtn.dataset.wait === 'yes',
      });
    }
  });

  // Tap-to-copy payment handles (Zelle/Chime have no deep link).
  document.getElementById('ledger-table').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('button[data-copy]');
    if (!copyBtn) return;
    const handle = copyBtn.dataset.copy;
    navigator.clipboard?.writeText(handle).then(
      () => showToast(`Copied ${handle}`, { ok: true }),
      () => showToast(handle)
    );
  });

  // Host player-list actions (delegated).
  document.getElementById('h-players').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-haction]');
    if (!btn) return;
    const playerId = btn.dataset.player;
    if (btn.dataset.haction === 'nudge') {
      client.send(EVENTS.HOST_NUDGE, { playerId });
      showToast('Nudged — they have a few seconds to act', { ok: true });
    } else if (btn.dataset.haction === 'kick') {
      if (confirm('Remove this player from the table?')) {
        client.send(EVENTS.HOST_KICK, { playerId });
      }
    } else {
      const raw = prompt(
        btn.dataset.haction === 'topup'
          ? 'Add how many chips?'
          : 'Remove how many chips?'
      );
      const amount = parseInt(raw, 10);
      if (!Number.isInteger(amount) || amount <= 0) return;
      client.send(EVENTS.HOST_ADJUST_STACK, {
        playerId,
        delta: btn.dataset.haction === 'topup' ? amount : -amount,
      });
    }
  });
}

export function notifyStateForPanels(client) {
  mergeChat(client.state.chatTail || []);
  renderChat();
  renderLog(client);
  renderLedger(client);
  renderSeatRequests(client);
  refreshHostModal(client);
  renderFairness(client);
}

// ---- provably-fair readout ----

function renderFairness(client) {
  const state = client.state;
  const table = state.fairness;
  const hand = state.hand?.fairness;
  const chip = document.getElementById('fair-chip');
  const panel = document.getElementById('fair-panel');
  if (!table) {
    if (chip) chip.classList.add('hidden');
    return;
  }

  // The live "hashed float value", visible on every hand.
  const floatStr = hand ? Number(hand.float).toFixed(6) : '—';
  if (chip) {
    chip.classList.remove('hidden');
    chip.textContent = `Shuffle ${floatStr}`;
  }
  if (!panel) return;

  // Only rebuild the panel when the fairness data actually changes — otherwise
  // a mid-hand state broadcast would wipe out what a player is typing into the
  // client-seed box.
  const sig = `${table.serverCommit}:${table.clientSeed}:${hand?.nonce ?? ''}`;
  if (panel.dataset.sig === sig) return;
  panel.dataset.sig = sig;

  const short = (h) => (typeof h === 'string' && h.length > 24 ? `${h.slice(0, 12)}…${h.slice(-8)}` : h || '—');

  panel.innerHTML = `
    <p class="fp-lead">Every deal is a fixed function of a committed <b>server seed</b>, the public <b>client seed</b>, and the hand number. The server is locked to its seed before any card is dealt.</p>
    <p class="fp-float" title="A [0,1) fingerprint of this hand's seeds">${floatStr}</p>
    <dl class="fp-list">
      <dt>Server commit</dt><dd class="mono" title="${escapeHtml(table.serverCommit)}">${escapeHtml(short(table.serverCommit))}</dd>
      <dt>Client seed</dt><dd class="mono">${escapeHtml(table.clientSeed)}</dd>
      ${hand ? `<dt>This hand</dt><dd class="mono">#${escapeHtml(String(hand.nonce))}</dd>` : ''}
      ${hand ? `<dt>Proof</dt><dd class="mono" title="${escapeHtml(hand.proof)}">${escapeHtml(short(hand.proof))}</dd>` : ''}
    </dl>
    <form id="fair-seed-form" class="fair-seed-form">
      <label>Set the table client seed</label>
      <div class="fair-seed-row">
        <input id="fair-seed-input" maxlength="64" placeholder="your own seed…" autocomplete="off" value="${escapeHtml(table.clientSeed)}">
        <button class="btn btn-primary" type="submit">Set</button>
      </div>
      <p class="fp-note">Setting your own client seed guarantees the house couldn't have picked a deck in its favour. Applies from the next hand.</p>
    </form>
    <p class="fp-note">The full deck is committed before each deal, so no card can change after the action. Open any finished hand's replay to verify its board and shown cards. Folded hands stay sealed forever.</p>
  `;

  const form = document.getElementById('fair-seed-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('fair-seed-input').value.trim();
    if (!val) return;
    clientRef.send(EVENTS.SET_CLIENT_SEED, { clientSeed: val });
  });
}

// ---- chat ----

function chatKey(m) {
  return `${m.ts}:${m.from}:${m.text}`;
}

function mergeChat(tail) {
  const known = new Set(chatLog.map(chatKey));
  for (const m of tail) {
    if (!known.has(chatKey(m))) chatLog.push(m);
  }
  chatLog.sort((a, b) => a.ts - b.ts);
  if (chatLog.length > 200) chatLog = chatLog.slice(-200);
}

export function onChatMessage(msg) {
  if (chatLog.some((m) => chatKey(m) === chatKey(msg))) return;
  chatLog.push(msg);
  renderChat();
  const panel = document.getElementById('side-panel');
  const chatVisible =
    !document.getElementById('tab-chat').classList.contains('hidden') &&
    (panel.classList.contains('open') || window.matchMedia('(min-width: 1000px)').matches);
  if (!chatVisible && msg.from !== clientRef?.you?.nickname) {
    unread++;
    const badge = document.getElementById('unread-badge');
    badge.textContent = unread;
    badge.classList.remove('hidden');
  }
}

function clearUnread() {
  unread = 0;
  document.getElementById('unread-badge').classList.add('hidden');
}

function renderChat() {
  const list = document.getElementById('chat-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = chatLog
    .map(
      (m) =>
        `<div class="chat-msg"><span class="chat-from">${escapeHtml(m.from)}</span> ${escapeHtml(m.text)}</div>`
    )
    .join('');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---- log ----

function renderLog(client) {
  const logs = client.state.logTail || [];
  const replayId = client.state.lastHandRecordId;
  const sig = `${logs.length}:${replayId || ''}`;
  if (sig === lastLogSig) return;
  lastLogSig = sig;
  const list = document.getElementById('log-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML =
    (replayId
      ? `<a class="replay-link" href="/hands/${replayId}" target="_blank" rel="noopener">Replay the last hand</a>`
      : '') +
    logs
      .map((l) => `<div class="log-line"><span class="log-no">#${l.handNo}</span> ${escapeHtml(l.text)}</div>`)
      .join('');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---- ledger ----

// NOTE: "Net" must stay the last column — the browser test reads it with
// td:last-child to assert the ledger balances to zero.
function renderLedger(client) {
  const rows = client.state.ledger || [];
  const host = document.getElementById('ledger-table');
  if (!rows.length) {
    host.innerHTML = '<p class="empty-note">Nobody has bought in yet.</p>';
    return;
  }
  const payments = settleUp(rows);
  // nickname -> that player's linked payment handles, so a settle-up line can
  // offer to pay the exact amount straight to the winner.
  const payTo = new Map(rows.filter((r) => r.payments).map((r) => [r.nickname, r.payments]));

  host.innerHTML = `
    <table class="ledger">
      <thead><tr><th>Player</th><th>Buy-ins</th><th>Stack</th><th>Hand</th><th>Net</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${escapeHtml(r.nickname)}</td>
            <td>${r.buyIns}</td>
            <td>${r.stack}</td>
            <td class="${deltaClass(r.lastHandDelta)}">${formatDelta(r.lastHandDelta)}</td>
            <td class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : ''}${r.net}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p class="empty-note">Net = cash-outs + current stack − buy-ins · "Hand" is the last hand's result</p>
    <div class="settle-block">
      <h4>Settle up</h4>
      ${
        payments.length
          ? `<ul class="settle-list">${payments
              .map(
                (p) => `<li>
                  <div class="settle-line"><strong>${escapeHtml(p.from)}</strong> pays <strong>${escapeHtml(p.to)}</strong> <span class="settle-amt">${p.amount}</span></div>
                  ${payButtons(payTo.get(p.to), p.amount)}
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty-note">Everyone is square.</p>'
      }
      <div class="ledger-actions">
        <button class="btn btn-ghost ledger-export" id="ledger-csv">Download CSV</button>
        <a class="btn btn-ghost ledger-export" href="/api/games/${encodeURIComponent(client.gameId)}/ledger.csv" target="_blank" rel="noopener" title="The copy saved on the server — safe even if the game is over">Saved copy</a>
      </div>
      <p class="empty-note">The ledger is auto-saved on the server, so it's here even if nobody screenshots it.</p>
    </div>`;

  document.getElementById('ledger-csv').addEventListener('click', () => exportLedgerCsv(client));
}

// Pay buttons for a settle-up line: a prefilled deep link for services that
// support one (Venmo/Cash App/PayPal), a tap-to-copy handle for the rest.
function payButtons(payments, amount) {
  if (!payments) return '';
  const btns = PAYMENT_SERVICES.filter((s) => payments[s.key]).map((s) => {
    const handle = payments[s.key];
    const url = paymentUrl(s.key, handle, { amount, note: 'Poker' });
    if (url) {
      return `<a class="pay-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">${s.icon} ${escapeHtml(s.label)}</a>`;
    }
    const shown = displayHandle(s.key, handle);
    return `<button type="button" class="pay-btn copy" data-copy="${escapeHtml(shown)}" title="Copy ${escapeHtml(s.label)} handle">${s.icon} ${escapeHtml(shown)}</button>`;
  });
  return btns.length ? `<div class="pay-options">${btns.join('')}</div>` : '';
}

function deltaClass(delta) {
  if (!delta) return 'dim';
  return delta > 0 ? 'pos' : 'neg';
}

function formatDelta(delta) {
  if (!delta) return '—';
  return `${delta > 0 ? '+' : ''}${delta}`;
}

function exportLedgerCsv(client) {
  const rows = client.state.ledger || [];
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [
    ['Player', 'Buy-ins', 'Cash-outs', 'Stack', 'Hands', 'Net'].join(','),
    ...rows.map((r) =>
      [esc(r.nickname), r.buyIns, r.cashOuts, r.stack, r.handsPlayed || 0, r.net].join(',')
    ),
    '',
    ['Settle up: from', 'to', 'amount'].join(','),
    ...settleUp(rows).map((p) => [esc(p.from), esc(p.to), p.amount].join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pineapple-ledger-${client.gameId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- seat requests and waitlist (host) ----

// Tracks which pending requesters the host has already been shown, so a toast
// fires once per newcomer and not again on every state refresh. null until the
// first state so a reconnecting host isn't spammed for people already waiting.
let seenSeatReqs = null;

function updateSeatReqBadge(client, isHost, reqs) {
  const badge = document.getElementById('seatreq-badge');
  const waiting = isHost
    ? [...reqs, ...(client.state.waitlist || []).filter((w) => !w.approved)]
    : [];
  const ids = new Set(waiting.map((r) => r.playerId));

  if (badge) {
    badge.textContent = String(waiting.length);
    badge.classList.toggle('hidden', waiting.length === 0);
  }

  if (seenSeatReqs !== null && isHost) {
    const fresh = waiting.filter((r) => !seenSeatReqs.has(r.playerId));
    if (fresh.length === 1) {
      showToast(`${fresh[0].nickname} wants to join — tap Chat to let them in`);
    } else if (fresh.length > 1) {
      showToast(`${fresh.length} players want to join — tap Chat to let them in`);
    }
  }
  seenSeatReqs = ids;
}

function renderSeatRequests(client) {
  const box = document.getElementById('seat-requests');
  const reqs = client.state.seatRequests || [];
  const queue = client.state.waitlist || [];
  const isHost = client.you?.isHost;

  // Surface pending requests where the host will actually notice them: a badge
  // on the Chat button (visible even with the panel closed, e.g. on a phone) and
  // a toast the moment a new person asks to join. Without this the approve
  // buttons sit unseen inside a closed drawer.
  updateSeatReqBadge(client, isHost, reqs);

  const show = (isHost && (reqs.length > 0 || queue.length > 0)) || queue.length > 0;
  box.classList.toggle('hidden', !show);
  if (!show) {
    box.innerHTML = '';
    return;
  }

  const requestBlock = isHost && reqs.length
    ? `<div class="sr-title">Seat requests</div>
       ${reqs
         .map(
           (r) => `
      <div class="sr-row">
        <span>${escapeHtml(r.nickname)} · ${r.buyIn}</span>
        <span>
          <button class="btn btn-green sr-btn" data-approve="yes" data-player="${r.playerId}">Approve</button>
          <button class="btn btn-red sr-btn" data-approve="no" data-player="${r.playerId}">Decline</button>
        </span>
      </div>`
         )
         .join('')}`
    : '';

  const queueBlock = queue.length
    ? `<div class="sr-title">Waitlist — table full</div>
       ${queue
         .map(
           (w) => `
      <div class="sr-row">
        <span>${w.position}. ${escapeHtml(w.nickname)} · ${w.buyIn}${w.approved ? ' · approved' : ''}</span>
        ${
          isHost && !w.approved
            ? `<span>
                 <button class="btn btn-green sr-btn" data-wait="yes" data-player="${w.playerId}">Approve</button>
                 <button class="btn btn-red sr-btn" data-wait="no" data-player="${w.playerId}">Remove</button>
               </span>`
            : ''
        }
      </div>`
         )
         .join('')}`
    : '';

  box.innerHTML = requestBlock + queueBlock;
}

// ---- host modal ----

// The 747 ante and penalty cap only mean anything on a 747 table, so they are
// revealed by the variant picker rather than sitting dead on every other game.
function sync747Fields() {
  const on = document.getElementById('h-variant').value === '747';
  document.getElementById('h-747-row').classList.toggle('hidden', !on);
  document.getElementById('h-747-note').classList.toggle('hidden', !on);
}

function openHostModal(client) {
  const s = client.state.settings;
  document.getElementById('h-variant').value = s.variant;
  document.getElementById('h-level').value = String(s.levelMinutes ?? 15);
  document.getElementById('h-rebuy').value = String(s.rebuyMinutes ?? 60);
  document.getElementById('h-tourney-row').classList.toggle('hidden', !s.tournament);
  document.getElementById('h-747-ante').value = String(s.ante747 || s.bigBlind);
  document.getElementById('h-747-cap').value = String(s.penaltyCap747 ?? 0);
  sync747Fields();
  document.getElementById('h-sb').value = s.smallBlind;
  document.getElementById('h-bb').value = s.bigBlind;
  document.getElementById('h-timer').value = String(s.actionTime);
  document.getElementById('h-timebank').value = String(s.timeBank ?? 0);
  document.getElementById('h-bomb').value = String(s.bombPotEvery ?? 0);
  const bountyOn = (s.sevenDeuceBounty ?? 0) > 0;
  document.getElementById('h-72-on').checked = bountyOn;
  document.getElementById('h-72').disabled = !bountyOn;
  // Keep a sensible amount staged even while the toggle is off.
  document.getElementById('h-72').value = String(bountyOn ? s.sevenDeuceBounty : Math.max(s.bigBlind * 5, 1));
  document.getElementById('h-straddle').checked = !!s.straddle;
  document.getElementById('h-rabbit').checked = !!s.rabbitHunt;
  document.getElementById('h-rit').checked = !!s.runItTwice;
  refreshHostModal(client, true);
  document.getElementById('host-modal').classList.remove('hidden');
}

function closeHostModal() {
  document.getElementById('host-modal').classList.add('hidden');
}

function refreshHostModal(client, force = false) {
  const modal = document.getElementById('host-modal');
  if (modal.classList.contains('hidden') && !force) return;

  const pauseBtn = document.getElementById('h-pause');
  const paused = client.state.status === GAME_STATUS.PAUSED || client.state.pauseRequested;
  pauseBtn.textContent =
    client.state.status === GAME_STATUS.LOBBY
      ? 'Not started'
      : paused
        ? 'Resume'
        : 'Pause';
  pauseBtn.disabled = client.state.status === GAME_STATUS.LOBBY;

  const seated = client.state.seats
    .map((s, i) => (s ? { ...s, seatIndex: i } : null))
    .filter(Boolean);
  document.getElementById('h-players').innerHTML = seated.length
    ? seated
        .map(
          (p) => `
      <div class="hp-row">
        <span class="hp-name">${escapeHtml(p.nickname)}${p.playerId === client.you.playerId ? ' (you)' : ''}</span>
        <span class="hp-stack">${p.stack}</span>
        <span class="hp-actions">
          <button class="btn btn-ghost hp-btn" data-haction="topup" data-player="${p.playerId}">＋ chips</button>
          <button class="btn btn-ghost hp-btn" data-haction="reduce" data-player="${p.playerId}">− chips</button>
          ${
            client.state.hand && !client.state.hand.finished &&
            client.state.hand.toActSeat === p.seatIndex
              ? `<button class="btn btn-ghost hp-btn" data-haction="nudge" data-player="${p.playerId}">Nudge</button>`
              : ''
          }
          ${p.playerId !== client.you.playerId
            ? `<button class="btn btn-ghost hp-btn hp-kick" data-haction="kick" data-player="${p.playerId}">Kick</button>`
            : ''}
        </span>
      </div>`
        )
        .join('')
    : '<p class="empty-note">Nobody is seated yet.</p>';
}

// (The old "rotate your phone" nag is gone: an upright phone now gets a real
// vertical table, so there is nothing to apologise for.)
