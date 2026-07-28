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
import {
  addContact, listContacts, setContactAutoSend, removeContact, unsubscribeByToken,
  addNotifyTarget, listNotifyTargets, removeNotifyTarget, announceTable,
  emailConfigured, recentDeliveries,
} from './notify.js';
import { VARIANTS, REACTIONS } from '../shared/constants.js';
import { getHand, recentHandsForGame, addHandReaction } from './handStore.js';

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
        <h1>🍍 ${result.ok ? 'Unsubscribed' : 'Link not recognised'}</h1>
        <p style="color:#9aa3ba">${
          result.ok
            ? 'You will not get any more table invites from this list.'
            : 'That unsubscribe link is no longer valid.'
        }</p>
        <a href="/" style="color:#f5c542">Back to Pineapple Poker</a>
      </body>`
    );
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
    // Fire the host's saved invite list. Deliberately not awaited: a slow
    // mail server must never delay handing back the table link.
    if (account && (req.body || {}).announce !== false) {
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

  app.post('/api/hands/:id/reactions', (req, res) => {
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
  const io = new Server(httpServer, { serveClient: true });
  attachSockets(io);
  startIdleSweep();

  return { app, httpServer, io };
}
