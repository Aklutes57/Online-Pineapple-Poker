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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

export function buildServer() {
  const app = express();
  app.use(express.json());
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use(express.static(path.join(root, 'public')));

  app.post('/api/games', (req, res) => {
    const { nickname, settings } = req.body || {};
    const nick = typeof nickname === 'string' ? nickname.trim().slice(0, SETTINGS_LIMITS.nickname.max) : '';
    if (!nick) {
      res.status(400).json({ error: 'nickname required' });
      return;
    }
    const { game, host } = createGame(settings || {}, nick);
    res.json({ gameId: game.id, token: host.token, playerId: host.id });
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

  const httpServer = createServer(app);
  const io = new Server(httpServer, { serveClient: true });
  attachSockets(io);
  startIdleSweep();

  return { app, httpServer, io };
}
