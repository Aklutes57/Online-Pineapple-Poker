// The table's music: the link parser (which builds an iframe src out of text a
// player typed, so it is a security boundary) and the shared queue and clock.
// Usage: node test/test-music.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pp-music-')), 'test.db');

const { parseYouTubeId, cleanTrackTitle, MUSIC_LIMITS } = await import('../shared/music.js');
const { createGame } = await import('../server/gameManager.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) { passes++; } else { failures++; console.error(`FAIL: ${name}`); }
}

const ID = 'dQw4w9WgXcQ';

// ---- the link parser ----
{
  for (const [input, want] of [
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`http://youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?t=42`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}`, ID],
    [`https://www.youtube.com/live/${ID}`, ID],
    [`https://music.youtube.com/watch?v=${ID}&list=OLAK5uy_x`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    [`  https://www.youtube.com/watch?v=${ID}  `, ID],
    [`www.youtube.com/watch?v=${ID}`, ID],
    [ID, ID],
  ]) {
    check(`parses ${input.trim().slice(0, 46)}`, parseYouTubeId(input) === want);
  }

  // The part that actually matters: nothing but YouTube, and nothing that is
  // not an eleven-character id, may ever reach an iframe src.
  for (const bad of [
    `https://youtube.com.evil.test/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://evil.test/watch?v=${ID}`,
    `https://myyoutu.be/${ID}`,
    'javascript:alert(1)',
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=waytoolongtobeanid',
    'https://www.youtube.com/watch?v=has spaces',
    'https://www.youtube.com/',
    'data:text/html,<script>alert(1)</script>',
    '', '   ', null, undefined, 42, {}, [],
  ]) {
    check(`refuses ${String(bad).slice(0, 46)}`, parseYouTubeId(bad) === null);
  }

  check('a title is trimmed and clamped',
    cleanTrackTitle('  a   b  ').length === 3);
  check('an over-long title is cut to the limit',
    cleanTrackTitle('x'.repeat(500)).length === MUSIC_LIMITS.title);
  check('an empty title is null', cleanTrackTitle('   ') === null);
}

// ---- the queue and the clock ----
{
  const { game, host } = createGame({}, 'DJ', null);
  check('a table starts with no music', game.musicNowPlaying() === null);

  check('a bad link is refused', game.musicAdd(host, 'not a link').ok === false);
  check('nothing was queued by the refusal', game.music.queue.length === 0);

  check('a good link is queued', game.musicAdd(host, `https://youtu.be/${ID}`).ok === true);
  check('the first track starts straight away',
    game.musicNowPlaying()?.id === ID && game.music.startedAt !== null);
  check('the track records who queued it', game.musicNowPlaying().addedBy === 'DJ');

  // A second track waits its turn rather than cutting off the first.
  const startedAt = game.music.startedAt;
  game.musicAdd(host, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  check('a second track does not interrupt the first',
    game.musicNowPlaying().id === ID && game.music.startedAt === startedAt);
  check('the second track is behind it', game.music.queue.length === 2);
}
{
  const { game, host } = createGame({}, 'DJ', null);
  game.musicAdd(host, `https://youtu.be/${ID}`);
  game.musicAdd(host, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');

  check('skip moves to the next track',
    game.musicSkip(host).ok === true && game.musicNowPlaying().id === 'bbbbbbbbbbb');
  check('skipping past the end stops the music',
    game.musicSkip(host).ok === true && game.musicNowPlaying() === null
    && game.music.startedAt === null);
  check('there is nothing left to skip', game.musicSkip(host).ok === false);
}
{
  // Every browser reports the end of the same track. Only the first may
  // advance the queue, or a nine-handed table would skip eight songs.
  const { game, host } = createGame({}, 'DJ', null);
  for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) {
    game.musicAdd(host, `https://youtu.be/${id}`);
  }
  game.musicEnded(0);
  check('the first end report advances one track', game.music.index === 1);
  game.musicEnded(0);
  game.musicEnded(0);
  check('later reports of the same track are ignored', game.music.index === 1);
  check('a nonsense index is ignored',
    game.musicEnded(99).ok === true && game.music.index === 1);
  check('a non-integer index is ignored',
    game.musicEnded('1').ok === true && game.music.index === 1);
}
{
  // Pausing banks the offset; resuming backdates the start so the same
  // arithmetic every client already does keeps working.
  const { game, host } = createGame({}, 'DJ', null);
  game.musicAdd(host, `https://youtu.be/${ID}`);
  game.music.startedAt = Date.now() - 30_000; // pretend 30s in

  check('pause is accepted', game.musicPause(host, true).ok === true);
  check('pausing banks roughly where we were',
    Math.abs(game.music.pausedAt - 30) < 2 && game.music.startedAt === null);
  check('pausing twice is a no-op', game.musicPause(host, true).ok === true);

  check('resume is accepted', game.musicPause(host, false).ok === true);
  const back = (Date.now() - game.music.startedAt) / 1000;
  check('resuming picks up where it left off', Math.abs(back - 30) < 2);
}
{
  const { game, host } = createGame({}, 'DJ', null);
  game.musicAdd(host, `https://youtu.be/${ID}`);
  game.musicClear();
  check('clearing empties the queue and stops the music',
    game.music.queue.length === 0 && game.music.index === 0
    && game.music.startedAt === null && game.musicNowPlaying() === null);
}
{
  // The queue is bounded, so one player cannot paste a thousand links.
  const { game, host } = createGame({}, 'DJ', null);
  for (let i = 0; i < MUSIC_LIMITS.queue; i++) {
    game.musicAdd(host, `https://youtu.be/${ID}`);
  }
  const overflow = game.musicAdd(host, `https://youtu.be/${ID}`);
  check('the queue is capped', overflow.ok === false);
  check('the cap is not exceeded', game.music.queue.length === MUSIC_LIMITS.queue);
}

console.log(`music: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
