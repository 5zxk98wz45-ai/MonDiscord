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

// --- Fichiers de persistance (voir note de fiabilité dans le README) ---
const USERS_FILE = path.join(__dirname, 'users.json');
const SERVERS_FILE = path.join(__dirname, 'servers.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('Erreur sauvegarde:', e); }
}
function hashPassword(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function shortId() { return crypto.randomBytes(4).toString('hex'); }

let users = loadJSON(USERS_FILE, {});
// servers = { serverId: { name, channels: { channelId: { name } } } }
let servers = loadJSON(SERVERS_FILE, {});

// socket.id -> { pseudo, serverId, channelId }
const connected = {};
// pseudo -> socket.id (pour retrouver quelqu'un et l'appeler directement)
const pseudoToSocket = {};
// "serverId:channelId" -> Set(socket.id) en appel de groupe
const callRooms = {};

function roomKey(serverId, channelId) { return `${serverId}:${channelId}`; }

function usersInRoom(serverId, channelId) {
  const key = roomKey(serverId, channelId);
  return Object.values(connected)
    .filter((u) => roomKey(u.serverId, u.channelId) === key)
    .map((u) => u.pseudo);
}

function serversPublicList() {
  return Object.entries(servers).map(([id, s]) => ({
    id, name: s.name,
    channels: Object.entries(s.channels).map(([cid, c]) => ({ id: cid, name: c.name }))
  }));
}

io.on('connection', (socket) => {

  // --- Comptes ---
  socket.on('register', ({ pseudo, password }, cb) => {
    if (!pseudo || !password) return cb({ ok: false, error: 'Pseudo et mot de passe requis.' });
    if (users[pseudo]) return cb({ ok: false, error: 'Ce pseudo est déjà pris.' });
    users[pseudo] = { password: hashPassword(password) };
    saveJSON(USERS_FILE, users);
    cb({ ok: true });
  });

  socket.on('login', ({ pseudo, password }, cb) => {
    const u = users[pseudo];
    if (!u || u.password !== hashPassword(password)) {
      return cb({ ok: false, error: 'Pseudo ou mot de passe incorrect.' });
    }
    cb({ ok: true });
  });

  // --- Arrivée sur le site (après connexion) ---
  socket.on('join', (pseudo) => {
    connected[socket.id] = { pseudo, serverId: null, channelId: null };
    pseudoToSocket[pseudo] = socket.id;
    socket.emit('servers-list', serversPublicList());
  });

  // --- Créer un serveur ---
  socket.on('create-server', (name, cb) => {
    if (!name || !name.trim()) return cb({ ok: false, error: 'Nom invalide.' });
    const id = shortId();
    servers[id] = { name: name.trim(), channels: {} };
    saveJSON(SERVERS_FILE, servers);
    io.emit('servers-list', serversPublicList());
    cb({ ok: true, id });
  });

  // --- Créer un salon dans un serveur ---
  socket.on('create-channel', ({ serverId, name }, cb) => {
    const s = servers[serverId];
    if (!s) return cb({ ok: false, error: 'Serveur introuvable.' });
    if (!name || !name.trim()) return cb({ ok: false, error: 'Nom invalide.' });
    const id = shortId();
    s.channels[id] = { name: name.trim() };
    saveJSON(SERVERS_FILE, servers);
    io.emit('servers-list', serversPublicList());
    cb({ ok: true, id });
  });

  // --- Rejoindre un salon précis ---
  socket.on('join-channel', ({ serverId, channelId }) => {
    const u = connected[socket.id];
    if (!u || !servers[serverId] || !servers[serverId].channels[channelId]) return;

    // Quitte l'ancien salon
    if (u.serverId && u.channelId) {
      const oldKey = roomKey(u.serverId, u.channelId);
      socket.leave(oldKey);
      io.to(oldKey).emit('user-list', usersInRoom(u.serverId, u.channelId));
      leaveCallRoom(socket, u.serverId, u.channelId);
    }

    u.serverId = serverId;
    u.channelId = channelId;
    const key = roomKey(serverId, channelId);
    socket.join(key);
    io.to(key).emit('user-list', usersInRoom(serverId, channelId));
    socket.emit('channel-joined', { serverId, channelId });
  });

  // --- Chat texte (scopé au salon courant) ---
  socket.on('chat-message', (msg) => {
    const u = connected[socket.id];
    if (!u || !u.serverId) return;
    io.to(roomKey(u.serverId, u.channelId)).emit('chat-message', { pseudo: u.pseudo, msg });
  });

  // --- Appel de groupe (mesh WebRTC) dans le salon courant ---
  socket.on('join-call', () => {
    const u = connected[socket.id];
    if (!u || !u.serverId) return;
    const key = roomKey(u.serverId, u.channelId);
    if (!callRooms[key]) callRooms[key] = new Set();
    const existingPeers = Array.from(callRooms[key]).map((id) => ({ id, pseudo: connected[id]?.pseudo }));
    callRooms[key].add(socket.id);
    socket.emit('existing-call-peers', existingPeers);
    socket.to(key).emit('call-peer-joined', { id: socket.id, pseudo: u.pseudo });
  });

  socket.on('call-offer', ({ to, offer }) => io.to(to).emit('call-offer', { from: socket.id, offer }));
  socket.on('call-answer', ({ to, answer }) => io.to(to).emit('call-answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('leave-call', () => {
    const u = connected[socket.id];
    if (u && u.serverId) leaveCallRoom(socket, u.serverId, u.channelId);
  });

  function leaveCallRoom(socket, serverId, channelId) {
    const key = roomKey(serverId, channelId);
    const room = callRooms[key];
    if (room && room.has(socket.id)) {
      room.delete(socket.id);
      socket.to(key).emit('call-peer-left', { id: socket.id });
    }
  }

  // --- Appel direct à un contact (par pseudo), indépendant des salons ---
  socket.on('direct-call-user', ({ toPseudo, offer }, cb) => {
    const targetId = pseudoToSocket[toPseudo];
    const u = connected[socket.id];
    if (!targetId) { if (cb) cb({ ok: false }); return; }
    io.to(targetId).emit('direct-incoming-call', { from: socket.id, offer, pseudo: u?.pseudo });
    if (cb) cb({ ok: true, targetId });
  });
  socket.on('direct-answer-call', ({ to, answer }) => io.to(to).emit('direct-call-answered', { from: socket.id, answer }));
  socket.on('direct-ice-candidate', ({ to, candidate }) => io.to(to).emit('direct-ice-candidate', { from: socket.id, candidate }));
  socket.on('direct-end-call', ({ to }) => io.to(to).emit('direct-call-ended'));

  // --- Vérifier si un pseudo est en ligne (pour les points de statut des contacts) ---
  socket.on('check-online', (pseudoList, cb) => {
    cb(pseudoList.filter((p) => !!pseudoToSocket[p]));
  });

  // --- Déconnexion ---
  socket.on('disconnect', () => {
    const u = connected[socket.id];
    if (u) {
      if (u.serverId) {
        io.to(roomKey(u.serverId, u.channelId)).emit('user-list', usersInRoom(u.serverId, u.channelId).filter(p => p !== u.pseudo));
        leaveCallRoom(socket, u.serverId, u.channelId);
      }
      delete pseudoToSocket[u.pseudo];
      delete connected[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
