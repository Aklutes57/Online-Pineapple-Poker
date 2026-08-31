// Profile page: all-time ledger, poker stats, account settings.
// Phase 1 renders identity + settings; the ledger and stat blocks fill in
// from /api/me/summary once results are being recorded.

import { loadAccount, currentAccount, signout, updateAccount, authHeaders } from '/js/auth.js';
import { openAuthModal } from '/js/authModal.js';
import { showToast, escapeHtml } from '/js/ui.js';
import { pushSupported, currentPushSubscription, enablePush, disablePush } from '/js/pwa.js';
import { PAYMENT_SERVICES, displayHandle, handleOf } from '/shared/payments.js';
import { payeeLabeller } from '/shared/settle.js';

// ---- notifications on this device ----

async function syncPushToggle() {
  const btn = document.getElementById('push-toggle');
  if (!pushSupported()) {
    btn.disabled = true;
    btn.textContent = 'Not supported in this browser';
    return;
  }
  const subscription = await currentPushSubscription();
  btn.textContent = subscription ? 'Turn off notifications' : 'Turn on notifications';
}

document.getElementById('push-toggle').addEventListener('click', async () => {
  const subscription = await currentPushSubscription();
  if (subscription) {
    await disablePush();
    showToast('Notifications off on this device');
  } else {
    // Signed in: the subscription is tied to the account, so alerts follow
    // you to any table you sit at.
    const result = await enablePush(authHeaders());
    showToast(result.ok ? 'Notifications on' : result.error);
  }
  syncPushToggle();
});

syncPushToggle();

const signedOut = document.getElementById('signed-out');
const signedIn = document.getElementById('signed-in');

document.getElementById('so-signin').addEventListener('click', () =>
  openAuthModal({ onSuccess: () => location.reload() })
);

document.getElementById('p-save').addEventListener('click', async () => {
  const displayName = document.getElementById('p-name').value.trim();
  const result = await updateAccount({ displayName });
  showToast(result.ok ? 'Saved' : result.error);
  if (result.ok) render();
});

function renderAccountSlot() {
  const slot = document.getElementById('account-slot');
  const account = currentAccount();
  if (!account) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = '<button class="btn btn-ghost nav-btn" id="signout-btn">Sign out</button>';
  document.getElementById('signout-btn').addEventListener('click', async () => {
    await signout();
    location.href = '/';
  });
}

function render() {
  const account = currentAccount();
  renderAccountSlot();
  signedOut.classList.toggle('hidden', !!account);
  signedIn.classList.toggle('hidden', !account);
  if (!account) return;

  document.getElementById('profile-name').textContent = account.displayName;
  document.getElementById('profile-sub').textContent =
    `${account.email} · joined ${new Date(account.createdAt).toLocaleDateString()}`;
  document.getElementById('p-name').value = account.displayName;
  renderPayFields(account);
  renderAvatar(account.avatarUrl || account.prefs?.avatarUrl || null);
}

// ---- payment methods ----

function renderPayFields(account, errors = {}) {
  const wrap = document.getElementById('pay-fields');
  if (!wrap) return;
  const saved = account.prefs?.payments || {};
  wrap.innerHTML = PAYMENT_SERVICES.map((s) => {
    const value = saved[s.key] || '';
    // Venmo, Cash App and PayPal take the link the app hands you. The sigil
    // box in front of the input belongs to the two services that are still a
    // handle — it reads as nonsense in front of a URL.
    const isLink = s.kind === 'link';
    const handle = value ? handleOf(s.key, value) : '';
    return `
    <div class="field pay-field">
      <label for="pay-${s.key}">${s.icon} ${escapeHtml(s.label)}</label>
      <div class="pay-input">
        ${!isLink && s.prefix ? `<span class="pay-prefix">${s.prefix}</span>` : ''}
        <input id="pay-${s.key}" data-pay="${s.key}" maxlength="${isLink ? 300 : 64}"
          type="${isLink ? 'url' : 'text'}" spellcheck="false"
          placeholder="${escapeHtml(s.placeholder)}" autocomplete="off"
          value="${escapeHtml(value)}">
      </div>
      ${errors[s.key]
        ? `<span class="pay-hint pay-error">${escapeHtml(errors[s.key])}</span>`
        : `<span class="pay-hint">${escapeHtml(s.hint)}</span>`}
      ${value && isLink && handle
        ? `<span class="pay-hint pay-resolved">Pays ${escapeHtml(displayHandle(s.key, value))}</span>`
        : ''}
    </div>`;
  }).join('');
}

