// Upload validation and theme handling. The security-critical assertion here
// is that file type comes from magic bytes and that SVG is never accepted —
// an SVG served from this origin would be stored XSS against session tokens.
// Usage: node test/test-uploads.js

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-up-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');
process.env.PP_UPLOAD_DIR = path.join(dir, 'uploads');

const { initDb, closeDb } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const uploads = await import('../server/uploads.js');
const { sanitizeSettings } = await import('../server/game.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

initDb();
const acct = accounts.createAccount({
  email: 'up@example.com', password: 'a good long password', displayName: 'Uppy',
}).account;

// Minimal valid file headers.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>');

// ---- accepted formats ----

for (const [name, buf, kind, mime] of [
  ['PNG', PNG, 'image', 'image/png'],
  ['JPEG', JPEG, 'image', 'image/jpeg'],
  ['GIF', GIF, 'image', 'image/gif'],
  ['WebP', WEBP, 'image', 'image/webp'],
  ['OGG', OGG, 'audio', 'audio/ogg'],
  ['WAV', WAV, 'audio', 'audio/wav'],
  ['MP3', MP3, 'audio', 'audio/mpeg'],
]) {
  const sig = uploads.sniff(buf);
  check(`${name} detected from magic bytes`, sig && sig.kind === kind && sig.mime === mime);
}

// ---- rejected formats (the security-critical cases) ----

check('SVG is rejected', uploads.sniff(SVG) === null);
check('HTML is rejected', uploads.sniff(HTML) === null);
check('empty buffer is rejected', uploads.sniff(Buffer.alloc(0)) === null);
check('random bytes are rejected', uploads.sniff(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])) === null);

check('storing an SVG fails', uploads.storeUpload({
  buffer: SVG, accountId: acct.id, wantKind: 'image',
}).ok === false);

// A PNG renamed .mp3 is still stored as a PNG, not as audio.
const renamed = uploads.storeUpload({
  buffer: PNG, accountId: acct.id, wantKind: 'audio', originalName: 'totally-a-song.mp3',
});
check('a PNG claiming to be audio is rejected', renamed.ok === false);

// ---- storing ----

const stored = uploads.storeUpload({ buffer: PNG, accountId: acct.id, wantKind: 'image', originalName: 'felt.png' });
check('valid PNG stored', stored.ok === true);
check('stored mime comes from sniffing', stored.upload.mime === 'image/png');
check('url is content-addressed', /^\/uploads\/[a-f0-9]{64}\.png$/.test(stored.upload.url));
check('file written to disk', existsSync(uploads.uploadPath(stored.upload)));

const again = uploads.storeUpload({ buffer: PNG, accountId: acct.id, wantKind: 'image' });
check('identical bytes dedupe to the same url', again.upload.url === stored.upload.url);

check('oversized image rejected', uploads.storeUpload({
  buffer: Buffer.concat([PNG, Buffer.alloc(uploads.LIMITS.image + 1)]),
  accountId: acct.id,
  wantKind: 'image',
}).ok === false);

check('lookup by sha works', uploads.getUploadBySha(stored.upload.sha)?.url === stored.upload.url);
check('lookup rejects a path traversal attempt', uploads.getUploadBySha('../../etc/passwd') === null);
check('lookup rejects a non-hex name', uploads.getUploadBySha('nope') === null);

// ---- themes ----

const saved = uploads.saveTheme(acct.id, {
  name: 'My table', feltImageUrl: stored.upload.url, feltColor: '#123456', railColor: '#654321',
});
check('theme saved', saved.ok === true);
check('theme keeps the felt image', saved.theme.feltImage === stored.upload.url);
check('theme becomes the default', uploads.defaultTheme(acct.id)?.feltColor === '#123456');

const badColors = uploads.saveTheme(acct.id, {
  name: 'Bad', feltColor: 'red; background: url(evil)', railColor: 'javascript:alert(1)',
});
check('non-hex colours are dropped', badColors.theme.feltColor === null && badColors.theme.railColor === null);

const badImage = uploads.saveTheme(acct.id, { name: 'Remote', feltImageUrl: 'https://evil.example/x.png' });
check('off-site image urls are dropped', badImage.theme.feltImage === null);

// Saving the same name updates rather than duplicating.
uploads.saveTheme(acct.id, { name: 'My table', feltColor: '#abcdef' });
check('re-saving a theme name updates it', uploads.listThemes(acct.id).filter((t) => t.name === 'My table').length === 1);

// ---- settings sanitisation is the second line of defence ----

check('settings drop a remote theme image', sanitizeSettings({
  tableTheme: { feltImage: 'https://evil.example/x.png' },
}).tableTheme === null);
check('settings drop a css-injection colour', sanitizeSettings({
  tableTheme: { feltColor: 'red;}#table{display:none' },
}).tableTheme === null);
check('settings keep a valid theme', sanitizeSettings({
  tableTheme: { feltImage: stored.upload.url, feltColor: '#1f6b43', railColor: '#3b2a1e' },
}).tableTheme.feltColor === '#1f6b43');
check('settings default to no theme', sanitizeSettings({}).tableTheme === null);

// ---- soundboard ----

const clip = uploads.storeUpload({ buffer: OGG, accountId: acct.id, wantKind: 'audio', originalName: 'groan.ogg' });
check('sound clip saved to a slot', uploads.saveSoundClip(acct.id, 'cooler', clip.upload).ok === true);
check('slot lists the clip', uploads.listSoundClips(acct.id).cooler?.url === clip.upload.url);
check('unknown slot rejected', uploads.saveSoundClip(acct.id, 'notATrigger', clip.upload).ok === false);
check('an image cannot be a sound', uploads.saveSoundClip(acct.id, 'win', stored.upload).ok === false);
uploads.deleteSoundClip(acct.id, 'cooler');
check('slot cleared', uploads.listSoundClips(acct.id).cooler === undefined);

closeDb();
rmSync(dir, { recursive: true, force: true });

console.log(`uploads: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
