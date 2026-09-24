// Change cette URL par l'adresse de ton backend une fois déployé (ex: Render)
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://TON-BACKEND.onrender.com';

const socket = io(SERVER_URL);

// --- Éléments DOM ---
const loginScreen = document.getElementById('login-screen');
const app = document.getElementById('app');
const pseudoInput = document.getElementById('pseudo-input');
const joinBtn = document.getElementById('join-btn');
const userListEl = document.getElementById('user-list');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const callPanel = document.getElementById('call-panel');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const hangupBtn = document.getElementById('hangup-btn');
const incomingCallEl = document.getElementById('incoming-call');
const callerNameEl = document.getElementById('caller-name');
const acceptCallBtn = document.getElementById('accept-call-btn');
const rejectCallBtn = document.getElementById('reject-call-btn');

let myPseudo = '';
let peerConnection = null;
let localStream = null;
let currentCallPartner = null;
let pendingOffer = null;

// Serveurs STUN publics (aident à traverser les NAT/box internet)
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  // Pour une fiabilité totale (surtout en groupe), il faudra ajouter un serveur TURN.
};

// --- Connexion ---
joinBtn.onclick = () => {
  myPseudo = pseudoInput.value.trim();
  if (!myPseudo) return;
  socket.emit('join', myPseudo);
  loginScreen.classList.add('hidden');
  app.classList.remove('hidden');
};

socket.on('user-list', (list) => {
  userListEl.innerHTML = '';
  list.forEach((pseudo) => {
    if (pseudo === myPseudo) return;
    const li = document.createElement('li');
    li.textContent = pseudo + ' 📞';
    li.onclick = () => startCall(pseudo);
    userListEl.appendChild(li);
  });
});

socket.on('system-message', (text) => {
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// --- Chat texte ---
chatForm.onsubmit = (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat-message', msg);
  chatInput.value = '';
};

socket.on('chat-message', ({ pseudo, msg }) => {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="pseudo">${pseudo}</span>${msg}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// --- Appels WebRTC ---
// Remarque : ceci ne trouve le destinataire que par son pseudo lors de cette session ;
// pour un vrai système d'appel, il faudrait mapper pseudo -> socket.id côté serveur.

async function startCall(targetPseudo) {
  currentCallPartner = targetPseudo;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  localVideo.srcObject = localStream;
  callPanel.classList.remove('hidden');

  peerConnection = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => { remoteVideo.srcObject = event.streams[0]; };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) socket.emit('ice-candidate', { to: currentCallPartner, candidate: event.candidate });
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('call-user', { to: currentCallPartner, offer });
}

socket.on('incoming-call', ({ from, offer, pseudo }) => {
  pendingOffer = { from, offer };
  callerNameEl.textContent = `Appel entrant de ${pseudo}`;
  incomingCallEl.classList.remove('hidden');
});

acceptCallBtn.onclick = async () => {
  incomingCallEl.classList.add('hidden');
  currentCallPartner = pendingOffer.from;

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  localVideo.srcObject = localStream;
  callPanel.classList.remove('hidden');

  peerConnection = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.ontrack = (event) => { remoteVideo.srcObject = event.streams[0]; };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) socket.emit('ice-candidate', { to: currentCallPartner, candidate: event.candidate });
  };

  await peerConnection.setRemoteDescription(pendingOffer.offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer-call', { to: currentCallPartner, answer });
};

rejectCallBtn.onclick = () => {
  incomingCallEl.classList.add('hidden');
  pendingOffer = null;
};

socket.on('call-answered', async ({ answer }) => {
  await peerConnection.setRemoteDescription(answer);
});

socket.on('ice-candidate', async ({ candidate }) => {
  if (peerConnection) await peerConnection.addIceCandidate(candidate);
});

socket.on('call-ended', () => endCall());

hangupBtn.onclick = () => {
  if (currentCallPartner) socket.emit('end-call', { to: currentCallPartner });
  endCall();
};

function endCall() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  callPanel.classList.add('hidden');
  currentCallPartner = null;
}
