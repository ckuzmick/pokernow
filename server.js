import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';

const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname.startsWith('/g/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }
  res.writeHead(404).end('not found');
});

// roomId -> { game, host, clients: Map<ws, playerId> }
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    const game = new Game();
    const room = { game, host: null, clients: new Map() };
    game.onChange = () => broadcast(room);
    rooms.set(id, room);
  }
  return rooms.get(id);
}

function broadcast(room) {
  for (const [ws, pid] of room.clients) {
    ws.send(JSON.stringify({ type: 'state', state: { ...room.game.view(pid), isHost: room.host === pid } }));
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const roomId = url.searchParams.get('room');
  // the client keeps a random id in localStorage so refreshes reconnect to the same seat
  const pid = url.searchParams.get('pid') || randomUUID();
  if (!roomId) return ws.close();
  const room = getRoom(roomId);
  const { game } = room;
  room.clients.set(ws, pid);
  if (!room.host) room.host = pid;
  game.setConnected(pid, true);
  broadcast(room);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    let err = null;
    switch (msg.type) {
      case 'sit': err = game.sit(Number(msg.seat), pid, String(msg.name || 'Player').slice(0, 16), msg.amount); break;
      case 'stand': game.stand(pid); break;
      case 'addChips': err = game.addChips(pid, msg.amount); break;
      case 'start': if (room.host === pid) game.start(); break;
      case 'act': err = game.act(pid, msg.action, msg.amount); break;
    }
    if (err) ws.send(JSON.stringify({ type: 'error', error: err }));
    broadcast(room);
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (![...room.clients.values()].includes(pid)) game.setConnected(pid, false);
    if (room.host === pid) room.host = [...room.clients.values()][0] ?? null;
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Poker running at http://localhost:${PORT}`));
