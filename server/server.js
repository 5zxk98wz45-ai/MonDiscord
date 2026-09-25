const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..')));

// --- Comptes utilisateurs (fichier local — voir note de fiabilité dans le README) ---
const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) { console.error('Erreur sauvegarde users:', e); }
}
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}
let users = loadUsers();

// --- Salons fixes ---
const CHANNELS = ['général', 'jeux', 'musique', 'random'];

// socket.id -> { pseudo, channel }
const connected = {};
// channel -> Set(socket.id)  (pour les appels de groupe, room = channel)
const callRooms = {};
CHANNELS.forEach((c) => { callRooms[c] = new Set(); });

function channelUserList(channel) {
  return Object.values(connected)
    .filter((u) => u.channel === channel)
    .map((u) => u.pseudo);
}

io.on('connection', (socket) => {

  // --- Inscription ---
  socket.on('register', ({ pseudo, password }, cb) => {
    if (!pseudo || !password) return cb({ ok: false, error: 'Pseudo et mot de passe requis.' });
    if (users[pseudo]) return cb({ ok: false, error: 'Ce pseudo est déjà pris.' });
    users[pseudo] = { password: hashPassword(password) };
    saveUsers(users);
    cb({ ok: true });
  });

  // --- Connexion ---
  socket.on('login', ({ pseudo, password }, cb) => {
    const u = users[pseudo];
    if (!u || u.password !== hashPassword(password)) {
      return cb({ ok: false, error: 'Pseudo ou mot de passe incorrect.' });
    }
    cb({ ok: true });
  });

  // --- Rejoindre le site (après connexion) ---
  socket.on('join', ({ pseudo, channel }) => {
    const ch = CHANNELS.includes(channel) ? channel : CHANNELS[0];
    connected[socket.id] = { pseudo, channel: ch };
    socket.join(ch);
    io.to(ch).emit('user-list', channelUserList(ch));
    socket.to(ch).emit('system-message', `${pseudo} a rejoint le salon.`);
    socket.emit('channels', CHANNELS);
  });

  // --- Changer de salon ---
  socket.on('switch-channel', (channel) => {
    const u = connected[socket.id];
    if (!u || !CHANNELS.includes(channel)) return;
    socket.leave(u.channel);
    io.to(u.channel).emit('user-list', channelUserList(u.channel));
    // quitte aussi tout appel de groupe en cours dans l'ancien salon
    leaveCallRoom(socket, u.channel);

    u.channel = channel;
    socket.join(channel);
    io.to(channel).emit('user-list', channelUserList(channel));
    socket.emit('channel-switched', channel);
  });

  // --- Chat texte (scopé au salon) ---
  socket.on('chat-message', (msg) => {
    const u = connected[socket.id];
    if (!u) return;
    io.to(u.channel).emit('chat-message', { pseudo: u.pseudo, msg, channel: u.channel });
  });

  // --- Appels de groupe (mesh WebRTC) : room = le salon texte actuel ---
  socket.on('join-call', () => {
    const u = connected[socket.id];
    if (!u) return;
    const room = callRooms[u.channel];
    const existingPeers = Array.from(room).map((id) => ({ id, pseudo: connected[id]?.pseudo }));
    room.add(socket.id);
    socket.emit('existing-call-peers', existingPeers);
    socket.to(u.channel).emit('call-peer-joined', { id: socket.id, pseudo: u.pseudo });
  });

  socket.on('call-offer', ({ to, offer }) => {
    const u = connected[socket.id];
    io.to(to).emit('call-offer', { from: socket.id, offer, pseudo: u?.pseudo });
  });

  socket.on('call-answer', ({ to, answer }) => {
    io.to(to).emit('call-answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('leave-call', () => {
    const u = connected[socket.id];
    if (u) leaveCallRoom(socket, u.channel);
  });

  function leaveCallRoom(socket, channel) {
    const room = callRooms[channel];
    if (room && room.has(socket.id)) {
      room.delete(socket.id);
      socket.to(channel).emit('call-peer-left', { id: socket.id });
    }
  }

  // --- Déconnexion ---
  socket.on('disconnect', () => {
    const u = connected[socket.id];
    if (u) {
      delete connected[socket.id];
      io.to(u.channel).emit('user-list', channelUserList(u.channel));
      socket.to(u.channel).emit('system-message', `${u.pseudo} a quitté le salon.`);
      leaveCallRoom(socket, u.channel);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
