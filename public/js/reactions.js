// Emoji reactions: a picker in the top bar, and emoji that float up from the
// reacting player's seat (or the table edge for spectators).

import { EVENTS, REACTIONS, SEAT_COUNT, SEAT_COORDS } from '/shared/constants.js';

let clientRef = null;
let pickerOpen = false;

export function initReactions(client) {
  clientRef = client;

  const btn = document.getElementById('react-btn');
  const picker = document.getElementById('react-picker');
  picker.innerHTML = REACTIONS.map(
    (emoji) => `<button class="react-option" data-emoji="${emoji}">${emoji}</button>`
  ).join('');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pickerOpen = !pickerOpen;
    picker.classList.toggle('hidden', !pickerOpen);
  });

  picker.addEventListener('click', (e) => {
    const option = e.target.closest('[data-emoji]');
    if (!option) return;
    client.send(EVENTS.REACT, { emoji: option.dataset.emoji });
    pickerOpen = false;
    picker.classList.add('hidden');
  });

  document.addEventListener('click', () => {
    if (!pickerOpen) return;
    pickerOpen = false;
    picker.classList.add('hidden');
  });
}

// Where a reaction should launch from, in the same rotated frame the seats
// use so it appears over the right player for every viewer.
function launchPoint(seatIndex) {
  if (seatIndex === null || seatIndex === undefined) return { left: 50, top: 88 };
  const mySeat = clientRef.you?.seatIndex ?? 0;
  const slot = (seatIndex - mySeat + SEAT_COUNT) % SEAT_COUNT;
  return SEAT_COORDS[slot];
}

export function showReaction({ emoji, seatIndex, from }) {
  const layer = document.getElementById('reactions-layer');
  if (!layer) return;
  const point = launchPoint(seatIndex);

  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.style.left = point.left + '%';
  el.style.top = point.top + '%';
  // A little horizontal scatter so simultaneous reactions don't overlap.
  el.style.setProperty('--drift', `${Math.round(Math.random() * 40 - 20)}px`);
  el.innerHTML = `<span class="fr-emoji">${emoji}</span><span class="fr-name">${escapeText(from)}</span>`;
  layer.appendChild(el);

  el.addEventListener('animationend', () => el.remove());
  // Belt and braces in case the animation event never fires.
  setTimeout(() => el.remove(), 3000);
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