document.getElementById('pay-save').addEventListener('click', async () => {
  const payments = {};
  for (const input of document.querySelectorAll('#pay-fields input[data-pay]')) {
    const v = input.value.trim();
    if (v) payments[input.dataset.pay] = v;
  }
  try {
    const res = await fetch('/api/me/payments', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ payments }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    // Reflect the canonical links the server built back into the fields, so
    // what you see is exactly what your table-mates will open.
    const account = currentAccount();
    const errors = data.errors || {};
    if (account) {
      account.prefs = { ...account.prefs, payments: data.payments };
      renderPayFields(account, errors);
    }
    const bad = Object.keys(errors);
    if (bad.length) {
      showToast(errors[bad[0]]);
    } else {
      showToast('Payment methods saved', { ok: true });
    }
  } catch {
    showToast('Could not save payment methods');
  }
});

async function loadSummary() {
  try {
    const res = await fetch('/api/me/summary', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderSummary(data);
  } catch {
    /* summary is best-effort; identity still renders */
  }
}

function renderSummary({ totals, sessions, stats }) {
  const netClass = totals.net >= 0 ? 'pos' : 'neg';
  document.getElementById('alltime-summary').innerHTML = `
    <div class="stat-tile"><span class="stat-label">Net</span>
      <span class="stat-value ${netClass}">${totals.net >= 0 ? '+' : ''}${totals.net}</span></div>
    <div class="stat-tile"><span class="stat-label">Sessions</span>
      <span class="stat-value">${totals.sessions}</span></div>
    <div class="stat-tile"><span class="stat-label">Hands</span>
      <span class="stat-value">${totals.hands}</span></div>
    <div class="stat-tile"><span class="stat-label">Biggest pot</span>
      <span class="stat-value">${totals.biggestPot}</span></div>`;

  const table = document.getElementById('sessions-table');
  if (!sessions.length) {
    table.innerHTML = '<p class="empty-note">No finished sessions yet — play a hand and it shows up here.</p>';
  } else {
    table.innerHTML = `
      <table class="ledger">
        <thead><tr><th>When</th><th>Game</th><th>Blinds</th><th>Buy-ins</th><th>Out</th><th>Net</th><th>Ledger</th></tr></thead>
        <tbody>${sessions
          .map(
            (s) => `<tr>
              <td>${new Date(s.startedAt).toLocaleDateString()}</td>
              <td>${escapeHtml(s.variant)}</td>
              <td>${s.smallBlind}/${s.bigBlind}</td>
              <td>${s.buyIns}</td>
              <td>${s.cashOuts + s.finalStack}</td>
              <td class="${s.net >= 0 ? 'pos' : 'neg'}">${s.net >= 0 ? '+' : ''}${s.net}</td>
              <td><a class="csv-link" href="/api/games/${encodeURIComponent(s.gameId)}/ledger.xlsx" target="_blank" rel="noopener" title="Download this game's ledger — winners green, losers red">⬇ Ledger</a></td>
            </tr>`
          )
          .join('')}</tbody>
      </table>
      <p class="empty-note">Every game's ledger is saved here as a dated spreadsheet, winners in green and losers in red — nothing is lost if a screenshot isn't taken.</p>`;
  }

  const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
  document.getElementById('stats-block').innerHTML = `
    <div class="stat-row">
      <div class="stat-tile"><span class="stat-label">VPIP</span>
        <span class="stat-value">${pct(stats.vpipHands, stats.handsDealt)}</span></div>
      <div class="stat-tile"><span class="stat-label">PFR</span>
        <span class="stat-value">${pct(stats.pfrHands, stats.handsDealt)}</span></div>
      <div class="stat-tile"><span class="stat-label">3-bet</span>
        <span class="stat-value">${pct(stats.threeBetHands, stats.threeBetOps)}</span></div>
      <div class="stat-tile"><span class="stat-label">Went to showdown</span>
        <span class="stat-value">${pct(stats.wtsdHands, stats.sawFlopHands)}</span></div>
      <div class="stat-tile"><span class="stat-label">Won at showdown</span>
        <span class="stat-value">${pct(stats.wsdHands, stats.wtsdHands)}</span></div>
      <div class="stat-tile"><span class="stat-label">Aggression</span>
        <span class="stat-value">${
          stats.passiveActions > 0
            ? (stats.aggressiveActions / stats.passiveActions).toFixed(2)
            : '—'
        }</span></div>
      <div class="stat-tile"><span class="stat-label">Hands won</span>
        <span class="stat-value">${stats.handsWon || 0}</span></div>
      <div class="stat-tile"><span class="stat-label">Biggest pot</span>
        <span class="stat-value">${stats.biggestPot || 0}</span></div>
    </div>
    <div class="best-hand">
      <span class="stat-label">Best hand ever made</span>
      <strong>${stats.bestHandDesc ? escapeHtml(stats.bestHandDesc) : 'Nothing yet — go make one'}</strong>
      <span class="hint">Counts every hand you made, even the ones nobody got to see.</span>
    </div>`;
}

// ---- the running tab across nights ----
//
// A tab belongs to a host, not to a player: somebody who plays at two homes
// has two of them and they never mix. So this asks whose tab first, then shows
// that host's totals and lets money be marked off against them.

let ledgerHosts = [];
let ledgerHostId = null;
let running = null;
let myAccountId = null;

async function loadLedgers() {
  const block = document.getElementById('running-block');
  const picker = document.getElementById('ledger-picker');
  if (!block) return;
  block.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const res = await fetch('/api/me/ledgers', { headers: authHeaders() });
    if (!res.ok) throw new Error();
    const data = await res.json();
    ledgerHosts = data.ledgers || [];
    myAccountId = data.accountId;
  } catch {
    block.innerHTML = '<p class="empty-note">Could not load your running totals.</p>';
    return;
  }

  if (!ledgerHosts.length) {
    picker?.classList.add('hidden');
    block.innerHTML = `<p class="empty-note">Nothing yet — a running total starts once a
      night has finished. It follows signed-in players from one night to the next.</p>`;
    return;
  }

  // One tab needs no choosing; two do, and the choice has to say whose.
  picker?.classList.toggle('hidden', ledgerHosts.length < 2);
  const select = document.getElementById('ledger-host');
  if (select) {
    select.innerHTML = ledgerHosts
      .map((l) => `<option value="${l.hostId}">${escapeHtml(
        l.hosted ? 'Your tables' : `${l.hostName}'s tables`
      )}</option>`)
      .join('');
    select.onchange = () => loadRunning(Number(select.value));
  }
  loadRunning(ledgerHosts[0].hostId);
}

async function loadRunning(hostId) {
  const block = document.getElementById('running-block');
  if (!block) return;
  ledgerHostId = hostId;
  block.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const res = await fetch(`/api/me/ledgers/${hostId}/running`, { headers: authHeaders() });
    if (!res.ok) throw new Error();
    ({ running } = await res.json());
  } catch {
    block.innerHTML = '<p class="empty-note">Could not load that running total.</p>';
    return;
  }
  renderRunning();
}

function renderRunning() {
  const block = document.getElementById('running-block');
  if (!block || !running) return;
  const host = ledgerHosts.find((l) => l.hostId === ledgerHostId);
  const amHost = !!host?.hosted;
  const label = payeeLabeller(running.players);
  const name = (id) => label(`acct:${id}`, 'Someone');
  const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;

  if (!running.players.length) {
    block.innerHTML = '<p class="empty-note">No finished nights on this tab yet.</p>';
    return;
  }

  const nights = `${running.nights} night${running.nights === 1 ? '' : 's'}`;
  const options = running.players
    .map((p) => `<option value="${p.accountId}">${escapeHtml(name(p.accountId))}</option>`)
    .join('');

  block.innerHTML = `
    <p class="section-note">Across ${nights}${amHost ? '' : ` at ${escapeHtml(host?.hostName || 'their')}'s tables`}.
      Signed-in players only — nothing follows a guest from one night to the next, so
      they settle inside each night's own ledger and these totals need not add up to zero.</p>
    <div class="ledger-scroll"><table class="ledger">
      <thead><tr><th>Player</th><th>Nights</th><th>Won / lost</th><th>Paid off</th><th>Outstanding</th></tr></thead>
      <tbody>${running.players.map((p) => `<tr>
        <td>${escapeHtml(name(p.accountId))}${p.accountId === myAccountId ? ' <span class="fine">(you)</span>' : ''}</td>
        <td>${p.sessions}</td>
        <td class="${p.net >= 0 ? 'pos' : 'neg'}">${signed(p.net)}</td>
        <td>${p.paid || p.received ? escapeHtml(paidCell(p)) : '—'}</td>
        <td class="${p.outstanding >= 0 ? 'pos' : 'neg'}">${signed(p.outstanding)}</td>
      </tr>`).join('')}</tbody>
    </table></div>

    <div class="settle-block">
      <h4>Still to settle</h4>
      ${running.settle.length
        ? `<ul class="settle-list">${running.settle.map((s) => `<li>
            <span><strong>${escapeHtml(s.from)}</strong> pays
              <strong>${escapeHtml(s.to)}</strong>
              <span class="settle-amt">${s.amount}</span></span>
            ${canRecord(idOf(s.fromId), idOf(s.toId))
              ? `<button class="btn btn-ghost pay-mark" data-from="${idOf(s.fromId)}"
                   data-to="${idOf(s.toId)}" data-amount="${s.amount}">Mark paid</button>`
              : ''}
          </li>`).join('')}</ul>`
        : '<p class="empty-note">Everyone is square across every night.</p>'}
    </div>

    <div class="pay-record">
      <h4>Mark a payment off</h4>
      <div class="pay-row">
        <div class="field"><label for="sp-from">Who paid</label>
          <select id="sp-from">${options}</select></div>
        <div class="field"><label for="sp-to">Who they paid</label>
          <select id="sp-to">${options}</select></div>
        <div class="field"><label for="sp-amount">Amount</label>
          <input id="sp-amount" type="number" min="1" step="1" inputmode="numeric"></div>
        <div class="field"><label for="sp-note">Note</label>
          <input id="sp-note" maxlength="120" placeholder="Venmo, cash…"></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="sp-save">Mark paid</button>
      </div>
      <p class="hint">You can mark off money you paid or were paid — the two people
        in a payment are the ones who know it happened, so a debt between two other
        players is theirs to record${amHost ? ', even on a tab you host' : ''}.
        Part payments are fine — mark off what actually changed hands.</p>
    </div>

    <div class="paid-block">
      <h4>Already paid</h4>
      ${running.payments.length
        ? `<ul class="settle-list">${running.payments.map((p) => `<li>
            <span><strong>${escapeHtml(name(p.fromAccountId))}</strong> paid
              <strong>${escapeHtml(name(p.toAccountId))}</strong>
              <span class="settle-amt">${p.amount}</span>
              <span class="fine">${escapeHtml(new Date(p.createdAt).toLocaleDateString())}${
                p.note ? ` · ${escapeHtml(p.note)}` : ''}</span></span>
            ${canRecord(p.fromAccountId, p.toAccountId)
              ? `<button class="btn btn-ghost pay-undo" data-id="${p.id}">Undo</button>`
              : ''}
          </li>`).join('')}</ul>`
        : '<p class="empty-note">Nothing marked off yet.</p>'}
    </div>`;

  wireRunning();
}

// settleUp carries the account id as `acct:<id>`, so it can key on something
// unique — two people can put the same name on a ledger.
function idOf(playerId) {
  return Number(String(playerId || '').replace('acct:', ''));
}

function paidCell(p) {
  const parts = [];
  if (p.paid) parts.push(`paid ${p.paid}`);
  if (p.received) parts.push(`got ${p.received}`);
  return parts.join(', ');
}

// The same rule the server enforces, applied here so nobody is told no only
// after they have filled the form in. Hosting the tab is deliberately not
// enough: the host is not a witness to a payment between two other players.
function canRecord(from, to) {
  return from === myAccountId || to === myAccountId;
}

function wireRunning() {
  const block = document.getElementById('running-block');
  const from = document.getElementById('sp-from');
  const to = document.getElementById('sp-to');
  const amount = document.getElementById('sp-amount');
  const note = document.getElementById('sp-note');

  // Default to the payment this player is most likely recording: the one they
  // owe, or failing that the one owed to them.
  const mine = running.settle.find((s) => idOf(s.fromId) === myAccountId)
    || running.settle.find((s) => idOf(s.toId) === myAccountId)
    || running.settle[0];
  if (mine && from && to) {
    from.value = String(idOf(mine.fromId));
    to.value = String(idOf(mine.toId));
    amount.value = String(mine.amount);
  }

  for (const btn of block.querySelectorAll('.pay-mark')) {
    btn.addEventListener('click', () => {
      from.value = btn.dataset.from;
      to.value = btn.dataset.to;
      amount.value = btn.dataset.amount;
      amount.focus();
      amount.select();
    });
  }

  for (const btn of block.querySelectorAll('.pay-undo')) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/me/settle-payments/${btn.dataset.id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        running = data.running;
        renderRunning();
        showToast('Payment removed', { ok: true });
      } catch (err) {
        btn.disabled = false;
        showToast(err.message || 'Could not remove that payment');
      }
    });
  }

  document.getElementById('sp-save')?.addEventListener('click', async () => {
    const fromId = Number(from.value);
    const toId = Number(to.value);
    const value = Number(amount.value);
    if (fromId === toId) {
      showToast('A payment needs two different people');
      return;
    }
    if (!Number.isInteger(value) || value <= 0) {
      showToast('Enter an amount above zero');
      return;
    }
    if (!canRecord(fromId, toId)) {
      showToast('You can only mark off money you paid or were paid');
      return;
    }
    try {
      const res = await fetch(`/api/me/ledgers/${ledgerHostId}/payments`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          fromAccountId: fromId, toAccountId: toId, amount: value, note: note.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      running = data.running;
      renderRunning();
      showToast('Marked paid', { ok: true });
    } catch (err) {
      showToast(err.message || 'Could not mark that paid');
    }
  });
}

// ---- invite list and Discord ----

async function loadNotify() {
  try {
    const res = await fetch('/api/me/notify', { headers: authHeaders() });
    if (!res.ok) return;
    renderNotify(await res.json());
  } catch {
    /* the rest of the page still works */
  }
}

function renderNotify({ contacts, targets, emailConfigured, recent }) {
  document.getElementById('email-status').textContent = emailConfigured
    ? 'Everyone here gets a link whenever you start a table.'
    : 'Email sending is not configured on this server, so invites are logged rather than delivered. Set SMTP_URL to turn it on — your list is saved either way.';

  document.getElementById('contact-list').innerHTML = contacts.length
    ? contacts
        .map(
          (c) => `
      <div class="list-row">
        <span class="list-main">${escapeHtml(c.label || c.email)}
          ${c.label ? `<span class="list-sub">${escapeHtml(c.email)}</span>` : ''}</span>
        <label class="toggle">
          <input type="checkbox" data-contact="${c.id}" ${c.autoSend ? 'checked' : ''}>
          <span>Auto-invite</span>
        </label>
        <button class="btn btn-ghost row-remove" data-remove-contact="${c.id}">Remove</button>
      </div>`
        )
        .join('')
    : '<p class="empty-note">No one on your list yet.</p>';

  document.getElementById('target-list').innerHTML = targets.length
    ? targets
        .map(
          (t) => `
      <div class="list-row">
        <span class="list-main">${escapeHtml(t.label || 'Discord')}
          <span class="list-sub">${escapeHtml(t.value)}</span></span>
        <button class="btn btn-ghost row-remove" data-remove-target="${t.id}">Disconnect</button>
      </div>`
        )
        .join('')
    : '<p class="empty-note">No Discord channel connected.</p>';

  if (recent?.length) {
    document.getElementById('target-list').insertAdjacentHTML(
      'beforeend',
      `<details class="delivery-log"><summary>Recent invites (${recent.length})</summary>
        ${recent
          .map(
            (r) =>
              `<div class="log-line"><span class="log-no">${escapeHtml(r.status)}</span> ${escapeHtml(r.channel)} → ${escapeHtml(r.target)}</div>`
          )
          .join('')}
      </details>`
    );
  }

  document.querySelectorAll('[data-contact]').forEach((box) => {
    box.addEventListener('change', async () => {
      const res = await fetch(`/api/me/contacts/${box.dataset.contact}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ autoSend: box.checked }),
      });
      if (res.ok) loadNotify();
    });
  });
  document.querySelectorAll('[data-remove-contact]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/me/contacts/${btn.dataset.removeContact}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      loadNotify();
    });
  });
  document.querySelectorAll('[data-remove-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/me/targets/${btn.dataset.removeTarget}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      loadNotify();
    });
  });
}

