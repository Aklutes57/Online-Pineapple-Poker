// In-app voice + webcam, peer-to-peer (WebRTC). No third-party service and no
// media server: each player connects directly to every other player in the
// A/V session (a small mesh — poker tables are tiny), the browser sends its
// own camera + mic straight to the others, and our server only relays the
// connection handshake. Strictly opt-in: nothing captures your camera or mic
// until you press Join.
//
// Glare-free by construction: for any pair, only the player with the smaller id
// makes the offer. Non-trickle ICE (we wait for gathering to finish, then send
// one SDP with the candidates baked in) keeps the signalling to two messages a
// pair, so it never trips the socket flood guard.

import { EVENTS } from '/shared/constants.js';

let client = null;
let socket = null;
let onChange = () => {};

let localStream = null;
let joined = false;
let camOn = true;
let micOn = true;

const peers = new Map();     // peerId -> RTCPeerConnection
const videoEls = new Map();  // playerId -> HTMLVideoElement (own + remote)
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

export async function initWebrtc(c, sock) {
  client = c;
  socket = sock;
  try {
    const cfg = await fetch('/api/rtc-config').then((r) => r.json());
    if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceServers = cfg.iceServers;
  } catch {
    /* fall back to the default public STUN */
  }
  socket.on(EVENTS.RTC_SIGNAL, onSignal);
}

export function avState() {
  return { supported: isSupported(), joined, camOn, micOn };
}
export function setOnChange(fn) { onChange = fn || (() => {}); }

function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
}

// ---- join / leave ----

export async function joinAV() {
  if (joined || !isSupported()) return { ok: joined };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    return { ok: false, error: err?.name === 'NotAllowedError'
      ? 'Camera/mic permission was denied.'
      : 'Could not access your camera or mic.' };
  }
  joined = true;
  camOn = true;
  micOn = true;

  // Local preview at your own seat (muted so you don't echo, mirrored).
  const myId = client.you?.playerId;
  if (myId) {
    const v = ensureVideoEl(myId, true);
    v.srcObject = localStream;
    v.play?.().catch(() => {});
  }

  socket.emit(EVENTS.RTC_MEDIA, { on: true });
  if (client.state) syncSeats(client.state);
  onChange();
  return { ok: true };
}

export function leaveAV() {
  socket?.emit(EVENTS.RTC_MEDIA, { on: false });
  for (const id of [...peers.keys()]) closePeer(id);
  if (localStream) for (const t of localStream.getTracks()) t.stop();
  localStream = null;
  joined = false;
  // Drop the local preview element.
  const myId = client?.you?.playerId;
  if (myId) removeVideoEl(myId);
  onChange();
}

export function toggleCamera() {
  camOn = !camOn;
  if (localStream) for (const t of localStream.getVideoTracks()) t.enabled = camOn;
  const myId = client?.you?.playerId;
  const v = myId && videoEls.get(myId);
  if (v) v.classList.toggle('cam-off', !camOn);
  onChange();
}

export function toggleMic() {
  micOn = !micOn;
  if (localStream) for (const t of localStream.getAudioTracks()) t.enabled = micOn;
  onChange();
}

// ---- mesh ----

// Reconcile connections + attach video into seats. Called after every render,
// so a rebuilt seat pod always gets its live <video> put back (moving a video
// element keeps its stream — nothing re-negotiates).
export function syncSeats(state) {
  if (!state?.seats) return;
  const myId = client.you?.playerId;

  if (joined) {
    const present = new Set();
    for (const seat of state.seats) {
      if (seat && seat.mediaOn && seat.playerId && seat.playerId !== myId) present.add(seat.playerId);
    }
    for (const pid of present) {
      if (!peers.has(pid) && myId && myId < pid) makePeer(pid, true);
    }
    for (const pid of [...peers.keys()]) {
      if (!present.has(pid)) closePeer(pid);
    }
  }

  // Attach / detach the <video> element inside each seat pod.
  const layer = document.getElementById('seats-layer');
  if (!layer) return;
  for (let i = 0; i < state.seats.length; i++) {
    const seat = state.seats[i];
    const pod = layer.querySelector(`[data-seat="${i}"]`);
    if (!pod) continue;
    const v = seat && seat.mediaOn ? videoEls.get(seat.playerId) : null;
    if (v) {
      if (v.parentElement !== pod) pod.insertBefore(v, pod.firstChild);
    } else {
      // A seat that lost media: pull any stray video for whoever sits there.
      const stray = pod.querySelector('video.seat-cam');
      if (stray) stray.remove();
    }
  }
}

function makePeer(peerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(peerId, pc);
  if (localStream) for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.ontrack = (e) => {
    const v = ensureVideoEl(peerId, false);
    if (v.srcObject !== e.streams[0]) {
      v.srcObject = e.streams[0];
      v.play?.().catch(() => {});
    }
    if (client.state) syncSeats(client.state);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(peerId);
  };

  if (initiator) negotiate(peerId).catch(() => closePeer(peerId));
  return pc;
}

async function negotiate(peerId) {
  const pc = peers.get(peerId);
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);
  socket.emit(EVENTS.RTC_SIGNAL, { to: peerId, data: { sdp: pc.localDescription } });
}

async function onSignal({ from, data }) {
  if (!joined || !data?.sdp) return;
  let pc = peers.get(from);
  const sdp = data.sdp;
  if (sdp.type === 'offer') {
    // Only accept an offer from the higher id (the designated initiator).
    if (!pc) pc = makePeer(from, false);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    socket.emit(EVENTS.RTC_SIGNAL, { to: from, data: { sdp: pc.localDescription } });
  } else if (sdp.type === 'answer' && pc) {
    await pc.setRemoteDescription(sdp).catch(() => {});
  }
}

function waitIceComplete(pc, timeout = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeout); // trickle-free but never hang on a slow network
  });
}

function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) { try { pc.close(); } catch { /* already closed */ } peers.delete(peerId); }
  removeVideoEl(peerId);
  if (client?.state) queueMicrotask(() => syncSeats(client.state));
}

// ---- video elements ----

function ensureVideoEl(playerId, isLocal) {
  let v = videoEls.get(playerId);
  if (!v) {
    v = document.createElement('video');
    v.className = 'seat-cam' + (isLocal ? ' mine' : '');
    v.autoplay = true;
    v.playsInline = true;
    if (isLocal) v.muted = true; // never echo your own mic
    videoEls.set(playerId, v);
  }
  return v;
}

function removeVideoEl(playerId) {
  const v = videoEls.get(playerId);
  if (v) { v.srcObject = null; v.remove(); videoEls.delete(playerId); }
}
