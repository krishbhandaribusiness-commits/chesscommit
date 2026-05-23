# ChessConnect

Omegle for chess — 5-minute blitz games with live webcam against random opponents.

## Stack

- **Backend**: Node.js + Express + `ws` (WebSocket)
- **Frontend**: vanilla JS + chess.js + chessboard.js + WebRTC
- **No database** — games live entirely in memory

## Architecture

```
   Browser A                Browser B
      |                        |
      |---- WebSocket -------> |
      |                        |
      |   matchmaking +        |
      |   move/chat relay      |
      |   WebRTC signaling     |
      |                        |
      |<==== WebRTC P2P =======|
      |  (webcam + audio,      |
      |   direct peer-to-peer) |
```

The server is a relay only. Once both players exchange WebRTC SDPs through
the server, their video/audio streams flow directly peer-to-peer.

Chess moves and chat also go through the WS server (since the WebRTC data
channel isn't used here — keeps the WebRTC layer simple and reuses the
already-open WebSocket).

## Running locally

```bash
cd chessconnect
npm install
npm start
```

Open `http://localhost:3000` in two browser windows (or share the URL with a
friend on the same network using your local IP — note: webcam requires HTTPS
for non-localhost access, so use `localhost` for testing).

## Files

- `server.js` — WebSocket server, matchmaking queue, signaling relay
- `public/index.html` — Single-page client (landing → queue → game)
- `package.json`

## Health check

`GET /health` returns:
```json
{
  "status": "ok",
  "waiting": 2,
  "activeGames": 7,
  "connectedClients": 16
}
```

## Deployment notes

- For production behind a reverse proxy (nginx, Caddy), forward both
  HTTP and the WebSocket upgrade to the Node process.
- Webcam (`getUserMedia`) requires HTTPS — get a cert (Let's Encrypt) or
  put the app behind Cloudflare.
- Add TURN servers (e.g. coturn) to `ICE_SERVERS` in `index.html` for users
  behind strict NATs — STUN alone won't punch through symmetric NATs.
- The current server has no rate limiting, anti-abuse, or persistent state.
  For real-world deployment add: WS message rate limits, profanity filter
  on chat, IP-based throttling, and a moderation/reporting flow.

## Known limitations

- No ELO/ranking, no reconnection-to-game-in-progress, no spectator mode.
- Move validation is client-side only — a cheating client could send illegal
  moves. For a competitive product, mirror chess.js on the server and reject
  bad moves there.
- Single-process / no horizontal scaling. Multiple instances would need a
  shared queue (Redis pub/sub) for matchmaking.
