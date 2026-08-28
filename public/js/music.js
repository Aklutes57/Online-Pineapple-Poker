// The table's music.
//
// The server holds a queue and a clock — what is playing, and how long it has
// been playing — and nothing else. No audio passes through it. Every browser
// runs the official YouTube IFrame Player API against that clock and seeks
// itself to the same place, which is the only sanctioned way to play YouTube
// in a page and the reason volume and mute are per-device: they are properties
// of your speakers, not of the table.
//
// Drift is expected and tolerated. Nobody is mixing tracks here — everyone is
// listening to roughly the same second of the same song, and a correction only
// fires when a player has slipped far enough to notice.

import { EVENTS } from '/shared/constants.js';
import { escapeHtml } from '/js/ui.js';

const VOLUME_KEY = 'pp-music-volume';
const DEFAULT_VOLUME = 55;
const RESYNC_AFTER = 3; // seconds of drift before we pull the player back

let client = null;
let player = null;
let apiReady = false;
let playerReady = false;
// The track the local player is actually loaded with, so a state update that
// changes nothing does not restart the song under everybody.
let loadedKey = '';
// Browsers refuse to start audio until the page has been interacted with. When
// that happens we stop trying and offer a button instead of failing silently.
let needsGesture = false;

const muteKey = () => `pp-music-muted:${client?.gameId ?? 'table'}`;

function storedVolume() {
  const raw = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : DEFAULT_VOLUME;
}

function isMuted() {
  try {
    return localStorage.getItem(muteKey()) === '1';
  } catch {
    return false; // private mode: default to hearing it
  }
}

function setMuted(on) {
  try {
    localStorage.setItem(muteKey(), on ? '1' : '0');
  } catch { /* nothing we can do, and not worth breaking the table over */ }
  applyOutput();
  render();
}

// Volume and mute are the two things that never touch the server.
function applyOutput() {
  if (!playerReady) return;
  try {
    if (isMuted()) player.mute();
    else player.unMute();
    player.setVolume(storedVolume());
  } catch { /* the iframe can be mid-teardown */ }
}

// ---- the YouTube player ----

// The API calls this global when it has loaded. Named exactly as YouTube
// expects; there is no other hook.
window.onYouTubeIframeAPIReady = () => {
  apiReady = true;
  createPlayer();
};

function loadApi() {
  if (document.getElementById('yt-api')) return;
  const tag = document.createElement('script');
  tag.id = 'yt-api';
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function createPlayer() {
  if (player || !apiReady || !window.YT?.Player) return;
  const mount = document.getElementById('music-player');
  if (!mount) return;
  player = new window.YT.Player(mount, {
    height: '1',
    width: '1',
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      // Never let YouTube queue up "related" videos after ours.
      rel: 0,
      playsinline: 1,
    },
    events: {
      onReady: () => {
        playerReady = true;
        applyOutput();
        sync();
      },
      onStateChange: (e) => {
        // Whoever gets there first tells the server; the rest are ignored
        // because their index will no longer match.
        if (e.data === window.YT.PlayerState.ENDED) {
          client?.send(EVENTS.MUSIC_ENDED, { index: client.state?.music?.index ?? -1 });
        }
      },
      onError: () => {
        // A video that will not embed (age-gated, region-locked, deleted)
        // must not wedge the queue for the whole table.
        client?.send(EVENTS.MUSIC_ENDED, { index: client.state?.music?.index ?? -1 });
      },
    },
  });
}

// ---- keeping in step with the table ----

function nowPlaying() {
  const m = client?.state?.music;
  if (!m) return null;
  return m.queue?.[m.index] || null;
}

// Where the table is in the current track, in seconds.
function tableOffset() {
  const m = client?.state?.music;
  if (!m) return 0;
  if (m.startedAgo === null || m.startedAgo === undefined) return m.pausedAt || 0;
  // startedAgo was measured when the state was built; add what has passed on
  // this machine since it arrived. Both are durations, so a wrong wall clock
  // cannot throw this off.
  return (m.startedAgo + (Date.now() - (client.state.receivedAt || Date.now()))) / 1000;
}

