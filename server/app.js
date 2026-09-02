// Builds the express app + socket.io server without listening, so tests can
// boot the real stack on an ephemeral port.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { createGame, getGame, startIdleSweep } from './gameManager.js';
import { attachSockets } from './sockets.js';
import { SETTINGS_LIMITS } from '../shared/constants.js';
import { initDb } from './db.js';
import {
  createAccount, login, logout, accountForRequest, tokenFromRequest,
  updateDisplayName, updatePrefs, setPayments, setAvatar, purgeExpiredSessions,
} from './accounts.js';
import {
  accountSummary, ledgerCsvForGame, ledgerXlsxForGame, lastTableStacks, runningTotals,
  hostLedgersFor, canSeeLedger, recordSettlePayment, deleteSettlePayment,
} from './stats.js';
import {
  storeUpload, getUploadBySha, uploadPath, saveTheme, listThemes, deleteTheme,
  saveSoundClip, listSoundClips, deleteSoundClip, defaultTheme, LIMITS as UPLOAD_LIMITS,
} from './uploads.js';
import {
  addContact, listContacts, setContactAutoSend, removeContact, unsubscribeByToken,
  addNotifyTarget, listNotifyTargets, removeNotifyTarget, announceTable,
  emailConfigured, recentDeliveries,
} from './notify.js';
import { VARIANTS, REACTIONS } from '../shared/constants.js';
import { getHand, recentHandsForGame, addHandReaction } from './handStore.js';
import { ensureVapid, saveSubscription, deleteSubscription } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Coarse per-IP limiter for the auth endpoints — enough to stop credential
// stuffing from a script without any new dependency. Entries are swept lazily
// on access, so the map can't grow without bound from one-shot attackers.
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const nowMs = Date.now();
    // Opportunistic sweep: once the map is large, drop everything expired so a
    // flood of distinct source IPs can't grow it forever.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (nowMs > v.resetAt) hits.delete(k);
    }
    const entry = hits.get(key);
    if (!entry || nowMs > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + windowMs });
      next();
      return;
    }
    entry.count++;
    if (entry.count > max) {
      res.status(429).json({ error: 'Too many attempts — wait a minute and try again' });
      return;
    }
    next();
  };
}

// Response headers applied to every response. These are the app's outer shell
// against an outside attacker: a strict Content-Security-Policy neutralises
// injected markup (nothing runs but our own same-origin modules), and the
// framing/sniffing/referrer headers close off clickjacking, MIME confusion,
// and URL leakage. The /uploads route replaces the CSP with an even stricter
// sandbox of its own — this is only the default for our first-party pages.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Video thumbnails for the table's music queue come off YouTube's image CDN.
  "img-src 'self' data: blob: https://i.ytimg.com",
  // Inline style attributes are used throughout the table layout; they can't
  // execute script, so 'unsafe-inline' here is low-risk. Scripts stay strict.
  "style-src 'self' 'unsafe-inline'",
  // The table's music is the official YouTube IFrame Player API, which is the
  // only sanctioned way to play YouTube in a page. That needs its loader
  // (www.youtube.com) and the player bundle it pulls in (s.ytimg.com). These
  // are the ONLY third-party script origins on the site; everything we wrote
  // is still same-origin, and there is no 'unsafe-inline' or 'unsafe-eval'.
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  // …and the player itself is an <iframe>, which needs its own directive.
  // Nothing else may be framed, and we are still un-frameable ourselves.
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  // Same-origin covers the Socket.IO wss upgrade and every /api fetch.
  "connect-src 'self'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

