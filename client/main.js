// signaling server URL (adjust for production)
const SIGNALING_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'ws://localhost:3000'
  : 'wss://opendrop.onrender.com';

const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://opendrop.onrender.com';

// State
let ws;
let myId;
let myName;
const peers = new Map(); // id -> { name, element, connection, dataChannel }
const CHUNK_SIZE = 16384; // 16kb per chunk for WebRTC

// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// UI Elements
const statusIndicator = document.getElementById('connectionStatusIndicator');
const statusText = document.getElementById('connectionStatusText');
const myNameEl = document.getElementById('myName');
const peersContainer = document.getElementById('peersContainer');
const fileInput = document.getElementById('fileInput');
const radarContainer = document.querySelector('.radar-container');

// Overlay Elements
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalContent = document.getElementById('modalContent');
const modalActions = document.getElementById('modalActions');
const toastContainer = document.getElementById('toastContainer');

// File transfer state
let incomingFile = null;
let receivedChunks = [];
let receivedSize = 0;
let currentTransferTarget = null;

function connectSignaling() {
    updateStatus('connecting', 'Connecting...');
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
        updateStatus('online', 'Connected');
    };

    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
            case 'init':
                myId = msg.id;
                myName = msg.name;
                myNameEl.textContent = myName;

                // Add existing peers
                msg.peers.forEach(p => addPeer(p.id, p.name));
                showToast(`Welcome! You are ${myName}`, 'success');
                break;

            case 'peer-joined':
                addPeer(msg.peer.id, msg.peer.name);
                showToast(`${msg.peer.name} joined the network`, 'success');
                break;

            case 'peer-left':
                removePeer(msg.peerId);
                break;

            case 'offer':
                await handleOffer(msg);
                break;

            case 'answer':
                await handleAnswer(msg);
                break;

            case 'candidate':
                await handleCandidate(msg);
                break;

            case 'file-header':
                handleIncomingFileRequest(msg);
                break;
        }
    };

    ws.onclose = () => {
        updateStatus('offline', 'Disconnected');
        peers.forEach((_, id) => removePeer(id));
        setTimeout(connectSignaling, 3000); // Reconnect loop
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws.close();
    };
}

