// Serveur principal : sert le site statique + gère le chat temps réel
// et la signalisation WebRTC pour les appels audio/vidéo.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // à restreindre à ton domaine GitHub Pages en production
});

// Sert les fichiers du dossier /public (index.html, client.js, style.css)
app.use(express.static(path.join(__dirname, '../public')));

// Liste des utilisateurs connectés : { socketId: pseudo }
const users = {};

io.on('connection', (socket) => {
  console.log('Nouvelle connexion :', socket.id);

  // --- Arrivée d'un utilisateur ---
  socket.on('join', (pseudo) => {
    users[socket.id] = pseudo;
    io.emit('user-list', Object.values(users));
    socket.broadcast.emit('system-message', `${pseudo} a rejoint le salon.`);
  });

  // --- Chat texte ---
  socket.on('chat-message', (msg) => {
    const pseudo = users[socket.id] || 'Anonyme';
    io.emit('chat-message', { pseudo, msg, time: Date.now() });
  });

  // --- Signalisation WebRTC (appel audio/vidéo) ---
  // Un utilisateur appelle un autre : on relaie juste les infos, le flux audio/vidéo
  // passe directement entre les deux navigateurs (peer-to-peer).
  socket.on('call-user', ({ to, offer }) => {
    io.to(to).emit('incoming-call', { from: socket.id, offer, pseudo: users[socket.id] });
  });

  socket.on('answer-call', ({ to, answer }) => {
    io.to(to).emit('call-answered', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('end-call', ({ to }) => {
    io.to(to).emit('call-ended');
  });

  // --- Déconnexion ---
  socket.on('disconnect', () => {
    const pseudo = users[socket.id];
    delete users[socket.id];
    io.emit('user-list', Object.values(users));
    if (pseudo) io.emit('system-message', `${pseudo} a quitté le salon.`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
