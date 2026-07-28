// Profile page: all-time ledger, poker stats, account settings.
// Phase 1 renders identity + settings; the ledger and stat blocks fill in
// from /api/me/summary once results are being recorded.

import { loadAccount, currentAccount, signout, updateAccount, authHeaders } from '/js/auth.js';
import { openAuthModal } from '/js/authModal.js';
import { showToast, escapeHtml } from '/js/ui.js';

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
}

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
        <thead><tr><th>When</th><th>Game</th><th>Blinds</th><th>Buy-ins</th><th>Out</th><th>Net</th></tr></thead>
        <tbody>${sessions
          .map(
            (s) => `<tr>
              <td>${new Date(s.startedAt).toLocaleDateString()}</td>
              <td>${escapeHtml(s.variant)}</td>
              <td>${s.smallBlind}/${s.bigBlind}</td>
              <td>${s.buyIns}</td>
              <td>${s.cashOuts + s.finalStack}</td>
              <td class="${s.net >= 0 ? 'pos' : 'neg'}">${s.net >= 0 ? '+' : ''}${s.net}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>`;
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
    </div>
    ${stats.bestHandDesc ? `<p class="empty-note">Best hand shown down: ${escapeHtml(stats.bestHandDesc)}</p>` : ''}`;
}

loadAccount().then(() => {
  render();
  if (currentAccount()) loadSummary();
});
