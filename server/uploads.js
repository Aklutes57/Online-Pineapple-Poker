// User uploads (table felt images, soundboard clips).
//
// Security posture, because these bytes are served from the same origin that
// holds every session token:
//  - the file type is decided by MAGIC BYTES, never by the client's
//    Content-Type or filename;
//  - SVG is deliberately not allowed — an SVG served from this origin is
//    stored XSS with full token access;
//  - files are content-addressed by SHA-256, so a path can never drift from
//    its row and duplicate uploads cost nothing;
//  - the serving route sets the stored MIME plus nosniff and a locked-down
//    CSP, so even a crafted file cannot execute in this origin.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, get, all, now } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

export const UPLOAD_DIR = process.env.PP_UPLOAD_DIR || path.join(root, 'data', 'uploads');

export const LIMITS = {
  image: 4 * 1024 * 1024,
  // Two megabytes is about fifty seconds of a 320kbps MP3, which is shorter
  // than plenty of the clips people actually want on a soundboard — and the
  // rejection reads as "that file type is wrong" to anyone not looking closely.
  // Eight leaves room for a real clip while staying small enough that the
  // uploads directory, which is content-addressed and never pruned, does not
  // run away with the volume.
  audio: 8 * 1024 * 1024,
};

// Every accepted format, keyed by what its bytes actually say.
const SIGNATURES = [
  { kind: 'image', mime: 'image/png', ext: '.png', test: (b) =>
      b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { kind: 'image', mime: 'image/jpeg', ext: '.jpg', test: (b) =>
      b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/gif', ext: '.gif', test: (b) =>
      b.length > 6 && b.toString('latin1', 0, 6).startsWith('GIF8') },
  { kind: 'image', mime: 'image/webp', ext: '.webp', test: (b) =>
      b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { kind: 'audio', mime: 'audio/mpeg', ext: '.mp3', test: (b) =>
      b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' ||
        (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { kind: 'audio', mime: 'audio/ogg', ext: '.ogg', test: (b) =>
      b.length > 4 && b.toString('latin1', 0, 4) === 'OggS' },
  { kind: 'audio', mime: 'audio/wav', ext: '.wav', test: (b) =>
      b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
];

export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return SIGNATURES.find((s) => s.test(buffer)) || null;
}

// Stores the bytes and returns the upload row. `wantKind` is 'image' or
// 'audio'; a mismatch is rejected so a sound slot can't be fed a PNG.
export function storeUpload({ buffer, accountId, wantKind, originalName }) {
  const sig = sniff(buffer);
  if (!sig) {
    return { ok: false, error: 'That file type is not supported (PNG, JPEG, GIF, WebP, MP3, OGG or WAV)' };
  }
  if (wantKind && sig.kind !== wantKind) {
    return { ok: false, error: `Expected ${wantKind === 'image' ? 'an image' : 'an audio clip'}` };
  }
  const limit = LIMITS[sig.kind];
  if (buffer.length > limit) {
    return { ok: false, error: `Files must be under ${Math.round(limit / 1024 / 1024)}MB` };
  }

  const sha = createHash('sha256').update(buffer).digest('hex');
  const existing = get('SELECT * FROM uploads WHERE sha256 = ?', sha);
  if (existing) return { ok: true, upload: publicUpload(existing) };

  const relative = path.join(sha.slice(0, 2), sha + sig.ext);
  const absolute = path.join(UPLOAD_DIR, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  if (!existsSync(absolute)) writeFileSync(absolute, buffer);

  const result = run(
    `INSERT INTO uploads (account_id, kind, sha256, mime, ext, bytes, original_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    accountId ?? null,
    sig.kind,
    sha,
    sig.mime,
    sig.ext,
    buffer.length,
    typeof originalName === 'string' ? originalName.slice(0, 120) : null,
    now()
  );
  return { ok: true, upload: publicUpload(get('SELECT * FROM uploads WHERE id = ?', Number(result.lastInsertRowid))) };
}

export function getUploadBySha(sha) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)) return null;
  const row = get('SELECT * FROM uploads WHERE sha256 = ?', sha);
  return row ? publicUpload(row) : null;
}

export function uploadPath(upload) {
  return path.join(UPLOAD_DIR, upload.sha.slice(0, 2), upload.sha + upload.ext);
}

function publicUpload(row) {
  return {
    id: row.id,
    kind: row.kind,
    sha: row.sha256,
    mime: row.mime,
    ext: row.ext,
    bytes: row.bytes,
    url: `/uploads/${row.sha256}${row.ext}`,
    originalName: row.original_name,
  };
}

// ---- themes ----

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function cleanColor(value) {
  return typeof value === 'string' && COLOR_RE.test(value) ? value : null;
}

export function saveTheme(accountId, { name, feltImageUrl, feltColor, railColor, makeDefault }) {
  const themeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'My table';
  const existing = get('SELECT id FROM themes WHERE account_id = ? AND name = ?', accountId, themeName);
  const felt = typeof feltImageUrl === 'string' && feltImageUrl.startsWith('/uploads/')
    ? feltImageUrl
    : null;

  if (existing) {
    run(
      'UPDATE themes SET felt_image = ?, felt_color = ?, rail_color = ? WHERE id = ?',
      felt, cleanColor(feltColor), cleanColor(railColor), existing.id
    );
  } else {
    run(
      `INSERT INTO themes (account_id, name, felt_image, felt_color, rail_color, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      accountId, themeName, felt, cleanColor(feltColor), cleanColor(railColor), now()
    );
  }
  const theme = get('SELECT * FROM themes WHERE account_id = ? AND name = ?', accountId, themeName);
  if (makeDefault !== false) setDefaultTheme(accountId, theme.id);
  return { ok: true, theme: publicTheme(get('SELECT * FROM themes WHERE id = ?', theme.id)) };
}

export function setDefaultTheme(accountId, themeId) {
  run('UPDATE themes SET is_default = 0 WHERE account_id = ?', accountId);
  run('UPDATE themes SET is_default = 1 WHERE id = ? AND account_id = ?', themeId, accountId);
}

export function listThemes(accountId) {
  return all('SELECT * FROM themes WHERE account_id = ? ORDER BY created_at DESC', accountId).map(publicTheme);
}

export function defaultTheme(accountId) {
  if (!accountId) return null;
  const row = get('SELECT * FROM themes WHERE account_id = ? AND is_default = 1', accountId);
  return row ? publicTheme(row) : null;
}

export function deleteTheme(accountId, themeId) {
  run('DELETE FROM themes WHERE id = ? AND account_id = ?', themeId, accountId);
  return { ok: true };
}

function publicTheme(row) {
  return {
    id: row.id,
    name: row.name,
    feltImage: row.felt_image,
    feltColor: row.felt_color,
    railColor: row.rail_color,
    isDefault: !!row.is_default,
  };
}

// ---- soundboard ----

export const SOUND_TRIGGERS = ['cooler', 'badBeat', 'quads', 'win', 'bust', 'yourTurn'];

export function saveSoundClip(accountId, triggerKey, upload) {
  if (!SOUND_TRIGGERS.includes(triggerKey)) return { ok: false, error: 'Unknown sound slot' };
  if (upload.kind !== 'audio') return { ok: false, error: 'That is not an audio file' };
  run(
    `INSERT INTO sound_clips (account_id, trigger_key, file_path, original_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, trigger_key) DO UPDATE SET
       file_path = excluded.file_path,
       original_name = excluded.original_name,
       created_at = excluded.created_at`,
    accountId, triggerKey, upload.url, upload.originalName ?? null, now()
  );
  return { ok: true, clips: listSoundClips(accountId) };
}

export function listSoundClips(accountId) {
  if (!accountId) return {};
  const rows = all('SELECT trigger_key, file_path, original_name FROM sound_clips WHERE account_id = ?', accountId);
  const map = {};
  for (const row of rows) {
    map[row.trigger_key] = { url: row.file_path, name: row.original_name };
  }
  return map;
}

export function deleteSoundClip(accountId, triggerKey) {
  run('DELETE FROM sound_clips WHERE account_id = ? AND trigger_key = ?', accountId, triggerKey);
  return { ok: true, clips: listSoundClips(accountId) };
}
