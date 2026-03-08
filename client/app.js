const alertBox = document.getElementById('alert-box');

function showAlert(message) {
    alertBox.textContent = message;
    alertBox.className = 'error';
    alertBox.style.display = 'block';
    setTimeout(() => { alertBox.style.display = 'none'; }, 5000);
}

// Signaling Error Handling
const socket = new WebSocket('ws://your-server-url');
socket.onerror = () => showAlert('Signaling server unreachable.');
socket.onclose = () => showAlert('Connection to server lost.');

// WebRTC Error Handling
const peerConnection = new RTCPeerConnection();
peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
        showAlert('WebRTC connection failed.');
    }
};

// File Transfer Error Handling
function handleTransfer(file) {
    const reader = new FileReader();
    reader.onerror = () => showAlert('File transfer interrupted.');
    // ... transfer logic
}