document.getElementById('n-add').addEventListener('click', async () => {
  const email = document.getElementById('n-email').value.trim();
  const label = document.getElementById('n-label').value.trim();
  if (!email) return;
  const res = await fetch('/api/me/contacts', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email, label }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Could not add that address');
    return;
  }
  document.getElementById('n-email').value = '';
  document.getElementById('n-label').value = '';
  loadNotify();
});

document.getElementById('n-add-webhook').addEventListener('click', async () => {
  const value = document.getElementById('n-webhook').value.trim();
  if (!value) return;
  const res = await fetch('/api/me/targets', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kind: 'discord_webhook', value, label: 'Discord' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Could not connect that webhook');
    return;
  }
  document.getElementById('n-webhook').value = '';
  showToast('Discord connected');
  loadNotify();
});

// ---- table look ----

const SOUND_SLOTS = [
  { key: 'cooler', label: 'Cooler', hint: 'A big hand runs into a bigger one' },
  { key: 'badBeat', label: 'Bad beat', hint: 'A heavy favourite gets there anyway' },
  { key: 'quads', label: 'Quads or better', hint: 'Monster hands shown down' },
  { key: 'win', label: 'You win a pot', hint: 'Your own victory sound' },
  { key: 'bust', label: 'You bust', hint: 'When your stack hits zero' },
  { key: 'yourTurn', label: 'Your turn', hint: 'Replaces the default chime' },
];

