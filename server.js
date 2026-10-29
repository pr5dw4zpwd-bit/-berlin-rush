if (!require('node:fs').existsSync(require('node:path').join(__dirname, 'public/index.html'))) require('./assemble.js');
// Berlin Rush – Mini-Server (keine Abhängigkeiten, nur Node.js >= 18)
// Startet: node server.js   (Port über Umgebungsvariable PORT, Standard 8080)
// Liefert außerdem die Spieldateien aus ./public aus, so dass Spiel + Multiplayer unter EINER Adresse laufen.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 8080;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX = 8;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nicht gefunden'); }
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': (ext === '.html' || ext === '.webmanifest' || path.basename(f) === 'sw.js') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- minimal WebSocket (RFC 6455)
function frame(opcode, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = b.length; let h;
  if (n < 126) h = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, b]);
}
function send(c, obj) { if (!c.dead) { try { c.socket.write(frame(1, JSON.stringify(obj))); } catch (e) { /* ignore */ } } }

const rooms = new Map();
const users = new Map();      // eingeloggte Namen (klein geschrieben) -> Verbindung
const clients = new Set();
const status = (c) => (!c.room ? 'frei' : c.room.racing ? 'rennen' : 'lobby');
let onlineTimer = null;
function pushOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    const msg = { t: 'online', users: [...users.values()].map((u) => ({ name: u.name, st: status(u), n: u.room ? u.room.players.size : 0 })) };
    for (const u of users.values()) send(u, msg);
  }, 150);
}
let nextId = 1;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() { for (;;) { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(s)) return s; } }
function lobbyMsg(room) {
  return { t: 'lobby', room: room.code, host: room.host, racing: room.racing, players: [...room.players.values()].map((p, i) => ({ id: p.id, name: p.name, model: p.model, slot: i })) };
}
function broadcast(room, obj, except) { for (const p of room.players.values()) if (p.id !== except) send(p, obj); }
function leave(c) {
  const room = c.room; if (!room) return;
  room.players.delete(c.id); c.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); pushOnline(); return; }
  if (room.host === c.id) room.host = room.players.keys().next().value;
  broadcast(room, { t: 'left', id: c.id });
  broadcast(room, lobbyMsg(room));
  pushOnline();
}
const clean = (s, n) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, n);

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'login': {
      const name = clean(m.name, 14);
      if (name.length < 2) return send(c, { t: 'err', code: 'name', msg: 'Bitte einen Namen mit mindestens 2 Zeichen wählen.' });
      const key = name.toLowerCase(), ex = users.get(key);
      if (ex && ex !== c) {
        if (ex.token && m.token && ex.token === m.token) ex.kill(); // gleiche Person, alte Verbindung
        else return send(c, { t: 'err', code: 'name', msg: 'Der Name „' + name + '“ ist gerade online vergeben. Bitte einen anderen wählen.' });
      }
      if (c.key && users.get(c.key) === c) users.delete(c.key);
      c.name = name; c.key = key; c.token = clean(m.token, 40); c.model = m.model === 'cheetah' ? 'cheetah' : 'nissan';
      users.set(key, c);
      send(c, { t: 'logged', name });
      pushOnline();
      break;
    }
    case 'leave': { if (c.room) leave(c); break; }
    case 'invite': {
      const now = Date.now(); if (now - (c.lastInv || 0) < 800) return; c.lastInv = now;
      if (!c.key) return send(c, { t: 'err', msg: 'Bitte zuerst einen Namen wählen.' });
      if (!c.room) return send(c, { t: 'err', msg: 'Erst einen Raum erstellen.' });
      if (c.room.racing) return send(c, { t: 'err', msg: 'Das Rennen läuft schon.' });
      const target = users.get(clean(m.to, 14).toLowerCase());
      if (!target || target === c) return send(c, { t: 'err', msg: 'Spieler ist nicht mehr online.' });
      if (target.room === c.room) return send(c, { t: 'info', msg: target.name + ' ist schon im Raum.' });
      if (target.room && target.room.racing) return send(c, { t: 'err', msg: target.name + ' fährt gerade ein Rennen.' });
      send(target, { t: 'invited', from: c.name, room: c.room.code });
      send(c, { t: 'info', msg: 'Einladung an ' + target.name + ' gesendet.' });
      break;
    }
    case 'join': {
      if (c.room) leave(c);
      c.name = c.key ? c.name : (clean(m.name, 14) || 'Spieler'); c.model = m.model === 'cheetah' ? 'cheetah' : 'nissan';
      let room;
      if (m.create) { room = { code: newCode(), players: new Map(), host: c.id, racing: false }; rooms.set(room.code, room); }
      else {
        room = rooms.get(clean(m.room, 4).toUpperCase());
        if (!room) return send(c, { t: 'err', msg: 'Raum nicht gefunden. Code prüfen.' });
        if (room.players.size >= MAX) return send(c, { t: 'err', msg: 'Raum ist voll (max. 8).' });
        if (room.racing) return send(c, { t: 'err', msg: 'Das Rennen läuft schon. Bitte warten.' });
      }
      c.room = room; room.players.set(c.id, c);
      broadcast(room, lobbyMsg(room));
      pushOnline();
      break;
    }
    case 's': case 'ev': {
      if (!c.room) return; m.from = c.id; broadcast(c.room, m, c.id); break;
    }
    case 'start': {
      const r = c.room; if (!r || r.host !== c.id) return;
      r.racing = true;
      broadcast(r, Object.assign(lobbyMsg(r), { t: 'start', preset: clean(m.preset, 8) || 'abend', laps: 3 }));
      pushOnline();
      break;
    }
    case 'back': {
      const r = c.room; if (!r) return;
      // everybody back in the lobby once the host says so (or when the race is over for the sender)
      if (r.host === c.id) { r.racing = false; broadcast(r, lobbyMsg(r)); pushOnline(); }
      else send(c, lobbyMsg(r));
      break;
    }
    case 'ping': send(c, { t: 'pong', ts: m.ts }); break;
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { id: nextId++, socket, room: null, name: '', model: 'nissan', dead: false, buf: Buffer.alloc(0), frag: [] };
  send(c, { t: 'hello', id: c.id });
  clients.add(c);
  const kill = () => { if (c.dead) return; c.dead = true; clients.delete(c); if (c.key && users.get(c.key) === c) { users.delete(c.key); pushOnline(); } leave(c); try { socket.destroy(); } catch (e) { /* ignore */ } };
  c.kill = kill;
  socket.on('data', (d) => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 1 << 16) return kill();
    for (;;) {
      const b = c.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 8192) return kill();
      const need = off + (masked ? 4 : 0) + len; if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mk = b.subarray(off, off + 4); const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mk[i & 3]; payload = o; }
      c.buf = b.subarray(need);
      if (op === 8) { try { socket.write(frame(8, Buffer.alloc(0))); } catch (e) { /* ignore */ } return kill(); }
      if (op === 9) { try { socket.write(frame(10, payload)); } catch (e) { /* ignore */ } continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        c.frag.push(payload);
        if (fin) { const text = Buffer.concat(c.frag).toString('utf8'); c.frag = []; onMessage(c, text); }
      }
    }
  });
  socket.on('close', kill); socket.on('error', kill);
});

// keep idle connections alive behind proxies (Render etc.)
setInterval(() => { for (const p of clients) { try { p.socket.write(frame(9, Buffer.alloc(0))); } catch (e) { /* ignore */ } } }, 25000);

server.listen(PORT, () => console.log('Berlin Rush Server läuft auf Port ' + PORT));
