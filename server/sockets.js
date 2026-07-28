// Socket.IO protocol boundary: token auth, input validation, host checks,
// and tailored per-socket state broadcasts.

import { EVENTS, ERRORS, SETTINGS_LIMITS } from '../shared/constants.js';
import { buildViews } from './views.js';
import { getGame, destroyGame } from './gameManager.js';
import { accountForToken } from './accounts.js';

const socketsByGame = new Map(); // gameId -> Set<socket>

export function broadcast(game) {
  const sockets = socketsByGame.get(game.id);
  if (!sockets || sockets.size === 0) {
    game.seq++;
    return;
  }
  const { pub, forPlayer } = buildViews(game);
  for (const socket of sockets) {
    const { playerId } = socket.data;
    socket.emit(EVENTS.STATE, { ...pub, you: forPlayer(playerId) });
  }
}

function sendError(socket, code, message) {
  socket.emit(EVENTS.ERROR_MSG, { code, message });
}

function cleanNickname(raw) {
  if (typeof raw !== 'string') return null;
  const nick = raw.trim().replace(/\s+/g, ' ').slice(0, SETTINGS_LIMITS.nickname.max);
  return nick.length >= SETTINGS_LIMITS.nickname.min ? nick : null;
}

// Clients control event payloads entirely — a null/string/array payload must
// not be able to throw inside a handler and take the process down.
function asObject(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

const MAX_PLAYERS_PER_GAME = 60;

// Undo a socket's current player/game binding (used on disconnect and when a
// socket re-JOINs, so stale bindings can't pin `connected=true` forever).
function detachSocket(socket) {
  const { gameId, playerId } = socket.data;
  if (!gameId) return null;
  const sockets = socketsByGame.get(gameId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) socketsByGame.delete(gameId);
  }
  const game = getGame(gameId);
  const player = game?.players.get(playerId);
  socket.data.gameId = null;
  socket.data.playerId = null;
  if (!game || !player) return null;
  player.sockets.delete(socket.id);
  if (player.sockets.size === 0) {
    player.connected = false;
    game.noteDisconnect(player);
  }
  return game;
}

