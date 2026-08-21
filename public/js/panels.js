// Side panel (Chat / Log / Ledger tabs), seat-request queue, and host modal.

import { EVENTS, GAME_STATUS, VARIANTS } from '/shared/constants.js';
import { settleUp, payeeLabeller } from '/shared/settle.js';
import { escapeHtml, showToast } from '/js/ui.js';
import { PAYMENT_SERVICES, paymentUrl, displayHandle } from '/shared/payments.js';
import { buildXlsx, ledgerSheet, LEDGER_WIDTHS } from '/shared/xlsx.js';

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
  document.getElementById('fair-chip')?.addEventListener('click', openFair);
  document.getElementById('fair-close')?.addEventListener('click', closeFair);
  document.getElementById('fair-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'fair-modal') closeFair();
  });

  // The ledger pop-up: a button beside the chat tabs, Close, backdrop, Escape.
  document.getElementById('ledger-tab-btn')?.addEventListener('click', openLedger);
  document.getElementById('ledger-close')?.addEventListener('click', closeLedger);
  document.getElementById('ledger-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'ledger-modal') closeLedger();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeLedger();
    closeFair();
  });

  // The Chat button is exactly that: it opens the panel ON the chat tab.
  // (Log, ledger and shuffle-verification have their own doors now, so a
  // toggle that landed on whatever tab was last open just reads as broken.)
  // Desktop, where the dock is always in view, it folds/unfolds the dock.
  const panel = document.getElementById('side-panel');
  document.getElementById('panel-toggle').addEventListener('click', () => {
    const chatActive = document.querySelector('.tab[data-tab="chat"]')?.classList.contains('active');
    const desktop = window.matchMedia('(min-width: 1000px)').matches;
    const showing = desktop
      ? !panel.classList.contains('dock-closed')
      : panel.classList.contains('open');
    if (showing && chatActive) {
      panel.classList.remove('open');
      if (desktop) setDock(true);
    } else {
      openPanel('chat');
    }
  });

  // The dock folds to its tab strip and back; picking any tab unfolds it.
  document.getElementById('dock-toggle')?.addEventListener('click', () => {
    setDock(!panel.classList.contains('dock-closed'));
  });
  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setDock(false));
  });
  // The dock starts FOLDED. The table is what people came for, and an open
  // chat costs it a quarter of the screen; one tap on Chat brings it back,
  // and whichever way you leave it is what you get next time.
  let dockPref = null;
  try { dockPref = localStorage.getItem('pp:chatDock'); } catch { /* private browsing */ }
  if (dockPref !== 'open') setDock(true);
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
  // Every game a table can be set to. Hidden variants are dealt by the engine
  // for a single hand (the bomb pot's Omaha) and are not games you choose.
  document.getElementById('h-variant').innerHTML = Object.values(VARIANTS)
    .filter((v) => !v.hidden)
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
      // One control, two settings: "freq:x" is a random frequency, a bare
      // number is the old fixed cadence. Only one of them is ever in force.
      ...(() => {
        const v = document.getElementById('h-bomb').value;
        return v.startsWith('freq:')
          ? { bombPotEvery: 0, bombPotFrequency: v.slice(5) }
          : { bombPotEvery: parseInt(v, 10) || 0, bombPotFrequency: 'off' };
      })(),
      bombPotAnte: Math.max(0, parseInt(document.getElementById('h-bomb-ante').value, 10) || 0),
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

  // Tap-to-copy payment handles (Zelle/Chime have no deep link), and the
  // per-player Details drawers — both delegated, because the ledger's HTML is
  // rebuilt on every state update.
  document.getElementById('ledger-table').addEventListener('click', (e) => {
    const detailsBtn = e.target.closest('button[data-details]');
    if (detailsBtn) {
      const pid = detailsBtn.dataset.details;
      if (openDetails.has(pid)) openDetails.delete(pid);
      else openDetails.add(pid);
      detailsBtn
        .closest('.sl-row')
        ?.querySelector('.sl-more')
        ?.classList.toggle('hidden', !openDetails.has(pid));
      return;
    }
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
    } else if (btn.dataset.haction === 'makehost') {
      // Deliberately final: the table has exactly one host, and the only way
      // back is for the new one to hand it over again.
      const name = btn.closest('.hp-row')?.querySelector('.hp-name')?.textContent?.trim() || 'them';
      if (confirm(`Make ${name} the host? You will lose the host controls, and only they can give them back.`)) {
        client.send(EVENTS.HOST_TRANSFER, { playerId });
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

// Fold or unfold the desktop chat dock. Folded, only the tab strip (and any
// pending seat requests) stays; the bottom row shrinks and the table refits
// through the app's own resize path. The choice sticks per device.
function setDock(closed) {
  const p = document.getElementById('side-panel');
  if (!p) return;
  p.classList.toggle('dock-closed', closed);
  const t = document.getElementById('dock-toggle');
  if (t) {
    t.textContent = closed ? 'Show' : 'Hide';
    t.title = closed ? 'Unfold the chat' : 'Fold the chat away — the table gets the room';
  }
  try { localStorage.setItem('pp:chatDock', closed ? 'closed' : 'open'); } catch { /* private browsing */ }
  window.dispatchEvent(new Event('resize'));
}

// Open the side panel on a named tab, from anywhere: the menu's Game log /
// Verify shuffle entries, the fairness chip, the Chat button.
export function openPanel(tabName) {
  const p = document.getElementById('side-panel');
  p.classList.add('open');
  p.classList.remove('collapsed');
  setDock(false);
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.click();
}

// The ledger is a pop-up: openable from the top bar or beside the chat tabs,
// closable from its Close button, the backdrop, or Escape.
// The provably-fair readout is a pop-up too: opened from Settings > Table >
// Verify integrity, or from the shuffle chip in the bar.
export function openFair() {
  document.getElementById('fair-modal')?.classList.remove('hidden');
}

export function closeFair() {
  document.getElementById('fair-modal')?.classList.add('hidden');
}

export function openLedger() {
  document.getElementById('ledger-modal')?.classList.remove('hidden');
}

export function closeLedger() {
  document.getElementById('ledger-modal')?.classList.add('hidden');
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

  // The signature still moves every time a new hand is dealt, so the rebuild
  // below can land while someone is part-way through typing a seed. Carry the
  // half-typed value (and the caret) across it — defaultValue is whatever the
  // table's committed seed was when the box was drawn, so anything different
  // is something the player typed.
  const oldSeed = document.getElementById('fair-seed-input');
  const typedSeed = oldSeed && oldSeed.value !== oldSeed.defaultValue ? oldSeed.value : null;
  const seedHadFocus = !!oldSeed && document.activeElement === oldSeed;

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

  if (typedSeed !== null) {
    const nextSeed = document.getElementById('fair-seed-input');
    if (nextSeed) {
      nextSeed.value = typedSeed;
      if (seedHadFocus) nextSeed.focus();
    }
  }

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
  // "Visible" means you can actually read it: the chat tab is the one showing
  // AND the panel is open — which on a laptop means the dock is unfolded, not
  // merely that the screen is big. The dock starts folded, so treating every
  // desktop as chat-visible would silently swallow the unread badge.
  const desktop = window.matchMedia('(min-width: 1000px)').matches;
  const panelShown = desktop
    ? !panel.classList.contains('dock-closed')
    : panel.classList.contains('open');
  const chatVisible =
    !document.getElementById('tab-chat').classList.contains('hidden') && panelShown;
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

// Details drawers the user has opened, by playerId — the ledger re-renders on
// every state update while the pop-up is showing, so open drawers must survive
// the rebuild.
const openDetails = new Set();

function renderLedger(client) {
  // Winners first, like a session ledger reads: sorted by net, descending.
  const rows = [...(client.state.ledger || [])].sort((a, b) => b.net - a.net);
  const host = document.getElementById('ledger-table');
  if (!rows.length) {
    host.innerHTML = '<p class="empty-note">Nobody has bought in yet.</p>';
    return;
  }
  const payments = settleUp(rows);
  // Keyed by PLAYER ID, never by the displayed name. A ledger name is free text
  // and nothing stops two people choosing the same one, so a name key let a
  // second player's payment handles overwrite the winner's — and the Pay button
  // on "Carl pays Ayden 300" would have opened Venmo pointed at whoever claimed
  // the name last. Money follows identity.
  const payTo = new Map(
    rows.filter((r) => r.payments).map((r) => [r.playerId, r.payments])
  );
  // Two rows that display the same name are disambiguated by the username the
  // table actually knows them by, so a settle-up line is never ambiguous.
  const payeeLabel = payeeLabeller(rows);

  // The books check everyone can see: every chip bought in is either in a
  // stack, cashed out, or riding in the 747 pot. Σnet is stacks + cash-outs
  // − buy-ins, so the whole table balances exactly when Σnet + carry = 0.
  const hand = client.state.hand;
  const carry = (client.state.carryPot || 0) + (hand && !hand.finished ? hand.carryIn || 0 : 0);
  const netSum = rows.reduce((a, r) => a + r.net, 0);
  const balanced = netSum + carry === 0;
  const booksLine = balanced
    ? `<p class="books-line ok" id="books-line">✓ Books balance — every chip is in a stack${carry > 0 ? ` or the riding pot (${carry})` : ''}</p>`
    : `<p class="books-line bad" id="books-line">✗ Books off by ${Math.abs(netSum + carry)} — tell the host</p>`;

  const totals = rows.reduce(
    (t, r) => ({ buyIns: t.buyIns + r.buyIns, cashOuts: t.cashOuts + r.cashOuts, stack: t.stack + r.stack }),
    { buyIns: 0, cashOuts: 0, stack: 0 }
  );

  host.innerHTML = `
    <div class="sledger">
      <div class="sl-grid sl-head">
        <span>Player</span><span>Buy-in</span><span>Buy-out</span><span>Stack</span><span>Net ↓</span>
      </div>
      ${rows
        .map(
          (r) => `
      <div class="sl-row">
        <div class="sl-grid">
          <span class="sl-player">
            <span class="sl-who">
              <span class="sl-name">${escapeHtml(r.realName || r.nickname)}</span>
              <span class="sl-id">${r.realName
                ? `${escapeHtml(r.nickname)} · @${escapeHtml(r.playerId)}`
                : `@${escapeHtml(r.playerId)}`}</span>
            </span>
            <button type="button" class="sl-details" data-details="${escapeHtml(r.playerId)}" title="Hands played, last hand's result, how to pay them">Details</button>
          </span>
          <span class="sl-num">${r.buyIns}</span>
          <span class="sl-num">${r.cashOuts}</span>
          <span class="sl-num">${r.stack}</span>
          <span class="sl-num sl-net ${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : ''}${r.net}</span>
        </div>
        <div class="sl-more${openDetails.has(r.playerId) ? '' : ' hidden'}">
          <span>${r.handsPlayed || 0} hand${(r.handsPlayed || 0) === 1 ? '' : 's'} played</span>
          <span>Last hand: <span class="${deltaClass(r.lastHandDelta)}">${formatDelta(r.lastHandDelta)}</span></span>
          <span>${r.seated ? 'Seated' : 'Away'}</span>
          ${r.net > 0 ? payButtons(r.payments, r.net) : ''}
        </div>
      </div>`
        )
        .join('')}
      <div class="sl-row sl-total">
        <div class="sl-grid">
          <span class="sl-total-label">Table total</span>
          <span class="sl-num">${totals.buyIns}</span>
          <span class="sl-num">${totals.cashOuts}</span>
          <span class="sl-num">${totals.stack}</span>
          <span class="sl-num"></span>
        </div>
      </div>
    </div>
    <p class="empty-note">Net = buy-out + current stack − buy-in · winners first · Details has each player's last hand</p>
    ${booksLine}
    <div class="settle-block">
      <h4>Settle up</h4>
      ${
        payments.length
          ? `<ul class="settle-list">${payments
              .map(
                (p) => `<li>
                  <div class="settle-line"><strong>${escapeHtml(payeeLabel(p.fromId, p.from))}</strong> pays <strong>${escapeHtml(payeeLabel(p.toId, p.to))}</strong> <span class="settle-amt">${p.amount}</span></div>
                  ${payButtons(payTo.get(p.toId), p.amount)}
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty-note">Everyone is square.</p>'
      }
      <div class="ledger-actions">
        <button class="btn btn-primary ledger-export" id="ledger-xlsx" title="The ledger as a spreadsheet — winners in green, losers in red">Download ledger</button>
        <button class="btn btn-ghost ledger-export ledger-plain" id="ledger-csv" title="Plain text, no colour — for pasting into something else">Plain CSV</button>
        <a class="btn btn-ghost ledger-export" href="/api/games/${encodeURIComponent(client.gameId)}/ledger.xlsx" target="_blank" rel="noopener" title="The copy saved on the server — safe even if the game is over">Saved copy</a>
      </div>
      <p class="empty-note">The ledger is auto-saved on the server, so it's here even if nobody screenshots it.</p>
    </div>`;

  document.getElementById('ledger-csv').addEventListener('click', () => exportLedgerCsv(client));
  document.getElementById('ledger-xlsx')?.addEventListener('click', () => exportLedgerXlsx(client));
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

// The last hand reads as what the winner won, and nothing else. Losing a pot
// is already obvious from your own stack — having the size of it spelled out
// next to your name, for the whole table to open, is a different thing.
function deltaClass(delta) {
  return delta > 0 ? 'pos' : 'dim';
}

function formatDelta(delta) {
  return delta > 0 ? `+${delta}` : '—';
}

// The same ledger as a spreadsheet, with each row filled by how the night went:
// green if you are up, red if you are down. A .csv is plain text and cannot
// carry that, so colour needs a real workbook.
function exportLedgerXlsx(client) {
  const rows = [...(client.state.ledger || [])].sort((a, b) => b.net - a.net);
  if (!rows.length) {
    showToast('Nobody has bought in yet');
    return;
  }
  const settle = settleUp(rows);
  const label = payeeLabeller(rows);
  const bytes = buildXlsx(
    ledgerSheet(rows, {
      meta: [
        ['Game', client.gameId],
        ['Date', new Date().toISOString().slice(0, 10)],
        ['Variant', VARIANTS[client.state.settings.variant]?.label || client.state.settings.variant],
        ['Blinds', `${client.state.settings.smallBlind}/${client.state.settings.bigBlind}`],
      ],
      // Same disambiguation the panel itself shows, so the spreadsheet never
      // says "John Smith pays John Smith".
      settle: settle.map((p) => ({
        ...p, from: label(p.fromId, p.from), to: label(p.toId, p.to),
      })),
    }),
    { widths: LEDGER_WIDTHS }
  );
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reg-poker-ledger-${client.gameId}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportLedgerCsv(client) {
  const rows = client.state.ledger || [];
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [
    // Both names: the one who gets paid, and the one they played under.
    ['Name', 'Username', 'Buy-ins', 'Cash-outs', 'Stack', 'Hands', 'Net'].join(','),
    ...rows.map((r) =>
      [esc(r.realName || r.nickname), esc(r.nickname), r.buyIns, r.cashOuts, r.stack,
        r.handsPlayed || 0, r.net].join(',')
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
  document.getElementById('h-bomb').value = s.bombPotEvery > 0
    ? String(s.bombPotEvery)
    : s.bombPotFrequency && s.bombPotFrequency !== 'off'
      ? `freq:${s.bombPotFrequency}`
      : '0';
  document.getElementById('h-bomb-ante').value = s.bombPotAnte > 0 ? String(s.bombPotAnte) : '';
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
            ? `<button class="btn btn-ghost hp-btn" data-haction="makehost" data-player="${p.playerId}"
                       title="Hand the table to ${escapeHtml(p.nickname)} — you keep your seat, they get the controls">Make host</button>
               <button class="btn btn-ghost hp-btn hp-kick" data-haction="kick" data-player="${p.playerId}">Kick</button>`
            : ''}
        </span>
      </div>`
        )
        .join('')
    : '<p class="empty-note">Nobody is seated yet.</p>';
}

// (The old "rotate your phone" nag is gone: an upright phone now gets a real
// vertical table, so there is nothing to apologise for.)
