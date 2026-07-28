// Side panel (Chat / Log / Ledger tabs), seat-request queue, and host modal.

import { EVENTS, GAME_STATUS } from '/shared/constants.js';
import { settleUp } from '/shared/settle.js';
import { escapeHtml, showToast } from '/js/ui.js';

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

  // Mobile drawer toggle.
  const panel = document.getElementById('side-panel');
  document.getElementById('panel-toggle').addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) clearUnread();
  });
  document.getElementById('panel-close').addEventListener('click', () => {
    panel.classList.remove('open');
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

  // Rotate hint.
  document.getElementById('rotate-dismiss').addEventListener('click', () => {
    document.getElementById('rotate-hint').classList.add('hidden');
    sessionStorage.setItem('pp:rotate-dismissed', '1');
  });
  updateRotateHint();
  window.addEventListener('resize', updateRotateHint);

  // Host modal.
  document.getElementById('host-menu-btn').addEventListener('click', () => openHostModal(client));
  document.getElementById('h-done').addEventListener('click', closeHostModal);
  document.getElementById('host-modal').addEventListener('click', (e) => {
    if (e.target.id === 'host-modal') closeHostModal();
  });
  document.getElementById('h-save').addEventListener('click', () => {
    client.send(EVENTS.HOST_UPDATE_SETTINGS, {
      smallBlind: parseInt(document.getElementById('h-sb').value, 10),
      bigBlind: parseInt(document.getElementById('h-bb').value, 10),
      actionTime: parseInt(document.getElementById('h-timer').value, 10),
      timeBank: parseInt(document.getElementById('h-timebank').value, 10),
      bombPotEvery: parseInt(document.getElementById('h-bomb').value, 10),
      sevenDeuceBounty: parseInt(document.getElementById('h-72').value, 10) || 0,
      straddle: document.getElementById('h-straddle').checked,
      rabbitHunt: document.getElementById('h-rabbit').checked,
      runItTwice: document.getElementById('h-rit').checked,
    });
    showToast('Settings saved — they apply from the next hand');
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

  // Host player-list actions (delegated).
  document.getElementById('h-players').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-haction]');
    if (!btn) return;
    const playerId = btn.dataset.player;
    if (btn.dataset.haction === 'nudge') {
      client.send(EVENTS.HOST_NUDGE, { playerId });
      showToast('Nudged — they have a few seconds to act');
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
      ? `<a class="replay-link" href="/hands/${replayId}" target="_blank" rel="noopener">▶ Replay the last hand</a>`
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
                (p) =>
                  `<li><strong>${escapeHtml(p.from)}</strong> pays <strong>${escapeHtml(p.to)}</strong> <span class="settle-amt">${p.amount}</span></li>`
              )
              .join('')}</ul>`
          : '<p class="empty-note">Everyone is square.</p>'
      }
      <button class="btn btn-ghost ledger-export" id="ledger-csv">Download CSV</button>
    </div>`;

  document.getElementById('ledger-csv').addEventListener('click', () => exportLedgerCsv(client));
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

function renderSeatRequests(client) {
  const box = document.getElementById('seat-requests');
  const reqs = client.state.seatRequests || [];
  const queue = client.state.waitlist || [];
  const isHost = client.you?.isHost;
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
          <button class="btn btn-green sr-btn" data-approve="yes" data-player="${r.playerId}">✓</button>
          <button class="btn btn-red sr-btn" data-approve="no" data-player="${r.playerId}">✕</button>
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
        <span>${w.position}. ${escapeHtml(w.nickname)} · ${w.buyIn}${w.approved ? ' ✓' : ''}</span>
        ${
          isHost && !w.approved
            ? `<span>
                 <button class="btn btn-green sr-btn" data-wait="yes" data-player="${w.playerId}">✓</button>
                 <button class="btn btn-red sr-btn" data-wait="no" data-player="${w.playerId}">✕</button>
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

function openHostModal(client) {
  const s = client.state.settings;
  document.getElementById('h-sb').value = s.smallBlind;
  document.getElementById('h-bb').value = s.bigBlind;
  document.getElementById('h-timer').value = String(s.actionTime);
  document.getElementById('h-timebank').value = String(s.timeBank ?? 0);
  document.getElementById('h-bomb').value = String(s.bombPotEvery ?? 0);
  document.getElementById('h-72').value = String(s.sevenDeuceBounty ?? 0);
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

// ---- rotate hint ----

function updateRotateHint() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const small = window.innerWidth < 720;
  const dismissed = sessionStorage.getItem('pp:rotate-dismissed');
  document
    .getElementById('rotate-hint')
    .classList.toggle('hidden', !(portrait && small) || !!dismissed);
}
