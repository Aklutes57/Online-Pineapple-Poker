// In-app voice + webcam, peer-to-peer (WebRTC). No third-party service and no
// media server: each player connects directly to every other player who is
// broadcasting (a small mesh — poker tables are tiny), the browser sends its
// own camera + mic straight to the others, and our server only relays the
// connection handshake. Strictly opt-in: nothing captures your camera or mic
// until you press Join.
//
// WATCHING IS NOT THE SAME AS BROADCASTING. Turning your own camera on is not
// the price of seeing anyone else's: a player who never pressed Join still
// connects to everyone who did, receive-only, and sees and hears them. That is
// what the `present` set below is for — it is built from who is broadcasting,
// not from whether you are.
//
// Glare-free by construction, with two cases:
//   - one side broadcasting: the RECEIVING side offers. It has to be that way
//     round — a spectator isn't in `state.seats` at all, so the broadcaster
//     cannot see them to offer first.
//   - both broadcasting: the smaller player id offers, as before.
// Non-trickle ICE (we wait for gathering to finish, then send one SDP with the
// candidates baked in) keeps the signalling to two messages a pair, so it never
// trips the socket flood guard.

import { EVENTS } from '/shared/constants.js';

let client = null;
let socket = null;
let onChange = () => {};

let localStream = null;
let joined = false;
let camOn = true;
let micOn = true;
// Bumped every time our own set of outgoing tracks changes (join / leave).
// It is half of a connection's identity: when it moves, every peer connection
// we hold is stale and gets rebuilt so the new tracks are actually negotiated.
// The other half is the peer's mediaEpoch, which the server broadcasts — so
// both ends of a pair independently decide to rebuild at the same moment,
// without another round of signalling.
let myGen = 0;

const peers = new Map();     // peerId -> RTCPeerConnection
const peerKeys = new Map();  // peerId -> the (peerEpoch|myGen) the peer was built for
// Connections WE opened, to watch a broadcaster. The distinction matters for
// teardown: a connection the other side opened is one where THEY are watching
// US, and we cannot see the want behind it — a watcher is not broadcasting, and
// an unseated spectator is not even in state.seats. Reconciling those away is
// exactly how a watcher's picture died a moment after it appeared.
const initiatedByMe = new Set();
// Back-off after a failed negotiation, so a peer that cannot connect is retried
// on a timer instead of instantly, which would spin.
const retryAfter = new Map(); // peerId -> timestamp
// When we sent an offer. A single dropped signal — the flood guard rejecting a
// packet, or the relay finding the target between sockets — otherwise strands
// the pair for good: the offerer sits in have-local-offer, which never becomes
// 'failed', and both sides' keys still match so nothing rebuilds.
const offeredAt = new Map(); // peerId -> timestamp
const OFFER_TIMEOUT = 9000;
// A broadcaster answers every watcher, and each answer is another copy of their
// camera going up their connection. A home game never comes near this; it is
// here so a crowd of spectators cannot melt somebody's phone.
const MAX_PEERS = 12;
const videoEls = new Map();  // playerId -> HTMLVideoElement (own + remote)
// Remote audio lives in its own element, never in the seat tile. A tile can be
// visibility:hidden (camera off), rebuilt by a re-render, or absent entirely
// (you are watching without a seat) — none of which should ever cost you the
// table's voices. Video tiles are muted; these carry all the sound.
const audioEls = new Map();  // peerId -> HTMLAudioElement
// Players you have muted, for you only — it silences their audio in your
// browser and tells them nothing. Kept per table between reloads.
const mutedPeers = new Set();
// Deafened: you hear nobody, they still hear you (that's what the mic button
// is for). Local only, like the per-player mutes, and remembered per device.
let deafened = false;
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
  loadMuted();
  try {
    deafened = localStorage.getItem('pp:deafen') === 'on';
  } catch { /* private browsing */ }
  socket.on(EVENTS.RTC_SIGNAL, onSignal);
  // A dropped socket clears mediaOn server-side (peers must tear down), so a
  // blip would otherwise take a broadcaster off the table permanently: their
  // camera stays on locally and nobody can see it. Re-assert on every
  // reconnect, the same way the avatar and nameplate font do.
  socket.on('connect', () => {
    if (!joined) return;
    // Announce FIRST, synchronously. The socket is ordered, so this reaches the
    // server ahead of any offer (which has to wait on ICE gathering) and the
    // table learns we are broadcasting again before it sees us connecting.
    // Announcing after the rebuild left a window where our own mediaOn was
    // still false server-side while we were already building connections, and
    // the epoch bump that followed invalidated every one of them.
    announce();
    // Our tracks are the same ones, but every peer rebuilt from scratch while
    // we were away — start their connections over too.
    myGen++;
    for (const id of [...peers.keys()]) closePeer(id);
    if (client?.state) syncSeats(client.state);
  });
}

