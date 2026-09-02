// Table sounds.
//
// Every cue has a built-in patch synthesized live with WebAudio — there are
// no audio files in this project and nothing third-party is bundled. A host
// who wants a specific sound uploads their own clip on the profile page and
// maps it to a trigger; those play instead of the built-in patch.

let ctx = null;
let customClips = {};

function audio() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Browsers will not start audio until the page has been interacted with, and a
// context created outside a gesture is born suspended. Every cue here is
// triggered by a websocket update — never by a click — so resume() was always
// being called from the wrong place, always rejected, and the rejection was
// swallowed. The result was a table that made no sound at all, silently.
//
// So the context is opened on the first real gesture instead, which is the one
// moment a browser accepts it. Once running it stays running for the life of
// the page, and every later cue works because the unlocking already happened.
export function unlockAudio() {
  const ac = audio();
  if (!ac) return;
  if (ac.state === 'suspended') ac.resume().catch(() => {});
}

// Diagnostic: what the audio context is actually doing. Exported so the sound
// gate can assert on it — the failure this guards against is silent by nature,
// so the only way to test it is to look at the context itself.
export function audioState() {
  return ctx ? ctx.state : 'none';
}

export function armAudioUnlock() {
  const kick = () => unlockAudio();
  for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(evt, kick, { once: true, capture: true });
  }
}

export function setCustomClips(clips) {
  customClips = clips || {};
}

// A single shaped oscillator note.
function tone(ac, { freq, endFreq, start, duration, type = 'sine', gain = 0.09 }) {
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  const t0 = ac.currentTime + start;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq && endFreq !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);
  }
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.03, duration / 4));
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Short filtered noise burst — chips, thuds.
function noise(ac, { start, duration, gain = 0.08, freq = 900 }) {
  const frames = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const amp = ac.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(ac.currentTime + start);
}

const PATCHES = {
  // Your turn: a clean, unobtrusive chime.
  // Two notes rather than one, and louder than the rest: this is the only cue
  // that is asking you to do something, and since the music queue landed it has
  // to carry over whatever is playing.
  yourTurn: (ac) => {
    tone(ac, { freq: 880, start: 0, duration: 0.16, gain: 0.16 });
    tone(ac, { freq: 1320, start: 0.13, duration: 0.22, gain: 0.14 });
  },

  // Cooler: two descending notes — the "oh no" shape.
  cooler: (ac) => {
    tone(ac, { freq: 420, endFreq: 300, start: 0, duration: 0.28, type: 'sawtooth', gain: 0.07 });
    tone(ac, { freq: 300, endFreq: 200, start: 0.24, duration: 0.42, type: 'sawtooth', gain: 0.07 });
  },

  // Bad beat: a longer slide down, plus a low thump underneath.
  badBeat: (ac) => {
    tone(ac, { freq: 520, endFreq: 120, start: 0, duration: 0.85, type: 'sawtooth', gain: 0.08 });
    tone(ac, { freq: 110, endFreq: 60, start: 0.1, duration: 0.7, type: 'sine', gain: 0.09 });
    noise(ac, { start: 0.72, duration: 0.25, gain: 0.05, freq: 300 });
  },

  // Quads or better: a rising fanfare.
  quads: (ac) => {
    [523, 659, 784, 1047].forEach((freq, i) =>
      tone(ac, { freq, start: i * 0.09, duration: 0.3, type: 'triangle', gain: 0.075 })
    );
  },

  // Winning a pot: a bright major triad plus a chip rattle.
  win: (ac) => {
    [523, 659, 784].forEach((freq, i) =>
      tone(ac, { freq, start: i * 0.05, duration: 0.35, type: 'triangle', gain: 0.06 })
    );
    noise(ac, { start: 0.12, duration: 0.3, gain: 0.05, freq: 1600 });
  },

  // Busting: a low descending thud.
  bust: (ac) => {
    tone(ac, { freq: 200, endFreq: 70, start: 0, duration: 0.5, type: 'sine', gain: 0.09 });
    noise(ac, { start: 0, duration: 0.18, gain: 0.06, freq: 220 });
  },
};

export function play(trigger, { enabled = true } = {}) {
  if (!enabled) return;

  // A host-supplied clip always wins over the built-in patch.
  const custom = customClips[trigger];
  if (custom?.url) {
    try {
      const el = new Audio(custom.url);
      el.volume = 0.8;
      el.play().catch(() => playBuiltIn(trigger));
      return;
    } catch {
      /* fall through to the built-in */
    }
  }
  playBuiltIn(trigger);
}

function playBuiltIn(trigger) {
  const patch = PATCHES[trigger];
  if (!patch) return;
  try {
    const ac = audio();
    if (ac) patch(ac);
  } catch {
    /* sound is always best-effort */
  }
}