// WebRTC ICE servers: public STUN by default (enough for many home networks),
// plus a TURN relay if one is configured — TURN is what makes the peer-to-peer
// connection reliable across restrictive networks. Media is always P2P; these
// only help the two browsers find each other.
export function rtcIceServers() {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

// connect-src additions for WebRTC. CSP only accepts scheme-sources here (a
// full stun:host:port is rejected as invalid), so we allow the stun/turn
// schemes wholesale — that's what browsers which gate ICE on CSP look for.
// Media itself (via srcObject) isn't URL-loaded, so needs no media-src entry.
function iceConnectSrc() {
  return 'stun: turn: turns:';
}

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP.replace("connect-src 'self'", `connect-src 'self' ${iceConnectSrc()}`),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Camera + mic are allowed for our own origin (the in-app video/voice);
    // geolocation and payment stay off.
    'Permissions-Policy': 'geolocation=(), camera=(self), microphone=(self), payment=()',
  });
  next();
}

// A Socket.IO connection is a websocket a page opens back to us. A browser
// stamps every one with an Origin header, so we can refuse sockets opened from
// any site other than the one serving the game — no other website can drive a
// visitor's browser into our tables. Self-configuring: an Origin whose host
// matches the request Host is always allowed (works on localhost, the Fly
// hostname, or any custom domain), plus anything in ALLOWED_ORIGINS. Requests
// with no Origin (native clients, same-origin navigations) are allowed too —
// they carry no ambient credentials to abuse.
function makeAllowRequest() {
  const extra = new Set(
    (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) {
      callback(null, true);
      return;
    }
    if (extra.has(origin)) {
      callback(null, true);
      return;
    }
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    callback(null, host !== null && host === req.headers.host);
  };
}