export function avState() {
  return {
    supported: isSupported(), joined, camOn, micOn, deafened,
    // Voice-only sessions have no video track — the camera/frame controls
    // would be dead buttons.
    hasVideo: !!localStream && localStream.getVideoTracks().length > 0,
  };
}

export function isDeafened() {
  return deafened;
}

export function toggleDeafen() {
  deafened = !deafened;
  try {
    localStorage.setItem('pp:deafen', deafened ? 'on' : 'off');
  } catch { /* still works for this session */ }
  applyMutes();
  onChange();
  return deafened;
}

// ---- muting individual players (local only) ----

const muteKey = () => `pp:muted:${client?.gameId || ''}`;

function loadMuted() {
  try {
    for (const id of JSON.parse(localStorage.getItem(muteKey()) || '[]')) mutedPeers.add(id);
  } catch {
    /* nothing saved */
  }
}

export function isMuted(playerId) {
  return mutedPeers.has(playerId);
}

export function toggleMutePlayer(playerId) {
  if (mutedPeers.has(playerId)) mutedPeers.delete(playerId);
  else mutedPeers.add(playerId);
  try {
    localStorage.setItem(muteKey(), JSON.stringify([...mutedPeers]));
  } catch {
    /* private mode — muting still works for this session */
  }
  applyMutes();
  onChange();
  return mutedPeers.has(playerId);
}

// Each peer's audio element is what carries their voice, so silencing it is
// exactly "mute this person, for me".
function applyMutes() {
  for (const [id, el] of audioEls) {
    el.muted = deafened || mutedPeers.has(id);
  }
  // Tiles never carry sound (see audioEls) — belt and braces so a stream
  // handed to a <video> can't leak a second copy of someone's voice.
  for (const el of videoEls.values()) el.muted = true;
}
export function setOnChange(fn) { onChange = fn || (() => {}); }

function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
}

// ---- join / leave ----

// voiceOnly joins the same mesh with a mic and no camera at all — the seat
// keeps showing the profile picture and only your voice travels.
export async function joinAV({ voiceOnly = false } = {}) {
  if (joined || !isSupported()) return { ok: joined };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: voiceOnly
        ? false
        : { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const what = voiceOnly ? 'mic' : 'camera or mic';
    return { ok: false, error: err?.name === 'NotAllowedError'
      ? `${voiceOnly ? 'Mic' : 'Camera/mic'} permission was denied.`
      : `Could not access your ${what}.` };
  }
  joined = true;
  camOn = !voiceOnly;
  micOn = true;
  // Our outgoing tracks just changed. Any connection built while we were only
  // watching carries no tracks of ours, so drop the lot and let syncSeats
  // rebuild them — this time with something to send.
  myGen++;
  for (const id of [...peers.keys()]) closePeer(id);

  // Local preview at your own seat (muted so you don't echo, mirrored). A
  // voice-only tile starts invisible, so the profile picture stays put.
  const myId = client.you?.playerId;
  if (myId) {
    const v = ensureVideoEl(myId, true);
    v.srcObject = localStream;
    v.classList.toggle('cam-off', voiceOnly);
    v.play?.().catch(() => armPlayRetry());
  }

  announce();
  if (client.state) syncSeats(client.state);
  onChange();
  return { ok: true };
}

