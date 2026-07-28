const modal = document.getElementById('create-modal');
const toast = document.getElementById('toast');

document.getElementById('start-btn').addEventListener('click', () => {
  modal.classList.remove('hidden');
  document.getElementById('c-nickname').focus();
});

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
  };
  const btn = document.getElementById('c-create');
  btn.disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