function updateStatus(status, text) {
    statusIndicator.className = `status-indicator ${status}`;
    statusText.textContent = text;
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'ri-checkbox-circle-fill' : 'ri-error-warning-fill';
    toast.innerHTML = `<i class="${icon}"></i> <span>${message}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ---------------------------
// Peer UI Management
// ---------------------------

function addPeer(id, name) {
    if (peers.has(id)) return;

    const angle = Math.random() * Math.PI * 2;
    // Use container size to scale distance dynamically for all screen sizes
    const containerSize = Math.min(radarContainer.offsetWidth, radarContainer.offsetHeight);
  
    const maxDistance = containerSize * 0.35; // 35% of container radius
    const distance = maxDistance * (0.6 + Math.random() * 0.4);

    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;

    const el = document.createElement('div');
    el.className = 'peer-node';
    el.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    el.innerHTML = `
        <div class="avatar">
            <i class="ri-macbook-line"></i>
        </div>
        <div class="peer-name">${name}</div>
    `;

    // Click to send file - start connection immediately when clicking on peer
    el.addEventListener('click', () => {
        currentTransferTarget = id;
        
        // Start WebRTC connection immediately when user clicks on peer
        // This gives time for connection to establish before file is selected
        const peer = peers.get(id);
        if (!peer.connection || peer.connection.connectionState !== 'connected') {
            startConnection(id);
        }
        
        fileInput.click();
    });

    peersContainer.appendChild(el);
    peers.set(id, { name, el, connection: null, dataChannel: null });
}

function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;

    if (peer.connection) peer.connection.close();
    peer.el.remove();
    peers.delete(id);
    showToast(`${peer.name} left`, 'info');
}

// ---------------------------
// WebRTC Logic
// ---------------------------

function getOrCreateConnection(peerId) {
    let peer = peers.get(peerId);
    if (!peer) return null;

    if (!peer.connection) {
        const pc = new RTCPeerConnection(rtcConfig);

        // Track connection state
        pc.onconnectionstatechange = () => {
            console.log(`Connection state with ${peer.name}: ${pc.connectionState}`);
            if (pc.connectionState === 'connected') {
                showToast(`Connected to ${peer.name}`, 'success');
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                showToast(`Connection lost with ${peer.name}`, 'error');
            }
        };

        // Output ICE candidates to signaling server
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                sendSignaling({ type: 'candidate', target: peerId, candidate: e.candidate });
            }
        };

        // When receiving a data channel
        pc.ondatachannel = (e) => {
            const dc = e.channel;
            setupDataChannel(peerId, dc);
            peer.dataChannel = dc;
        };

        peer.connection = pc;
    }
    return peer.connection;
}

async function startConnection(peerId) {
    const pc = getOrCreateConnection(peerId);
    const peer = peers.get(peerId);

    // Create our data channel
    const dc = pc.createDataChannel('fileTransfer');
    setupDataChannel(peerId, dc);
    peer.dataChannel = dc;

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    sendSignaling({ type: 'offer', target: peerId, offer: offer });
}

async function handleOffer(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignaling({ type: 'answer', target: msg.sender, answer: answer });
}

async function handleAnswer(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
}

async function handleCandidate(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
}

// ---------------------------
// Data Channel & File Transfer
// ---------------------------

function setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => console.log(`DataChannel open with ${peers.get(peerId).name}`);
    dc.onclose = () => console.log(`DataChannel closed with ${peers.get(peerId).name}`);

    dc.onmessage = (e) => {
        if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data);
            if (msg.type === 'file-header') handleIncomingFileRequest(msg, peerId);
            else if (msg.type === 'transfer-accepted') startSendingFile(peerId);
            else if (msg.type === 'transfer-rejected') showToast('Transfer rejected', 'error');
            else if (msg.type === 'file-complete') finishReceivingFile();
        } else {
            // Binary chunk received
            receiveChunk(e.data);
        }
    };
}

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentTransferTarget) return;

    const peer = peers.get(currentTransferTarget);
    
    // Check if connection exists and is connected
    if (peer.connection && peer.connection.connectionState === 'connected') {
        sendFileHeader(currentTransferTarget, file);
    } else {
        // Connection is being established (or was just started on peer click)
        // Wait for connection to be ready with exponential backoff
        let attempts = 0;
        const maxAttempts = 10;
        const checkConnection = () => {
            attempts++;
            if (peer.connection && peer.connection.connectionState === 'connected') {
                sendFileHeader(currentTransferTarget, file);
            } else if (attempts < maxAttempts) {
                // Exponential backoff: 100ms, 200ms, 400ms, etc.
                setTimeout(checkConnection, 100 * Math.pow(2, attempts));
            } else {
                showToast('Connection failed. Try again.', 'error');
            }
        };
        checkConnection();
    }

    fileInput.value = ''; // Reset input
});

function sendFileHeader(peerId, file) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dataChannel) {
        showToast('Connection not ready. Trying again...', 'info');
        
        // Try to start connection and wait for it
        startConnection(peerId);
        let attempts = 0;
        const checkDataChannel = () => {
            attempts++;
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                doSendFileHeader(peerId, file);
            } else if (attempts < 10) {
                setTimeout(checkDataChannel, 200);
            } else {
                showToast('Connection failed. Try again.', 'error');
            }
        };
        setTimeout(checkDataChannel, 500);
        return;
    }
    
    if (peer.dataChannel.readyState !== 'open') {
        showToast('Connection not ready. Trying again...', 'info');
        
        // Wait for data channel to open
        let attempts = 0;
        const checkDataChannel = () => {
            attempts++;
            if (peer.dataChannel.readyState === 'open') {
                doSendFileHeader(peerId, file);
            } else if (attempts < 10) {
                setTimeout(checkDataChannel, 200);
            } else {
                showToast('Connection failed. Try again.', 'error');
            }
        };
        setTimeout(checkDataChannel, 200);
        return;
    }
    
    doSendFileHeader(peerId, file);
}

function doSendFileHeader(peerId, file) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        showToast('Connection not ready. Try again.', 'error');
        return;
    }

    // Attach file to peer object temporarily
    peer.pendingFile = file;

    // Send metadata first natively over datachannel
    peer.dataChannel.send(JSON.stringify({
        type: 'file-header',
        name: file.name,
        size: file.size,
        mime: file.type
    }));

    showToast(`Waiting for ${peer.name} to accept...`, 'info');
}

function startSendingFile(peerId) {
    const peer = peers.get(peerId);
    const file = peer.pendingFile;
    const dc = peer.dataChannel;

    if (!file || !dc) return;

    showToast(`Sending ${file.name}...`, 'info');

    // UI Progress could be added here
    let offset = 0;

    const readSlice = (o) => {
        const slice = file.slice(offset, o + CHUNK_SIZE);
        const reader = new FileReader();
        reader.onload = (e) => {
            if (dc.readyState !== 'open') return;

            // Send chunk
            dc.send(e.target.result);
            offset += e.target.result.byteLength;

            if (offset < file.size) {
                // Throttle sending if buffer is full
                if(dc.bufferedAmount > 1024 * 1024) {
                    setTimeout(() => readSlice(offset), 50);
                } else {
                    readSlice(offset);
                }
            } else {
                // Complete
                dc.send(JSON.stringify({ type: 'file-complete' }));
                showToast('File sent successfully', 'success');
                peer.pendingFile = null;
            }
        };
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}

// Receiving
function handleIncomingFileRequest(msg, senderId) {
    const sender = peers.get(senderId);
    if (!sender) return;

    incomingFile = {
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        senderId: senderId
    };
    receivedChunks = [];
    receivedSize = 0;

    // Show Modal
    modalTitle.textContent = `${sender.name} wants to send you a file`;
    modalContent.innerHTML = `
        <div class="file-info">
            <i class="ri-file-line"></i>
            <div class="file-details">
                <span class="file-name">${msg.name}</span>
                <span class="file-size">${(msg.size / (1024*1024)).toFixed(2)} MB</span>
            </div>
        </div>
        <div class="progress-container hidden" id="receiveProgressContainer">
            <div class="progress-bar" id="receiveProgressBar"></div>
        </div>
    `;

    modalActions.innerHTML = `
        <button class="btn btn-secondary" id="btnReject">Decline</button>
        <button class="btn btn-primary" id="btnAccept">Accept</button>
    `;

    modalOverlay.classList.remove('hidden');

    document.getElementById('btnReject').onclick = () => {
        sender.dataChannel.send(JSON.stringify({ type: 'transfer-rejected' }));
        modalOverlay.classList.add('hidden');
        incomingFile = null;
    };

    document.getElementById('btnAccept').onclick = () => {
        document.getElementById('btnReject').style.display = 'none';
        document.getElementById('btnAccept').style.display = 'none';
        document.getElementById('receiveProgressContainer').classList.remove('hidden');

        sender.dataChannel.send(JSON.stringify({ type: 'transfer-accepted' }));
    };
}

function receiveChunk(data) {
    if (!incomingFile) return;
    receivedChunks.push(data);
    receivedSize += data.byteLength;

    const progress = (receivedSize / incomingFile.size) * 100;
    const bar = document.getElementById('receiveProgressBar');
    if (bar) bar.style.width = `${progress}%`;
}

function finishReceivingFile() {
    if (!incomingFile) return;

    const blob = new Blob(receivedChunks, { type: incomingFile.mime });
    const url = URL.createObjectURL(blob);

    // Auto download
    const a = document.createElement('a');
    a.href = url;
    a.download = incomingFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Received ${incomingFile.name}`, 'success');
    modalOverlay.classList.add('hidden');
    incomingFile = null;
    receivedChunks = [];
}

