// Pure-DOM playing cards: Unicode suits + CSS, no image assets.

const SUIT_GLYPHS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);

// code like 'As', 'Td'. Returns a .card element. Each card carries a
// per-suit class so the four-color deck can restyle diamonds and clubs.
export function makeCardEl(code, opts = {}) {
  const el = document.createElement('div');
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  el.className = `card suit-${suit}` + (RED_SUITS.has(suit) ? ' red' : '');
  el.dataset.card = code;
  el.innerHTML = `<span class="rank">${rank}</span><span class="suit">${SUIT_GLYPHS[suit]}</span>`;
  if (opts.discardable) el.classList.add('discardable');
  if (opts.dealt) el.classList.add('dealt');
  return el;
}

export function makeCardBack() {
  const el = document.createElement('div');
  el.className = 'card back';
  return el;
}