export function sync() {
  if (!playerReady) return;
  const m = client?.state?.music;
  const track = nowPlaying();
  if (!track) {
    try { player.stopVideo(); } catch { /* already gone */ }
    loadedKey = '';
    return;
  }
  const key = `${m.index}:${track.id}`;
  const offset = Math.max(0, tableOffset());
  try {
    if (key !== loadedKey) {
      loadedKey = key;
      player.loadVideoById({ videoId: track.id, startSeconds: offset });
      applyOutput();
    } else if (!m.paused) {
      // Same track: only pull it back when it has slipped enough to hear.
      const at = player.getCurrentTime?.() ?? 0;
      if (Math.abs(at - offset) > RESYNC_AFTER) player.seekTo(offset, true);
    }
    if (m.paused) player.pauseVideo();
    else {
      const promise = player.playVideo();
      // Older embeds return nothing; newer ones hand back a promise that
      // rejects when autoplay is blocked.
      if (promise?.catch) promise.catch(() => { needsGesture = true; render(); });
    }
  } catch { /* the iframe is not ready for this call yet; the next state fixes it */ }
}

// ---- the panel ----

function render() {
  const body = document.getElementById('tab-music');
  if (!body || body.classList.contains('hidden')) return;
  const m = client?.state?.music;
  const track = nowPlaying();
  const nowEl = document.getElementById('music-now');
  if (nowEl) {
    nowEl.innerHTML = track
      ? `<img class="music-thumb" src="https://i.ytimg.com/vi/${encodeURIComponent(track.id)}/default.jpg" alt="">
         <span class="music-meta">
           <span class="music-title">${escapeHtml(track.title || 'Queued track')}</span>
           <span class="music-by">added by ${escapeHtml(track.addedBy || 'someone')}</span>
         </span>`
      : '<span class="music-idle">Nothing playing. Paste a YouTube link below.</span>';
  }

  const playBtn = document.getElementById('music-play');
  if (playBtn) {
    playBtn.textContent = m?.paused ? 'Play' : 'Pause';
    playBtn.disabled = !track;
  }
  const skipBtn = document.getElementById('music-skip');
  if (skipBtn) skipBtn.disabled = !track;

  const muteBtn = document.getElementById('music-mute');
  if (muteBtn) {
    muteBtn.textContent = isMuted() ? 'Unmute' : 'Mute';
    muteBtn.classList.toggle('on', isMuted());
  }
  const vol = document.getElementById('music-volume');
  if (vol && document.activeElement !== vol) vol.value = String(storedVolume());

  const note = document.getElementById('music-note');
  if (note) {
    note.textContent = needsGesture
      ? 'Your browser blocked the sound — tap Play to start it.'
      : isMuted()
        ? 'Muted on this device only. Everyone else still hears it.'
        : 'Volume and mute are yours alone — they change nothing for anyone else.';
  }

  const queue = document.getElementById('music-queue');
  if (queue) {
    const upcoming = (m?.queue || []).slice((m?.index ?? 0) + 1);
    queue.innerHTML = upcoming.length
      ? upcoming
        .map((t) => `<div class="music-row">
            <span class="music-title">${escapeHtml(t.title || t.id)}</span>
            <span class="music-by">${escapeHtml(t.addedBy || '')}</span>
          </div>`)
        .join('')
      : '<div class="music-row music-idle">Nothing queued after this.</div>';
  }

  const clearBtn = document.getElementById('music-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !client?.you?.isHost);
}

export function initMusic(c) {
  client = c;
  loadApi();

  const mount = document.createElement('div');
  mount.id = 'music-player';
  mount.className = 'music-player-mount';
  document.body.appendChild(mount);
  createPlayer();

  document.getElementById('music-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('music-input');
    const url = input.value.trim();
    if (!url) return;
    client.send(EVENTS.MUSIC_ADD, { url });
    input.value = '';
  });
  document.getElementById('music-skip')?.addEventListener('click', () => {
    client.send(EVENTS.MUSIC_SKIP, {});
  });
  document.getElementById('music-play')?.addEventListener('click', () => {
    // A tap is the gesture the browser was holding out for, so this doubles
    // as the way out of blocked autoplay.
    needsGesture = false;
    client.send(EVENTS.MUSIC_PAUSE, { paused: !client.state?.music?.paused });
  });
  document.getElementById('music-mute')?.addEventListener('click', () => setMuted(!isMuted()));
  document.getElementById('music-volume')?.addEventListener('input', (e) => {
    try { localStorage.setItem(VOLUME_KEY, String(e.target.value)); } catch { /* ignore */ }
    applyOutput();
  });
  document.getElementById('music-clear')?.addEventListener('click', () => {
    if (confirm('Clear the whole music queue for the table?')) client.send(EVENTS.MUSIC_CLEAR, {});
  });
  // Opening the tab should paint it, not wait for the next state update.
  document.querySelector('.tab[data-tab="music"]')?.addEventListener('click', render);
}

export function onMusicState() {
  sync();
  render();
}