let theme = { feltImage: null, feltColor: '#1f6b43', railColor: '#3b2a1e' };

function applyPreview() {
  const preview = document.getElementById('theme-preview');
  preview.style.backgroundImage = theme.feltImage ? `url("${theme.feltImage}")` : '';
  preview.style.backgroundSize = 'cover';
  preview.style.backgroundPosition = 'center';
  preview.style.backgroundColor = theme.feltColor || '';
  preview.style.borderColor = theme.railColor || '';
}

async function uploadFile(file, url) {
  const buffer = await file.arrayBuffer();
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Upload failed' };
  return { ok: true, data };
}

// ---- profile picture ----

function renderAvatar(url) {
  const img = document.getElementById('avatar-preview');
  const empty = document.getElementById('avatar-empty');
  if (!img || !empty) return;
  img.src = url || '';
  img.classList.toggle('hidden', !url);
  empty.classList.toggle('hidden', !!url);
}

async function saveAvatar(url) {
  const res = await fetch('/api/me/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    showToast('Could not save the picture');
    return;
  }
  renderAvatar(url);
  showToast(url ? 'Profile picture saved' : 'Profile picture removed', { ok: true });
}

document.getElementById('a-image')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const result = await uploadFile(file, '/api/uploads?kind=image');
  if (!result.ok) {
    showToast(result.error);
    return;
  }
  await saveAvatar(result.data.upload.url);
});

