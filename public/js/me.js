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
          <input type="file" accept="audio/mpeg,audio/ogg,audio/wav" data-slot="${slot.key}" hidden>
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
  }
});
