import { randomBytes } from 'node:crypto';
import { Game } from './game.js';

const games = new Map();

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function newGameId() {
  let id;
  do {
    const bytes = randomBytes(10);
    id = [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
  } while (games.has(id));
  return id;
}

const MAX_GAMES = 500;

export function createGame(settings, hostNickname) {
  if (games.size >= MAX_GAMES) return null;
  const game = new Game(newGameId(), settings);
  const host = game.addPlayer(hostNickname);
  game.hostId = host.id;
  game.addLog(`${hostNickname} created the table`);
  games.set(game.id, game);
  // If the creator never opens the table, hostship must still be able to pass.
  game.armHostTransferCheck(120000);
  return { game, host };
}

export function getGame(id) {
  return games.get(id) || null;
}

export function destroyGame(id) {
  const game = games.get(id);
  if (!game) return;
  game.clearTimer();
  clearTimeout(game.hostTransferTimeout);
  games.delete(id);
}

export function allGames() {
  return games;
}

// Destroy tables nobody has touched in an hour with no one connected.
const IDLE_MS = 60 * 60 * 1000;
export function startIdleSweep() {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [id, game] of games) {
      game.pruneStalePlayers();
      const anyConnected = [...game.players.values()].some((p) => p.connected);
      if (!anyConnected && now - game.lastActivity > IDLE_MS) {
        game.close('idle');
        destroyGame(id);
      }
    }
  }, 5 * 60 * 1000);
  interval.unref();
  return interval;
}
