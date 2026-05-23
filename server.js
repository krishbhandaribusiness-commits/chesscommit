// ChessConnect Server
// - Express serves static client
// - WebSocket handles matchmaking, WebRTC signaling, chess move relay, chat
//
// Architecture:
//   client <--ws--> server
//   Server pairs two waiting clients into a "game", assigns colors randomly,
//   and acts purely as a relay. The authoritative chess state lives client-side
//   in chess.js (both clients independently validate moves). The server does
//   not verify move legality - peers trust each other within a session.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    waiting: waitingQueue.length,
    activeGames: games.size,
    connectedClients: clients.size,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== State =====
const clients = new Map();        // clientId -> { ws, gameId, name }
const waitingQueue = [];          // [clientId, ...] - FIFO queue of solo players
const games = new Map();          // gameId -> { p1, p2, color1, color2, startedAt }

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function send(clientId, message) {
  const c = clients.get(clientId);
  if (!c || c.ws.readyState !== 1) return false;
  try {
    c.ws.send(JSON.stringify(message));
    return true;
  } catch (e) {
    return false;
  }
}

function broadcastToGame(gameId, fromId, message) {
  const game = games.get(gameId);
  if (!game) return;
  const otherId = game.p1 === fromId ? game.p2 : game.p1;
  send(otherId, message);
}

function tryMatch() {
  // Pull pairs off the front of the queue, skipping any disconnected clients.
  while (waitingQueue.length >= 2) {
    const p1 = waitingQueue.shift();
    const p2 = waitingQueue.shift();
    const c1 = clients.get(p1);
    const c2 = clients.get(p2);

    if (!c1 || c1.ws.readyState !== 1) {
      // p1 disconnected - put p2 back at front and continue scanning
      if (c2 && c2.ws.readyState === 1) waitingQueue.unshift(p2);
      continue;
    }
    if (!c2 || c2.ws.readyState !== 1) {
      // p2 disconnected - put p1 back at front and continue scanning
      waitingQueue.unshift(p1);
      // remove p2 fully - it's already shifted out
      continue;
    }

    const gameId = newId();
    const p1IsWhite = Math.random() < 0.5;
    const color1 = p1IsWhite ? 'white' : 'black';
    const color2 = p1IsWhite ? 'black' : 'white';

    games.set(gameId, {
      p1, p2, color1, color2,
      startedAt: Date.now(),
    });
    c1.gameId = gameId;
    c2.gameId = gameId;

    // The white player initiates the WebRTC offer.
    send(p1, {
      type: 'matched',
      gameId,
      color: color1,
      shouldInitiateRTC: color1 === 'white',
      opponentName: c2.name || 'Opponent',
    });
    send(p2, {
      type: 'matched',
      gameId,
      color: color2,
      shouldInitiateRTC: color2 === 'white',
      opponentName: c1.name || 'Opponent',
    });

    console.log(`[match] ${p1.slice(0,6)} (${color1}) vs ${p2.slice(0,6)} (${color2}) -> game ${gameId.slice(0,6)}`);
  }
}

function endGame(gameId, reason, loserId) {
  const game = games.get(gameId);
  if (!game) return;
  const winnerId = loserId === game.p1 ? game.p2 : game.p1;
  send(winnerId, { type: 'opponent-ended', reason });
  // Clean up gameId refs
  const c1 = clients.get(game.p1);
  const c2 = clients.get(game.p2);
  if (c1) c1.gameId = null;
  if (c2) c2.gameId = null;
  games.delete(gameId);
  console.log(`[end] game ${gameId.slice(0,6)} - ${reason}`);
}

// ===== WebSocket handlers =====
wss.on('connection', (ws, req) => {
  const clientId = newId();
  clients.set(clientId, { ws, gameId: null, name: null });
  console.log(`[connect] ${clientId.slice(0,6)} (total: ${clients.size})`);

  send(clientId, { type: 'connected', clientId });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    const c = clients.get(clientId);
    if (!c) return;

    switch (msg.type) {
      case 'queue':
        if (c.gameId) return;
        c.name = (msg.name || '').toString().slice(0, 20) || null;
        if (!waitingQueue.includes(clientId)) {
          waitingQueue.push(clientId);
        }
        send(clientId, { type: 'queued', position: waitingQueue.indexOf(clientId) + 1 });
        tryMatch();
        break;

      case 'leave-queue': {
        const idx = waitingQueue.indexOf(clientId);
        if (idx !== -1) waitingQueue.splice(idx, 1);
        send(clientId, { type: 'left-queue' });
        break;
      }

      // Chess move relay - server doesn't validate, just forwards
      case 'move':
        if (!c.gameId) return;
        broadcastToGame(c.gameId, clientId, {
          type: 'move',
          san: msg.san,
          from: msg.from,
          to: msg.to,
          promotion: msg.promotion,
          fen: msg.fen,
          remainingMs: msg.remainingMs,
        });
        break;

      // Chat relay
      case 'chat':
        if (!c.gameId) return;
        broadcastToGame(c.gameId, clientId, {
          type: 'chat',
          text: (msg.text || '').toString().slice(0, 200),
        });
        break;

      // Game-end signals
      case 'resign':
        if (!c.gameId) return;
        broadcastToGame(c.gameId, clientId, { type: 'opponent-resigned' });
        endGame(c.gameId, 'resign', clientId);
        break;

      case 'timeout':
        if (!c.gameId) return;
        broadcastToGame(c.gameId, clientId, { type: 'opponent-timeout' });
        endGame(c.gameId, 'timeout', clientId);
        break;

      case 'game-over':
        // checkmate/stalemate/draw - just clean up
        if (!c.gameId) return;
        games.delete(c.gameId);
        c.gameId = null;
        break;

      // WebRTC signaling relay
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice':
        if (!c.gameId) return;
        broadcastToGame(c.gameId, clientId, {
          type: msg.type,
          payload: msg.payload,
        });
        break;

      default:
        // Unknown messages are ignored
        break;
    }
  });

  ws.on('close', () => {
    const c = clients.get(clientId);
    if (!c) return;
    console.log(`[disconnect] ${clientId.slice(0,6)}`);

    // Remove from queue if waiting
    const qIdx = waitingQueue.indexOf(clientId);
    if (qIdx !== -1) waitingQueue.splice(qIdx, 1);

    // Notify opponent if in a game
    if (c.gameId) {
      broadcastToGame(c.gameId, clientId, { type: 'opponent-disconnected' });
      const game = games.get(c.gameId);
      if (game) {
        const otherId = game.p1 === clientId ? game.p2 : game.p1;
        const other = clients.get(otherId);
        if (other) other.gameId = null;
        games.delete(c.gameId);
      }
    }

    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[ws error] ${clientId.slice(0,6)}:`, err.message);
  });
});

// Periodic ping to keep connections alive and detect dead ones
setInterval(() => {
  for (const [id, c] of clients.entries()) {
    if (c.ws.readyState !== 1) {
      clients.delete(id);
      const qIdx = waitingQueue.indexOf(id);
      if (qIdx !== -1) waitingQueue.splice(qIdx, 1);
    } else {
      try { c.ws.ping(); } catch (e) {}
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │  ChessConnect server running            │
  │  http://localhost:${PORT}                   │
  │  WebSocket: ws://localhost:${PORT}          │
  └─────────────────────────────────────────┘
  `);
});
