import { loadAccount, currentAccount, signout, authHeaders } from '/js/auth.js';
import { openAuthModal } from '/js/authModal.js';
import { wireInstallButton } from '/js/pwa.js';
import { VARIANTS } from '/shared/constants.js';

wireInstallButton(document.getElementById('install-btn'));

// ---- your recent tables ----
// Joining a table saves a rejoin token at pp:<gameId>; that IS the list of
// tables this device has sat at. Losing the invite link therefore never
// loses the game — or its server-saved ledger.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderRecentTables() {
  const rows = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('pp:')) continue;
      const id = key.slice(3);
      // Preference keys (pp:skin, pp:muted:…) never hold a rejoin token.
      if (!id || id.includes(':')) continue;
      let entry;
      try { entry = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!entry || typeof entry !== 'object' || !entry.token) continue;
      rows.push({ id, nickname: entry.nickname || 'Guest', ts: entry.ts || 0 });
    }
  } catch { return; /* private browsing */ }
  if (!rows.length) return;
  rows.sort((a, b) => b.ts - a.ts);

  const list = document.getElementById('recent-list');
  const section = document.getElementById('recent-tables');
  if (!list || !section) return;
  list.innerHTML = rows.slice(0, 12).map((r) => `
    <li class="recent-row">
      <span class="recent-who"><b>${esc(r.nickname)}</b> at table <code>${esc(r.id)}</code>${
        r.ts ? ` · ${new Date(r.ts).toLocaleDateString()}` : ''}</span>
      <span class="recent-links">
        <a class="btn btn-ghost nav-btn" href="/games/${encodeURIComponent(r.id)}">Open table</a>
        <a class="btn btn-ghost nav-btn" href="/api/games/${encodeURIComponent(r.id)}/ledger.xlsx">Ledger</a>
      </span>
    </li>`).join('');
  section.classList.remove('hidden');
}
renderRecentTables();

const modal = document.getElementById('create-modal');
const toast = document.getElementById('toast');

// Offer to pick up where the host's last table left off. Only shown when there
// IS one, and it says plainly who it covers — in a guest-heavy home game most
// of the table will not carry over, and finding that out at the seat would
// look like a bug rather than a rule.
async function offerCarryOver() {
  const row = document.getElementById('c-carry-row');
  const note = document.getElementById('c-carry-note');
  const label = document.getElementById('c-carry-label');
  if (!row || !currentAccount()) return;
  let last = null;
  try {
    const res = await fetch('/api/me/last-table', { headers: authHeaders() });
    if (res.ok) ({ lastTable: last } = await res.json());
  } catch {
    last = null; // offline, or not signed in any more — just don't offer it
  }
  if (!last || !last.players.length) return;
  const when = last.endedAt ? new Date(last.endedAt).toLocaleDateString() : 'last time';
  const n = last.players.length;
  label.textContent = `Continue from your table on ${when}`;
  note.textContent =
    `${n} signed-in player${n === 1 ? '' : 's'} would sit down with the stack they `
    + 'finished with. Everyone else — including guests — buys in normally, because a '
    + 'guest has no account to match them by between tables.';
  row.classList.remove('hidden');
}

document.getElementById('start-btn').addEventListener('click', () => {
  modal.classList.remove('hidden');
  offerCarryOver();
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
  sync72Note();
}

// The 7-2 bounty is a two-card joke, so it only pays in the two-card games.
// The control stays usable either way — a table can change game later — but it
// says plainly when the game you have picked is not one that pays it.
function sync72Note() {
  const key = document.getElementById('c-variant').value;
  const note = document.getElementById('c-72-note');
  if (!note) return;
  const pays = !!VARIANTS[key]?.sevenDeuce;
  note.textContent = pays
    ? "Paid in Hold'em and the Pineapples. Omaha, Draw and Stud deal more than "
      + 'two cards, so it does not apply there — bomb pots included.'
    : `${VARIANTS[key]?.label || 'This game'} does not pay the 7-2 bounty: it deals `
      + 'more than two cards, and 7-2 is the worst hand you can be dealt two. '
      + 'Leave it on and it will apply if the table changes game.';
  note.classList.toggle('warn', !pays);
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
      body: JSON.stringify({
        nickname,
        settings,
        carryStacks: document.getElementById('c-carry')?.checked === true,
      }),
    });
    if (!res.ok) throw new Error('create failed');
    const { gameId, token } = await res.json();
    localStorage.setItem(`pp:${gameId}`, JSON.stringify({ token, nickname, ts: Date.now() }));
    location.href = `/games/${gameId}`;
  } catch {
    showToast('Could not create the table — try again');
    btn.disabled = false;
  }
}