export function leaveAV() {
  socket?.emit(EVENTS.RTC_MEDIA, { on: false, cam: false });
  if (localStream) for (const t of localStream.getTracks()) t.stop();
  localStream = null;
  joined = false;
  camOn = true;
  myGen++;
  // Drop every connection: they all carry tracks we no longer have. Whoever is
  // still broadcasting gets picked back up receive-only on the next state.
  for (const id of [...peers.keys()]) closePeer(id);
  // Drop the local preview element.
  const myId = client?.you?.playerId;
  if (myId) removeVideoEl(myId);
  if (client?.state) syncSeats(client.state);
  onChange();
}

// Tell the table what we are sending. `cam` is separate from `on` so a player
// who switches their camera off (but stays in voice) shows their profile
// picture to everyone rather than a frozen black tile — the track is still
// there, just disabled, so the receiver cannot tell without being told.
function announce() {
  socket?.emit(EVENTS.RTC_MEDIA, {
    on: joined,
    cam: joined && camOn && !!localStream && localStream.getVideoTracks().length > 0,
  });
}

export function toggleCamera() {
  camOn = !camOn;
  if (localStream) for (const t of localStream.getVideoTracks()) t.enabled = camOn;
  const myId = client?.you?.playerId;
  const v = myId && videoEls.get(myId);
  if (v) v.classList.toggle('cam-off', !camOn);
  announce();
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

  // Everyone else still at the table, and which of them are broadcasting.
  const atTable = new Map(); // peerId -> seat
  for (const seat of state.seats) {
    if (seat && seat.playerId && seat.playerId !== myId) atTable.set(seat.playerId, seat);
  }
  const now = Date.now();
  if (myId) {
    for (const [pid, seat] of atTable) {
      if (!seat.mediaOn) continue; // nothing to receive from them
      const key = `${seat.mediaEpoch ?? 0}|${myGen}`;
      // A live connection built for a different key is stale: either the peer
      // restarted their media or we changed ours. Rebuild rather than try to
      // renegotiate — both ends reach this conclusion from the same state, so
      // the rebuild is symmetric and needs no extra handshake.
      if (peers.has(pid) && peerKeys.get(pid) !== key) closePeer(pid);
      // An offer that never came back: a dropped signal leaves the connection
      // parked in have-local-offer, which never turns into 'failed', so
      // nothing else would ever notice. Start it over, with a back-off.
      const pc = peers.get(pid);
      const waiting = offeredAt.get(pid);
      if (pc && waiting && now - waiting > OFFER_TIMEOUT) {
        if (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting') {
          retryAfter.set(pid, now + 1500);
          closePeer(pid);
        } else {
          offeredAt.delete(pid); // it got there; stop watching this one
        }
      }
      if (!peers.has(pid) && (retryAfter.get(pid) ?? 0) <= now && peers.size < MAX_PEERS) {
        // Receive-only side offers; when both are broadcasting, low id offers.
        makePeer(pid, joined ? myId < pid : true, key);
      }
    }
  }
  // Tear down only what WE asked for and no longer want. A connection the peer
  // opened stays until it fails or they close it: they are watching us, and
  // nothing in our copy of the state can tell us they still want to.
  for (const pid of [...peers.keys()]) {
    if (!initiatedByMe.has(pid)) continue;
    const seat = atTable.get(pid);
    if (!seat || !seat.mediaOn) closePeer(pid);
  }

  // Attach / detach the <video> element inside each seat pod.
  const layer = document.getElementById('seats-layer');
  if (!layer) return;
  for (let i = 0; i < state.seats.length; i++) {
    const seat = state.seats[i];
    const pod = layer.querySelector(`[data-seat="${i}"]`);
    if (!pod) continue;
    const v = seat && seat.mediaOn ? videoEls.get(seat.playerId) : null;
    // A voice-only peer's stream carries no video track at all, and a peer who
    // switched their camera off still sends a (disabled, black) one. Either way
    // their tile stays invisible and the profile picture shows through — the
    // camOn flag is the only way to tell the second case apart.
    if (v && seat.playerId !== myId) {
      const stream = v.srcObject;
      const noVideo = !stream || stream.getVideoTracks().length === 0;
      v.classList.toggle('cam-off', noVideo || seat.camOn === false);
    }
    // A live tile covers the same spot as the profile picture; when the camera
    // is switched off the tile only goes invisible, so the picture comes back
    // and fills the hole rather than leaving a gap in the pod.
    const avatar = pod.querySelector('.seat-avatar');
    if (avatar) avatar.classList.toggle('hidden', !!v && !v.classList.contains('cam-off'));
    if (v) {
      // Each player picks the frame around their own tile.
      if (seat.camFrame) {
        v.style.borderImage = `url("${seat.camFrame}") 30 round`;
        v.style.borderWidth = '10px';
      } else {
        v.style.borderImage = '';
        v.style.borderWidth = '';
      }
      v.classList.toggle('muted-peer', mutedPeers.has(seat.playerId));
      if (v.parentElement !== pod) pod.insertBefore(v, pod.firstChild);
      // A tile that was detached across a task (any seat rebuild — muting a
      // player rebuilds their pod) comes back paused, and re-attaching does
      // not resume it. Without this the picture freezes for good.
      if (v.paused && v.srcObject) v.play?.().catch(() => armPlayRetry());
    } else {
      // A seat that lost media: pull any stray video for whoever sits there.
      const stray = pod.querySelector('video.seat-cam');
      if (stray) stray.remove();
    }
  }
}