export function buildServer() {
  initDb();
  purgeExpiredSessions();

  const app = express();
  // Behind a reverse proxy (Fly, Caddy, nginx) this keeps req.protocol
  // https for invite links and req.ip per-visitor for the rate limiter.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use(express.static(path.join(root, 'public')));

  // Per-IP ceilings on the unauthenticated write endpoints. A guest hitting
  // these at a human pace never notices; a script trying to exhaust game slots,
  // flood the push table, or spam replay reactions is capped.
  const createGameLimiter = makeRateLimiter({ windowMs: 60_000, max: 20 });
  const pushLimiter = makeRateLimiter({ windowMs: 60_000, max: 30 });
  const reactionLimiter = makeRateLimiter({ windowMs: 60_000, max: 60 });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  // ---- web push ----

  app.get('/api/push/vapid-key', (req, res) => {
    res.json({ key: ensureVapid().publicKey });
  });

  // ICE servers for the in-app voice/video (WebRTC).
  app.get('/api/rtc-config', (req, res) => {
    res.json({ iceServers: rtcIceServers() });
  });

  app.post('/api/push/subscribe', pushLimiter, (req, res) => {
    const account = accountForRequest(req);
    const { endpoint, keys } = req.body || {};
    const result = saveSubscription({ endpoint, keys }, account?.id ?? null);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    deleteSubscription((req.body || {}).endpoint);
    res.json({ ok: true });
  });

  // ---- accounts (optional: everything below still works signed out) ----

  const authLimiter = makeRateLimiter({ windowMs: 60_000, max: 20 });

  app.post('/api/auth/signup', authLimiter, (req, res) => {
    const body = req.body || {};
    const result = createAccount({ ...body, remember: body.remember !== false });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ token: result.token, account: result.account });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const body = req.body || {};
    const result = login({ ...body, remember: body.remember !== false });
    if (!result.ok) {
      res.status(401).json({ error: result.error });
      return;
    }
    res.json({ token: result.token, account: result.account });
  });

  app.post('/api/auth/logout', (req, res) => {
    logout(tokenFromRequest(req));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json({ account });
  });

  app.patch('/api/auth/me', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const { displayName, prefs } = req.body || {};
    if (displayName !== undefined) {
      const result = updateDisplayName(account.id, displayName);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
    }
    if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) {
      updatePrefs(account.id, prefs);
    }
    res.json({ account: accountForRequest(req) });
  });

  // ---- uploads, themes, soundboard ----

  // Path-scoped raw parser so it never swallows JSON bodies elsewhere.
  const rawUpload = express.raw({
    type: () => true,
    limit: Math.max(UPLOAD_LIMITS.image, UPLOAD_LIMITS.audio),
  });

  app.post('/api/uploads', rawUpload, (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'Sign in to upload' });
      return;
    }
    const wantKind = req.query.kind === 'audio' ? 'audio' : 'image';
    const result = storeUpload({
      buffer: req.body,
      accountId: account.id,
      wantKind,
      originalName: typeof req.query.name === 'string' ? req.query.name : null,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ upload: result.upload });
  });

  // Uploaded bytes are user-controlled and served from the same origin as
  // session tokens, so the type comes from our own sniffing and the response
  // is locked down against being interpreted as anything active.
  app.get('/uploads/:file', (req, res) => {
    const sha = String(req.params.file).split('.')[0];
    const upload = getUploadBySha(sha);
    if (!upload) {
      res.status(404).end();
      return;
    }
    res.set({
      'Content-Type': upload.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.sendFile(uploadPath(upload));
  });

  // Anyone AT a table can put a picture on the felt, or set the frame around
  // their own webcam — including guests, who have no account to upload
  // through. Authorised by the per-game player token the browser already
  // holds, so it is participants-only rather than open to the world.
  function playerFromToken(req) {
    const game = getGame(req.params.id);
    if (!game || game.closed) return {};
    const token = req.get('x-player-token') || req.query.token;
    const player = typeof token === 'string' ? game.playerByToken(token) : null;
    return { game, player };
  }

  const tableImageLimiter = makeRateLimiter({ windowMs: 60_000, max: 20 });

  app.post('/api/games/:id/table-image', tableImageLimiter, rawUpload, (req, res) => {
    const { game, player } = playerFromToken(req);
    if (!game || !player) {
      res.status(403).json({ error: 'Join the table first' });
      return;
    }
    const stored = storeUpload({
      buffer: req.body,
      accountId: player.accountId ?? null,
      wantKind: 'image',
      originalName: typeof req.query.name === 'string' ? req.query.name : null,
    });
    if (!stored.ok) {
      res.status(400).json({ error: stored.error });
      return;
    }
    const result = game.setTableImage(player, stored.upload.url);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, url: stored.upload.url });
  });

  app.post('/api/games/:id/cam-frame', tableImageLimiter, rawUpload, (req, res) => {
    const { game, player } = playerFromToken(req);
    if (!game || !player) {
      res.status(403).json({ error: 'Join the table first' });
      return;
    }
    const stored = storeUpload({
      buffer: req.body,
      accountId: player.accountId ?? null,
      wantKind: 'image',
      originalName: typeof req.query.name === 'string' ? req.query.name : null,
    });
    if (!stored.ok) {
      res.status(400).json({ error: stored.error });
      return;
    }
    player.camFrame = stored.upload.url;
    game.addLog(`${player.nickname} set a new webcam frame`);
    game.emitChanged();
    res.json({ ok: true, url: stored.upload.url });
  });

  // A profile picture, uploaded from the table so guests get one too. When the
  // player is signed in it is also written to their account, so it follows
  // them to every future table without being uploaded again.
  app.post('/api/games/:id/avatar', tableImageLimiter, rawUpload, (req, res) => {
    const { game, player } = playerFromToken(req);
    if (!game || !player) {
      res.status(403).json({ error: 'Join the table first' });
      return;
    }
    const stored = storeUpload({
      buffer: req.body,
      accountId: player.accountId ?? null,
      wantKind: 'image',
      originalName: typeof req.query.name === 'string' ? req.query.name : null,
    });
    if (!stored.ok) {
      res.status(400).json({ error: stored.error });
      return;
    }
    const result = game.setAvatar(player, stored.upload.url);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    if (player.accountId) setAvatar(player.accountId, stored.upload.url);
    res.json({ ok: true, url: stored.upload.url });
  });

  // Setting the picture from the profile page: the bytes went to /api/uploads
  // first, so this only records which upload is the account's avatar.
  app.put('/api/me/avatar', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const url = req.body?.url;
    const result = setAvatar(account.id, url === null ? null : url);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, avatarUrl: result.avatarUrl });
  });

  app.get('/api/me/theme', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json({ themes: listThemes(account.id), sounds: listSoundClips(account.id) });
  });

  app.post('/api/me/theme', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(saveTheme(account.id, req.body || {}));
  });

  app.delete('/api/me/theme/:id', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    deleteTheme(account.id, Number(req.params.id));
    res.json({ themes: listThemes(account.id) });
  });

  app.post('/api/me/sounds/:trigger', rawUpload, (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'Sign in to upload sounds' });
      return;
    }
    const stored = storeUpload({
      buffer: req.body,
      accountId: account.id,
      wantKind: 'audio',
      originalName: typeof req.query.name === 'string' ? req.query.name : null,
    });
    if (!stored.ok) {
      res.status(400).json({ error: stored.error });
      return;
    }
    const result = saveSoundClip(account.id, req.params.trigger, stored.upload);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ clips: result.clips });
  });

  app.delete('/api/me/sounds/:trigger', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(deleteSoundClip(account.id, req.params.trigger));
  });

  // ---- invite lists and Discord ----

  app.get('/api/me/notify', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json({
      contacts: listContacts(account.id),
      targets: listNotifyTargets(account.id),
      emailConfigured: emailConfigured(),
      recent: recentDeliveries(10),
    });
  });

  app.post('/api/me/contacts', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const { email: address, label } = req.body || {};
    const result = addContact(account.id, address, label);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.patch('/api/me/contacts/:id', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(setContactAutoSend(account.id, Number(req.params.id), !!(req.body || {}).autoSend));
  });

  app.delete('/api/me/contacts/:id', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(removeContact(account.id, Number(req.params.id)));
  });

  app.post('/api/me/targets', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const { kind, value, label } = req.body || {};
    const result = addNotifyTarget(account.id, kind, value, label);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.delete('/api/me/targets/:id', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(removeNotifyTarget(account.id, Number(req.params.id)));
  });

  app.get('/unsubscribe/:token', (req, res) => {
    const result = unsubscribeByToken(req.params.token);
    res.type('html').send(
      `<body style="font-family:system-ui;background:#10131c;color:#e8ebf4;padding:60px;text-align:center">
        <h1>${result.ok ? 'Unsubscribed' : 'Link not recognised'}</h1>
        <p style="color:#9aa3ba">${
          result.ok
            ? 'You will not get any more table invites from this list.'
            : 'That unsubscribe link is no longer valid.'
        }</p>
        <a href="/" style="color:#f5c542">Back to Reg-Poker Online</a>
      </body>`
    );
  });

  // The stacks the host's last table finished with, so the create form can
  // offer to pick up where it left off. Signed-in only, because that is the
  // only identity that survives between tables.
  app.get('/api/me/last-table', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json({ lastTable: lastTableStacks(account.id) });
  });

  // The running tabs this account is part of. A tab belongs to a host, so the
  // profile page lists them and asks which one before showing any numbers.
  app.get('/api/me/ledgers', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json({ ledgers: hostLedgersFor(account.id), accountId: account.id });
  });

  // One host's running tab, read from the profile rather than from a seat.
  // Gated on having actually played there: this spans nights, so a table link
  // is not standing to see it.
  app.get('/api/me/ledgers/:hostId/running', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const hostId = Number(req.params.hostId);
    if (!canSeeLedger(hostId, account.id)) {
      res.status(403).json({ error: 'You have not played a finished night at those tables' });
      return;
    }
    res.json({ running: runningTotals(hostId), accountId: account.id });
  });

  // Marking money off the tab. The server decides who is allowed to say a debt
  // was paid — the payer, the payee, or the host who keeps the tab.
  app.post('/api/me/ledgers/:hostId/payments', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const { fromAccountId, toAccountId, amount, note } = req.body || {};
    const result = recordSettlePayment({
      hostAccountId: Number(req.params.hostId),
      fromAccountId, toAccountId, amount, note,
      recordedBy: account.id,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({ ...result, running: runningTotals(Number(req.params.hostId)) });
  });

  app.delete('/api/me/settle-payments/:id', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const result = deleteSettlePayment(Number(req.params.id), account.id);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({ ...result, running: runningTotals(result.hostAccountId) });
  });

  app.get('/api/me/summary', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(accountSummary(account.id));
  });

  // Linked P2P payment handles, so table-mates can pay from the ledger.
  app.put('/api/me/payments', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    const { payments, errors } = setPayments(account.id, (req.body || {}).payments || {});
    res.json({ payments, errors });
  });

  // The game's ledger as a dated CSV, generated from the persisted results so
  // it survives the game ending, a lost screenshot, even a server restart.
  // Unauthenticated by game id, like the hand replays — anyone with the table
  // link can pull the record afterward.
  app.get('/api/games/:id/ledger.csv', (req, res) => {
    const csv = ledgerCsvForGame(req.params.id);
    if (!csv) {
      res.status(404).json({ error: 'no ledger for that game yet' });
      return;
    }
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csv.filename}"`,
    });
    res.send(csv.body);
  });

  // The same ledger as a colour-coded spreadsheet. A .csv cannot carry a fill,
  // so "highlight the winners green" needs a real workbook.
  app.get('/api/games/:id/ledger.xlsx', (req, res) => {
    const book = ledgerXlsxForGame(req.params.id);
    if (!book) {
      res.status(404).json({ error: 'no ledger for that game yet' });
      return;
    }
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${book.filename}"`,
    });
    res.send(Buffer.from(book.body));
  });

  // The running tab across every night this host has run. Gated on actually
  // being at the table, unlike the single-session ledger: that one is the
  // record of an evening you were present for, this one spans nights a
  // stranger holding a link was never at.
  app.get('/api/games/:id/running', (req, res) => {
    const { game, player } = playerFromToken(req);
    if (!game || !player) {
      res.status(403).json({ error: 'Join the table first' });
      return;
    }
    if (!game.hostAccountId) {
      res.json({ running: null, reason: 'This table has no signed-in host, so there is nothing to carry between nights.' });
      return;
    }
    res.json({ running: runningTotals(game.hostAccountId) });
  });

  app.post('/api/games', createGameLimiter, (req, res) => {
    const { nickname, settings } = req.body || {};
    const account = accountForRequest(req);
    // Hosting needs an account, like playing does. The host is the one the
    // night's ledger belongs to, the one the running total is kept for, and
    // the one the .csv is mailed to when the table closes — none of which has
    // anywhere to go without one.
    if (!account) {
      res.status(401).json({ error: 'Sign in to start a table' });
      return;
    }
    const rawNick = typeof nickname === 'string' && nickname.trim()
      ? nickname
      : account.displayName || '';
    const nick = rawNick.trim().slice(0, SETTINGS_LIMITS.nickname.max);
    if (!nick) {
      res.status(400).json({ error: 'nickname required' });
      return;
    }
    // A signed-in host's saved table look follows them to every game.
    const theme = defaultTheme(account.id);
    const withTheme = theme
      ? { ...(settings || {}), tableTheme: {
          feltImage: theme.feltImage, feltColor: theme.feltColor, railColor: theme.railColor,
        } }
      : settings || {};
    const created = createGame(withTheme, nick, account.id);
    if (!created) {
      res.status(503).json({ error: 'server is full — try again later' });
      return;
    }
    // Where this table lives, so the ledger emailed when it closes can link
    // back to the saved copy. Recorded now because a table can close from the
    // idle sweep, with no request to take an origin from.
    created.game.origin = `${req.protocol}://${req.get('host')}`;
    // Continue from the host's last table. Read here rather than trusted from
    // the client: the browser says whether to carry over, never how much.
    if ((req.body || {}).carryStacks === true) {
      const last = lastTableStacks(account.id);
      const n = last ? created.game.setCarryStacks(last.players) : 0;
      if (n > 0) {
        created.game.addLog(`Carrying stacks over from the last table for ${n} player${n === 1 ? '' : 's'}`);
      }
    }
    // Fire the host's saved invite list. Deliberately not awaited: a slow
    // mail server must never delay handing back the table link.
    if ((req.body || {}).announce !== false) {
      const s = created.game.settings;
      const origin = `${req.protocol}://${req.get('host')}`;
      announceTable(account.id, {
        gameId: created.game.id,
        variantLabel: VARIANTS[s.variant]?.label || s.variant,
        blinds: `${s.smallBlind}/${s.bigBlind}`,
        link: `${origin}/games/${created.game.id}`,
        hostName: nick,
      }).catch(() => {});
    }

    res.json({ gameId: created.game.id, token: created.host.token, playerId: created.host.id });
  });

  app.get('/api/games/:id', (req, res) => {
    const game = getGame(req.params.id);
    if (!game || game.closed) {
      res.status(404).json({ exists: false });
      return;
    }
    res.json({
      exists: true,
      variant: game.settings.variant,
      smallBlind: game.settings.smallBlind,
      bigBlind: game.settings.bigBlind,
      minBuyIn: game.settings.minBuyIn,
      maxBuyIn: game.settings.maxBuyIn,
      defaultBuyIn: game.settings.defaultBuyIn,
      playerCount: [...game.players.values()].filter((p) => p.status === 'seated').length,
    });
  });

  app.get('/games/:id', (req, res) => {
    const game = getGame(req.params.id);
    if (!game || game.closed) {
      res.redirect('/?error=notfound');
      return;
    }
    res.sendFile(path.join(root, 'public', 'game.html'));
  });

  app.get('/me', (req, res) => {
    res.sendFile(path.join(root, 'public', 'me.html'));
  });

  // ---- hand replays ----

  app.get('/api/hands/:id', (req, res) => {
    const account = accountForRequest(req);
    const hand = getHand(req.params.id, account?.id ?? null);
    if (!hand) {
      res.status(404).json({ error: 'no such hand' });
      return;
    }
    res.json({ hand });
  });

  app.get('/api/games/:id/hands', (req, res) => {
    res.json({ hands: recentHandsForGame(req.params.id, 25) });
  });

  app.post('/api/hands/:id/reactions', reactionLimiter, (req, res) => {
    const account = accountForRequest(req);
    const { emoji, nickname } = req.body || {};
    if (!REACTIONS.includes(emoji)) {
      res.status(400).json({ error: 'Unknown reaction' });
      return;
    }
    const who = account?.displayName
      || (typeof nickname === 'string' ? nickname.trim().slice(0, 20) : '')
      || 'Guest';
    const result = addHandReaction(req.params.id, { emoji, accountId: account?.id ?? null, nickname: who });
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json({ reactions: result.reactions });
  });

  app.get('/hands/:id', (req, res) => {
    res.sendFile(path.join(root, 'public', 'hand.html'));
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    serveClient: true,
    // Reject sockets opened from any origin other than the one serving the app.
    allowRequest: makeAllowRequest(),
    // Socket.IO's own CORS: never echo an allow-origin for a foreign site.
    cors: { origin: false },
    // A single frame is bounded so an oversized payload can't spike memory.
    maxHttpBufferSize: 1e5,
  });
  attachSockets(io);
  startIdleSweep();

  return { app, httpServer, io };
}
