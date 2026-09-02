// Turning what somebody pastes into a YouTube video id.
//
// Playback itself is the official IFrame Player API running in each player's
// own browser — the server never touches audio. That is the only sanctioned
// way to play YouTube in a web app, and it is why the "music bot" is really a
// shared queue plus a clock: the server says what is playing and when it
// started, and every client plays that itself.

// A video id is exactly eleven characters of the URL-safe alphabet. Anything
// else is not an id, and we would rather refuse a link than build an <iframe>
// src out of something a player controls.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be', 'www.youtu.be',
]);

// Accepts a full watch/share/shorts/embed URL or a bare id. Returns the id, or
// null for anything we do not recognise — including a URL on a host that only
// looks like YouTube ("youtube.com.evil.test").
export function parseYouTubeId(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (ID_RE.test(text)) return text;

  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Exact host match, never endsWith: "notyoutube.com" and
  // "youtube.com.example.net" must both fail.
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  // youtu.be/<id> and /shorts/<id>, /embed/<id>, /v/<id>
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    return ID_RE.test(segments[0] || '') ? segments[0] : null;
  }
  if (segments.length >= 2 && ['shorts', 'embed', 'v', 'live'].includes(segments[0])) {
    return ID_RE.test(segments[1]) ? segments[1] : null;
  }
  // The ordinary watch URL.
  const v = url.searchParams.get('v');
  return v && ID_RE.test(v) ? v : null;
}

// What a client is allowed to call a track. Free text from a player, so it is
// clamped and never trusted as markup.
export const MUSIC_LIMITS = {
  title: 80,
  queue: 50, // tracks a table may have lined up at once
};

export function cleanTrackTitle(raw) {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, MUSIC_LIMITS.title);
  return title || null;
}
