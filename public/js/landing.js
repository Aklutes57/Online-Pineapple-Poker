import { loadAccount, currentAccount, signout, authHeaders } from '/js/auth.js';
import { openAuthModal } from '/js/authModal.js';
import { wireInstallButton } from '/js/pwa.js';

wireInstallButton(document.getElementById('install-btn'));

const modal = document.getElementById('create-modal');
const toast = document.getElementById('toast');

document.getElementById('start-btn').addEventListener('click', () => {
  modal.classList.remove('hidden');
  const nickInput = document.getElementById('c-nickname');
  const account = currentAccount();
  if (account && !nickInput.value) nickInput.value = account.displayName;
  nickInput.focus();
});

// ---- account chip in the header (optional — guests see a Sign in button) ----

function renderAccountSlot() {
  const slot = document.getElementById('account-slot');
  const account = currentAccount();
  if (!account) {
    slot.innerHTML = '<button class="btn btn-ghost nav-btn" id="signin-btn">Sign in</button>';
    document.getElementById('signin-btn').addEventListener('click', () =>
      openAuthModal({ onSuccess: renderAccountSlot })
    );
    return;
  }
  slot.innerHTML = `
    <a class="nav-account" href="/me">${escapeHtml(account.displayName)}</a>
    <button class="btn btn-ghost nav-btn" id="signout-btn">Sign out</button>`;
  document.getElementById('signout-btn').addEventListener('click', async () => {
    await signout();
    renderAccountSlot();
    showToast('Signed out');
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

loadAccount().then(renderAccountSlot);

document.getElementById('c-cancel').addEventListener('click', () => {
  modal.classList.add('hidden');
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.add('hidden');
});

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

if (new URLSearchParams(location.search).get('error') === 'notfound') {
  showToast('That table no longer exists');
  history.replaceState(null, '', '/');
}

document.getElementById('c-create').addEventListener('click', createGame);
document.getElementById('c-nickname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createGame();
});
document.getElementById('c-72').addEventListener('change', (e) => {
  document.getElementById('c-72-amount').disabled = !e.target.checked;
});

// 747's ante and penalty cap only exist on a 747 table, so the create pop-up
// reveals them the moment you pick the game.
function sync747Fields() {
  const on = document.getElementById('c-variant').value === '747';
  document.getElementById('c-747-row').classList.toggle('hidden', !on);
  document.getElementById('c-747-note').classList.toggle('hidden', !on);
}
document.getElementById('c-variant').addEventListener('change', sync747Fields);
sync747Fields();

// Cash game is the default; picking a tournament reveals its clock settings.
function syncFormatFields() {
  const on = document.getElementById('c-format').value === 'tournament';
  document.getElementById('c-tourney-row').classList.toggle('hidden', !on);
  document.getElementById('c-tourney-note').classList.toggle('hidden', !on);
}
document.getElementById('c-format').addEventListener('change', syncFormatFields);
syncFormatFields();

async function createGame() {
  const nickname = document.getElementById('c-nickname').value.trim();
  if (!nickname) {
    showToast('Pick a nickname first');
    return;
  }
  const smallBlind = parseInt(document.getElementById('c-sb').value, 10) || 1;
  const bigBlind = parseInt(document.getElementById('c-bb').value, 10) || smallBlind * 2;
  const defaultBuyIn = parseInt(document.getElementById('c-buyin').value, 10) || bigBlind * 100;
  const settings = {
    variant: document.getElementById('c-variant').value,
    smallBlind,
    bigBlind,
    defaultBuyIn,
    minBuyIn: Math.max(1, Math.floor(defaultBuyIn / 5)),
    maxBuyIn: defaultBuyIn * 5,
    actionTime: parseInt(document.getElementById('c-timer').value, 10),
    sevenDeuceBounty: document.getElementById('c-72').checked
      ? parseInt(document.getElementById('c-72-amount').value, 10) || 0
      : 0,
    tournament: document.getElementById('c-format').value === 'tournament',
    levelMinutes: parseInt(document.getElementById('c-level').value, 10) || 15,
    rebuyMinutes: Math.max(0, parseInt(document.getElementById('c-rebuy').value, 10) || 0),
    ante747: parseInt(document.getElementById('c-747-ante').value, 10) || 0,
    penaltyCap747: Math.max(0, parseInt(document.getElementById('c-747-cap').value, 10) || 0),
  };
  const btn = document.getElementById('c-create');
  btn.disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ nickname, settings }),
    });
    if (!res.ok) throw new Error('create failed');
    const { gameId, token } = await res.json();
    localStorage.setItem(`pp:${gameId}`, JSON.stringify({ token, nickname }));
    location.href = `/games/${gameId}`;
  } catch {
    showToast('Could not create the table — try again');
    btn.disabled = false;
  }
}