document.getElementById('a-clear')?.addEventListener('click', () => saveAvatar(null));

document.getElementById('t-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const result = await uploadFile(file, '/api/uploads?kind=image');
  if (!result.ok) {
    showToast(result.error);
    return;
  }
  theme.feltImage = result.data.upload.url;
  applyPreview();
  showToast('Image uploaded — save to apply it');
});

document.getElementById('t-felt').addEventListener('input', (e) => {
  theme.feltColor = e.target.value;
  applyPreview();
});
document.getElementById('t-rail').addEventListener('input', (e) => {
  theme.railColor = e.target.value;
  applyPreview();
});

document.getElementById('t-save').addEventListener('click', async () => {
  const res = await fetch('/api/me/theme', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: 'My table', ...theme, makeDefault: true }),
  });
  showToast(res.ok ? 'Saved — your next table will use it' : 'Could not save');
});

document.getElementById('t-clear').addEventListener('click', () => {
  theme = { feltImage: null, feltColor: '#1f6b43', railColor: '#3b2a1e' };
  document.getElementById('t-felt').value = theme.feltColor;
  document.getElementById('t-rail').value = theme.railColor;
  document.getElementById('t-image').value = '';
  applyPreview();
});

function renderSoundSlots(clips) {
  document.getElementById('sound-slots').innerHTML = SOUND_SLOTS.map(
    (slot) => `
    <div class="sound-slot">
      <div class="sound-meta">
        <strong>${slot.label}</strong>
        <span>${clips[slot.key] ? escapeHtml(clips[slot.key].name || 'custom clip') : slot.hint}</span>
      </div>
      <div class="sound-actions">
        <label class="btn btn-ghost sound-upload">
          ${clips[slot.key] ? 'Replace' : 'Upload'}
          <input type="file" accept=".mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav" data-slot="${slot.key}" hidden>
        </label>
        ${clips[slot.key] ? `<button class="btn btn-ghost sound-clear" data-clear="${slot.key}">Remove</button>` : ''}
      </div>
    </div>`
  ).join('');

  document.querySelectorAll('#sound-slots input[type="file"]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const result = await uploadFile(file, `/api/me/sounds/${input.dataset.slot}`);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      renderSoundSlots(result.data.clips);
      showToast('Sound saved');
    });
  });

  document.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/me/sounds/${btn.dataset.clear}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.ok) renderSoundSlots((await res.json()).clips);
    });
  });
}

async function loadTheme() {
  try {
    const res = await fetch('/api/me/theme', { headers: authHeaders() });
    if (!res.ok) return;
    const { themes, sounds } = await res.json();
    const preferred = themes.find((t) => t.isDefault) || themes[0];
    if (preferred) {
      theme = {
        feltImage: preferred.feltImage,
        feltColor: preferred.feltColor || '#1f6b43',
        railColor: preferred.railColor || '#3b2a1e',
      };
      document.getElementById('t-felt').value = theme.feltColor;
      document.getElementById('t-rail').value = theme.railColor;
    }
    applyPreview();
    renderSoundSlots(sounds || {});
  } catch {
    /* the rest of the page still works */
  }
}

loadAccount().then(() => {
  render();
  if (currentAccount()) {
    loadSummary();
    loadTheme();
    loadNotify();
    loadLedgers();
  }
});