function makePeer(peerId, initiator, key = '') {
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(peerId, pc);
  peerKeys.set(peerId, key);
  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  } else {
    // Watching without broadcasting. There are no tracks to add, so ask for
    // recvonly transceivers explicitly — an offer with no media sections at
    // all would negotiate a connection that can never carry their camera.
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    // Sound goes to a dedicated element, pictures to the seat tile. Both come
    // off the same stream, so the tile stays muted to avoid a double.
    if (e.track.kind === 'audio') {
      const a = ensureAudioEl(peerId);
      if (a.srcObject !== stream) {
        a.srcObject = stream;
        a.play?.().catch(() => armPlayRetry());
      }
      a.muted = deafened || mutedPeers.has(peerId);
    } else {
      const v = ensureVideoEl(peerId, false);
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        v.play?.().catch(() => armPlayRetry());
      }
      v.muted = true;
    }
    if (client.state) syncSeats(client.state);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') offeredAt.delete(peerId);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(peerId);
  };

  if (initiator) {
    initiatedByMe.add(peerId);
    negotiate(peerId).catch(() => {
      // Don't come straight back for another go: closePeer re-runs syncSeats,
      // which would rebuild and fail again with nothing between the two.
      retryAfter.set(peerId, Date.now() + 3000);
      closePeer(peerId);
    });
  }
  return pc;
}

async function negotiate(peerId) {
  const pc = peers.get(peerId);
  if (!pc) return;
  const offer = await pc.createOffer();
  if (peers.get(peerId) !== pc) return; // torn down and rebuilt while we waited
  await pc.setLocalDescription(offer);
  if (peers.get(peerId) !== pc) return;
  await waitIceComplete(pc);
  // Gathering can take a couple of seconds. If this connection was replaced in
  // the meantime, shipping its offer would have the peer answer a pc that no
  // longer exists — a pair that looks connected and carries nothing.
  if (peers.get(peerId) !== pc) return;
  offeredAt.set(peerId, Date.now());
  socket.emit(EVENTS.RTC_SIGNAL, { to: peerId, data: { sdp: pc.localDescription } });
}

// Signals from one peer are handled strictly one at a time. Answering takes up
// to a couple of seconds (ICE gathering), and two offers arriving inside that
// window would otherwise interleave setRemoteDescription/createAnswer on the
// same connection and throw.
const signalQueues = new Map(); // peerId -> promise chain

function onSignal(msg) {
  const from = msg?.from;
  if (!from || !msg?.data?.sdp) return;
  const prev = signalQueues.get(from) ?? Promise.resolve();
  const next = prev.then(() => handleSignal(msg)).catch(() => {
    // A handshake that fails is not fatal: drop the connection and let
    // syncSeats rebuild it on the next state.
    closePeer(from);
  });
  signalQueues.set(from, next);
  next.finally(() => {
    if (signalQueues.get(from) === next) signalQueues.delete(from);
  });
}