function sendSignaling(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// ---------------------------
// Share via Link (Upload)
// ---------------------------

const shareLinkBtn = document.getElementById('shareLinkBtn');
const shareFileInput = document.getElementById('shareFileInput');

shareLinkBtn.addEventListener('click', () => {
    shareFileInput.click();
});

shareFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    shareFileInput.value = '';

    // Show uploading modal
    modalTitle.textContent = 'Uploading File';
    modalContent.innerHTML = `
        <div class="file-info">
            <i class="ri-upload-cloud-line"></i>
            <div class="file-details">
                <span class="file-name">${file.name}</span>
                <span class="file-size">${(file.size / (1024 * 1024)).toFixed(2)} MB</span>
            </div>
        </div>
        <div class="progress-container" id="uploadProgressContainer">
            <div class="progress-bar" id="uploadProgressBar"></div>
        </div>
        <p class="upload-status" id="uploadStatus">Uploading...</p>
    `;
    modalActions.innerHTML = '';
    modalOverlay.classList.remove('hidden');

    try {
        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/upload`);

        xhr.upload.onprogress = (evt) => {
            if (evt.lengthComputable) {
                const pct = (evt.loaded / evt.total) * 100;
                const bar = document.getElementById('uploadProgressBar');
                if (bar) bar.style.width = `${pct}%`;
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const data = JSON.parse(xhr.responseText);
                showShareLinkResult(data);
            } else {
                showToast('Upload failed. File may be too large (max 100MB).', 'error');
                modalOverlay.classList.add('hidden');
            }
        };

        xhr.onerror = () => {
            showToast('Upload failed. Check your connection.', 'error');
            modalOverlay.classList.add('hidden');
        };

        xhr.send(formData);
    } catch (err) {
        showToast('Upload failed.', 'error');
        modalOverlay.classList.add('hidden');
    }
});

function showShareLinkResult(data) {
    modalTitle.textContent = 'File Ready to Share';
    modalContent.innerHTML = `
        <div class="file-info">
            <i class="ri-check-double-line"></i>
            <div class="file-details">
                <span class="file-name">${data.name}</span>
                <span class="file-size">${(data.size / (1024 * 1024)).toFixed(2)} MB</span>
            </div>
        </div>
        <div class="share-link-box">
            <input type="text" id="shareLinkInput" value="${data.url}" readonly />
            <button class="btn-copy" id="copyLinkBtn" title="Copy link">
                <i class="ri-file-copy-line"></i>
            </button>
        </div>
        <p class="share-link-note">Link expires in ${data.expiresIn}</p>
    `;
    modalActions.innerHTML = `
        <button class="btn btn-primary" id="btnCloseShare">Done</button>
    `;

    document.getElementById('btnCloseShare').onclick = () => {
        modalOverlay.classList.add('hidden');
    };

    document.getElementById('copyLinkBtn').onclick = () => {
        const input = document.getElementById('shareLinkInput');
        navigator.clipboard.writeText(input.value).then(() => {
            showToast('Link copied to clipboard!', 'success');
        });
    };
}

// Start
connectSignaling();