export function attachSockets(io) {
  io.on('connection', (socket) => {
    socket.data = { gameId: null, playerId: null };

    socket.on(EVENTS.JOIN, (payload, ack) => {
      if (typeof ack !== 'function') return;
      const { gameId, token, nickname, accountToken } = asObject(payload);
      const game = getGame(typeof gameId === 'string' ? gameId : '');
      if (!game || game.closed) {
        ack({ ok: false, error: ERRORS.GAME_NOT_FOUND });
        return;
      }
      game.touch();

      // A re-JOIN on a bound socket must release the old binding first.
      detachSocket(socket);

      // Accounts are optional — a missing or bad token just means "guest".
      let account = null;
      try {
        account = accountForToken(accountToken);
      } catch {
        account = null;
      }

      let player = typeof token === 'string' ? game.playerByToken(token) : null;
      if (!player) {
        if (game.players.size >= MAX_PLAYERS_PER_GAME) {
          ack({ ok: false, error: ERRORS.GAME_NOT_FOUND });
          return;
        }
        const nick =
          cleanNickname(nickname) ||
          cleanNickname(account?.displayName) ||
          `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
        player = game.addPlayer(nick, account?.id ?? null);
      } else if (account && !player.accountId) {
        // Signed in after joining as a guest — adopt the account.
        player.accountId = account.id;
      }
      if (account) player.accountName = account.displayName;

      // Bind this socket to the player (multiple tabs allowed).
      socket.data.gameId = game.id;
      socket.data.playerId = player.id;
      player.sockets.add(socket.id);
      player.connected = true;
      player.disconnectedAt = null;

      // A reconnecting current actor gets their turn timer re-evaluated
      // (restores the "no timer" state when the action clock is off).
      const hand = game.currentHand;
      if (hand && !hand.finished && hand.isBettingPhase() && hand.toActSeat === player.seatIndex) {
        hand.beginTurn();
      }

      if (!socketsByGame.has(game.id)) socketsByGame.set(game.id, new Set());
      socketsByGame.get(game.id).add(socket);

      if (!game.onChanged) game.onChanged = () => broadcast(game);
      if (!game.onClosed) {
        game.onClosed = (reason) => {
          const sockets = socketsByGame.get(game.id);
          if (sockets) {
            for (const s of sockets) s.emit(EVENTS.TABLE_CLOSED, { reason });
          }
          socketsByGame.delete(game.id);
          destroyGame(game.id);
        };
      }

      const { pub, forPlayer } = buildViews(game);
      ack({ ok: true, token: player.token, playerId: player.id, state: { ...pub, you: forPlayer(player.id) } });
      broadcast(game);
    });

    // Every other event requires a bound player. Payloads are normalized and
    // handler errors are contained per-event — a bad message from one client
    // must never crash the process and take every table with it.
    function withGame(handler) {
      return (rawPayload) => {
        const game = getGame(socket.data.gameId || '');
        const player = game && game.players.get(socket.data.playerId);
        if (!game || !player) {
          sendError(socket, ERRORS.NOT_JOINED, 'Join the game first');
          return;
        }
        if (game.closed) return;
        game.touch();
        try {
          handler(game, player, asObject(rawPayload));
        } catch (err) {
          sendError(socket, ERRORS.BAD_REQUEST, 'Something went wrong');
          game.recoverFromError(err);
        }
      };
    }

    function withHost(handler) {
      return withGame((game, player, payload) => {
        if (!game.isHost(player)) {
          sendError(socket, ERRORS.NOT_HOST, 'Only the host can do that');
          return;
        }
        handler(game, player, payload);
      });
    }

    function result(game, r, code = ERRORS.BAD_REQUEST) {
      if (!r.ok) {
        sendError(socket, code, r.error);
      } else {
        broadcast(game);
      }
    }

    socket.on(EVENTS.REQUEST_SEAT, withGame((game, player, payload) => {
      const nick = cleanNickname(payload.nickname);
      if (nick && player.status !== 'seated' && !game.nicknameTaken(nick)) {
        player.nickname = nick;
      }
      const seatIndex = payload.seatIndex === undefined || payload.seatIndex === null
        ? null
        : payload.seatIndex;
      result(game, game.requestSeat(player, payload.buyIn, seatIndex), ERRORS.SEAT_TAKEN);
    }));

    socket.on(EVENTS.CANCEL_SEAT_REQUEST, withGame((game, player) => {
      result(game, game.cancelSeatRequest(player));
    }));

    socket.on(EVENTS.ACTION, withGame((game, player, payload) => {
      const hand = game.currentHand;
      if (!hand || hand.finished || payload.handId !== hand.handId) {
        sendError(socket, ERRORS.BAD_ACTION, 'That hand is over');
        return;
      }
      if (!game.playerInLiveHand(player)) {
        sendError(socket, ERRORS.BAD_ACTION, 'You are not in this hand');
        return;
      }
      const action = payload.action;
      if (!['fold', 'check', 'call', 'bet', 'raise'].includes(action)) {
        sendError(socket, ERRORS.BAD_ACTION, 'Unknown action');
        return;
      }
      if (player.seatIndex !== hand.toActSeat) {
        sendError(socket, ERRORS.NOT_YOUR_TURN, 'Not your turn');
        return;
      }
      const amount = payload.amount === undefined || payload.amount === null ? null : payload.amount;
      const r = hand.handleAction(player, action, amount);
      result(game, r, ERRORS.BAD_AMOUNT);
    }));

    socket.on(EVENTS.DISCARD, withGame((game, player, payload) => {
      const hand = game.currentHand;
      if (!hand || payload.handId !== hand.handId || !game.playerInLiveHand(player)) {
        sendError(socket, ERRORS.BAD_ACTION, 'No discard right now');
        return;
      }
      result(game, hand.handleDiscard(player, payload.cardIndex), ERRORS.BAD_ACTION);
    }));

    socket.on(EVENTS.SHOW_CARDS, withGame((game, player, payload) => {
      const hand = game.currentHand;
      if (!hand || payload.handId !== hand.handId) return;
      result(game, hand.handleShowCards(player));
    }));

    socket.on(EVENTS.SIT_OUT, withGame((game, player) => {
      result(game, game.sitOut(player));
    }));

    socket.on(EVENTS.SIT_IN, withGame((game, player) => {
      result(game, game.sitIn(player));
    }));

    socket.on(EVENTS.STAND_UP, withGame((game, player) => {
      result(game, game.removeFromSeat(player, 'leave'));
    }));

    socket.on(EVENTS.CHAT, withGame((game, player, payload) => {
      const r = game.addChat(player, payload.text);
      if (!r.ok) {
        sendError(socket, ERRORS.RATE_LIMITED, r.error);
        return;
      }
      const sockets = socketsByGame.get(game.id);
      if (sockets) {
        for (const s of sockets) s.emit(EVENTS.CHAT_MSG, r.msg);
      }
    }));

    // ---- host controls ----

    socket.on(EVENTS.HOST_APPROVE_SEAT, withHost((game, _player, payload) => {
      result(game, game.approveSeat(payload.playerId, !!payload.approve));
    }));

    socket.on(EVENTS.HOST_START_GAME, withHost((game, player) => {
      result(game, game.startGame(player));
    }));

    socket.on(EVENTS.HOST_PAUSE, withHost((game, _player, payload) => {
      result(game, game.setPaused(!!payload.paused));
    }));

    socket.on(EVENTS.HOST_KICK, withHost((game, _player, payload) => {
      const target = game.players.get(payload.playerId);
      if (!target) {
        sendError(socket, ERRORS.BAD_REQUEST, 'No such player');
        return;
      }
      result(game, game.removeFromSeat(target, 'kick'));
    }));

    socket.on(EVENTS.HOST_ADJUST_STACK, withHost((game, _player, payload) => {
      result(game, game.adjustStack(payload.playerId, payload.delta));
    }));

    socket.on(EVENTS.HOST_UPDATE_SETTINGS, withHost((game, _player, payload) => {
      result(game, game.updateSettings(payload || {}));
    }));

    socket.on(EVENTS.HOST_CLOSE_TABLE, withHost((game) => {
      game.addLog('The host closed the table');
      game.close('host');
    }));

    socket.on('disconnect', () => {
      const game = detachSocket(socket);
      if (game && !game.closed) broadcast(game);
    });
  });
}