async function handleSignal({ from, data }) {
  // No `joined` check: an offer from a player who is only watching is exactly
  // how they get to see us, and refusing it was why nobody but the broadcaster
  // ever saw a webcam. The server has already vouched that `from` is a
  // co-player at this table.
  let pc = peers.get(from);
  const sdp = data.sdp;
  if (sdp.type === 'offer') {
    // Whoever offered is the initiator for this pair; we answer — up to a
    // point. Every answer is another copy of our camera going up, so past the
    // cap we simply do not, and that watcher falls back to the profile picture.
    if (!pc && peers.size >= MAX_PEERS) return;
    if (!pc) pc = makePeer(from, false, peerKeyFor(from));
    await pc.setRemoteDescription(sdp);
    if (peers.get(from) !== pc) return; // replaced while we were answering
    const answer = await pc.createAnswer();
    if (peers.get(from) !== pc) return;
    await pc.setLocalDescription(answer);
    if (peers.get(from) !== pc) return;
    await waitIceComplete(pc);
    if (peers.get(from) !== pc) return;
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

// The key a peer connection *should* have right now, so an answerer records the
// same identity the offerer used and neither side rebuilds a fresh connection
// it has only just accepted.
function peerKeyFor(peerId) {
  const seat = client?.state?.seats?.find((s) => s && s.playerId === peerId);
  return `${seat?.mediaEpoch ?? 0}|${myGen}`;
}

function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) { try { pc.close(); } catch { /* already closed */ } peers.delete(peerId); }
  peerKeys.delete(peerId);
  initiatedByMe.delete(peerId);
  offeredAt.delete(peerId);
  removeVideoEl(peerId);
  removeAudioEl(peerId);
  // setTimeout, not queueMicrotask: rebuilding runs through this function
  // again on failure, and a microtask chain would never reach the event loop.
  if (client?.state) setTimeout(() => { if (client?.state) syncSeats(client.state); }, 0);
}

// ---- video elements ----

// iOS (and Low Power Mode anywhere) refuses to start an unmuted remote
// video outside a user gesture — the tile sits black and silent. When a
// play() is refused, arm a one-shot listener that replays every stalled
// tile on the next tap or click anywhere.
let playRetryArmed = false;
function armPlayRetry() {
  if (playRetryArmed) return;
  playRetryArmed = true;
  const kick = () => {
    playRetryArmed = false;
    for (const el of [...videoEls.values(), ...audioEls.values()]) {
      if (el.paused && el.srcObject) el.play?.().catch(() => {});
    }
  };
  document.addEventListener('pointerdown', kick, { once: true, capture: true });
}

// ---- audio elements ----

// Voices hang off a container of their own, out of the table's layout. A seat
// pod is the wrong home for them: it gets rebuilt, hidden, and doesn't exist
// at all for a player who is watching without a seat.
function audioHost() {
  let host = document.getElementById('av-audio');
  if (!host) {
    host = document.createElement('div');
    host.id = 'av-audio';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    document.body.appendChild(host);
  }
  return host;
}

function ensureAudioEl(peerId) {
  let a = audioEls.get(peerId);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true;
    a.setAttribute('playsinline', '');
    a.addEventListener('loadedmetadata', () => {
      a.play?.().catch(() => armPlayRetry());
    });
    audioEls.set(peerId, a);
    audioHost().appendChild(a);
  }
  return a;
}

function removeAudioEl(peerId) {
  const a = audioEls.get(peerId);
  if (a) { a.srcObject = null; a.remove(); audioEls.delete(peerId); }
}

function ensureVideoEl(playerId, isLocal) {
  let v = videoEls.get(playerId);
  if (!v) {
    v = document.createElement('video');
    v.className = 'seat-cam' + (isLocal ? ' mine' : '');
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', ''); // older iOS ignores the property
    // Always muted: your own tile must never echo your mic, and a remote tile's
    // sound comes out of its audio element instead (see audioEls). A muted
    // video also autoplays under every browser policy, so tiles never stall.
    v.muted = true;
    // A stream that arrives mid-render can miss its play() — retry the
    // moment the metadata lands, and fall back to the gesture arm.
    v.addEventListener('loadedmetadata', () => {
      v.play?.().catch(() => armPlayRetry());
    });
    videoEls.set(playerId, v);
  }
  return v;
}

function removeVideoEl(playerId) {
  const v = videoEls.get(playerId);
  if (v) { v.srcObject = null; v.remove(); videoEls.delete(playerId); }
}
