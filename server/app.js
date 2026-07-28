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
  updateDisplayName, updatePrefs, purgeExpiredSessions,
} from './accounts.js';
import { accountSummary } from './stats.js';
import {
  storeUpload, getUploadBySha, uploadPath, saveTheme, listThemes, deleteTheme,
  saveSoundClip, listSoundClips, deleteSoundClip, defaultTheme, LIMITS as UPLOAD_LIMITS,
} from './uploads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Coarse per-IP limiter for the auth endpoints — enough to stop credential
// stuffing from a script without any new dependency.
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const nowMs = Date.now();
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

export function buildServer() {
  initDb();
  purgeExpiredSessions();

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use(express.static(path.join(root, 'public')));

  // ---- accounts (optional: everything below still works signed out) ----

  const authLimiter = makeRateLimiter({ windowMs: 60_000, max: 20 });

  app.post('/api/auth/signup', authLimiter, (req, res) => {
    const result = createAccount(req.body || {});
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ token: result.token, account: result.account });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const result = login(req.body || {});
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

  app.get('/api/me/summary', (req, res) => {
    const account = accountForRequest(req);
    if (!account) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.json(accountSummary(account.id));
  });

  app.post('/api/games', (req, res) => {
    const { nickname, settings } = req.body || {};
    const account = accountForRequest(req);
    const rawNick = typeof nickname === 'string' && nickname.trim()
      ? nickname
      : account?.displayName || '';
    const nick = rawNick.trim().slice(0, SETTINGS_LIMITS.nickname.max);
    if (!nick) {
      res.status(400).json({ error: 'nickname required' });
      return;
    }
    // A signed-in host's saved table look follows them to every game.
    const theme = account ? defaultTheme(account.id) : null;
    const withTheme = theme
      ? { ...(settings || {}), tableTheme: {
          feltImage: theme.feltImage, feltColor: theme.feltColor, railColor: theme.railColor,
        } }
      : settings || {};
    const created = createGame(withTheme, nick, account?.id ?? null);
    if (!created) {
      res.status(503).json({ error: 'server is full — try again later' });
      return;
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

  const httpServer = createServer(app);
  const io = new Server(httpServer, { serveClient: true });
  attachSockets(io);
  startIdleSweep();

  return { app, httpServer, io };
}
