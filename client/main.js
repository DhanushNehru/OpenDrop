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

// Batch transfer state
let batchFiles = []; // Array of File objects staged for sending
let sendQueue = []; // Queue of  file, peerId  for sending
let currentSendIndex = -1;
let isBatchSending = false;

// Batch incoming state
let incomingBatch = []; // Array of - name, size, mime, senderId 
let incomingBatchTotal = 0;
let incomingBatchReceived = 0;
let currentIncomingIndex = -1;

// Batch UI Elements
const batchModalOverlay = document.getElementById('batchModalOverlay');
const batchFileList = document.getElementById('batchFileList');
const batchSummary = document.getElementById('batchSummary');
const batchProgressOverlay = document.getElementById('batchProgressOverlay');
const batchProgressList = document.getElementById('batchProgressList');
const batchProgressSummary = document.getElementById('batchProgressSummary');
const batchProgressActions = document.getElementById('batchProgressActions');
const batchIncomingOverlay = document.getElementById('batchIncomingOverlay');
const batchIncomingTitle = document.getElementById('batchIncomingTitle');
const batchIncomingList = document.getElementById('batchIncomingList');
const batchIncomingSummary = document.getElementById('batchIncomingSummary');
const batchIncomingActions = document.getElementById('batchIncomingActions');
const dropZoneOverlay = document.getElementById('dropZoneOverlay');

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

    // Click to send file
    el.addEventListener('click', () => {
        currentTransferTarget = id;
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
            else if (msg.type === 'batch-header') handleIncomingBatchHeader(msg, peerId);
            else if (msg.type === 'transfer-accepted') startSendingFile(peerId);
            else if (msg.type === 'transfer-rejected') {
                if (isBatchSending) {
                    isBatchSending = false;
                    batchProgressOverlay.classList.add('hidden');
                }
                showToast('Transfer rejected', 'error');
            }
            else if (msg.type === 'file-complete') finishReceivingFile();
        } else {
            receiveChunk(e.data);
        }
    };
}

fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (!files.length || !currentTransferTarget) return;
    fileInput.value = '';
    openBatchModal(files, currentTransferTarget);
});

// --- Drag and Drop Support ---
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
        dropZoneOverlay.classList.remove('hidden');
    }
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        dropZoneOverlay.classList.add('hidden');
    }
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZoneOverlay.classList.add('hidden');

    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    // Find the first peer to send to, or prompt user
    if (peers.size === 0) {
        showToast('No peers available to send files to', 'error');
        return;
    }

    if (peers.size === 1) {
        const peerId = peers.keys().next().value;
        currentTransferTarget = peerId;
        openBatchModal(files, peerId);
    } else {
        // If batch modal is already open, add to it
        if (!batchModalOverlay.classList.contains('hidden')) {
            addFilesToBatch(files);
        } else {
            showToast('Click on a peer first, then drag files', 'info');
        }
    }
});

// --- Batch Modal UI ---

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function openBatchModal(files, peerId) {
    batchFiles = [...files];
    currentTransferTarget = peerId;
    renderBatchFileList();
    batchModalOverlay.classList.remove('hidden');

    const peer = peers.get(peerId);
    document.getElementById('batchModalTitle').textContent = `Send to ${peer ? peer.name : 'Peer'}`;

    document.getElementById('btnCancelBatch').onclick = () => {
        batchFiles = [];
        batchModalOverlay.classList.add('hidden');
    };

    document.getElementById('btnAddMoreFiles').onclick = () => {
        const addInput = document.createElement('input');
        addInput.type = 'file';
        addInput.multiple = true;
        addInput.style.display = 'none';
        addInput.addEventListener('change', () => {
            addFilesToBatch(Array.from(addInput.files));
            addInput.remove();
        });
        document.body.appendChild(addInput);
        addInput.click();
    };

    document.getElementById('btnStartBatch').onclick = () => {
        if (batchFiles.length === 0) return;
        batchModalOverlay.classList.add('hidden');
        startBatchTransfer(peerId, [...batchFiles]);
    };
}

function addFilesToBatch(files) {
    batchFiles.push(...files);
    renderBatchFileList();
}

function removeBatchFile(index) {
    batchFiles.splice(index, 1);
    renderBatchFileList();
}

function renderBatchFileList() {
    // Clear existing list items
    while (batchFileList.firstChild) {
        batchFileList.removeChild(batchFileList.firstChild);
    }

    // Rebuild list using DOM APIs to avoid injecting raw HTML
    batchFiles.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'batch-file-item';

        const icon = document.createElement('i');
        icon.className = 'ri-file-line batch-file-icon';
        item.appendChild(icon);

        const details = document.createElement('div');
        details.className = 'batch-file-details';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'batch-file-name';
        nameSpan.textContent = f.name;

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'batch-file-size';
        sizeSpan.textContent = formatFileSize(f.size);

        details.appendChild(nameSpan);
        details.appendChild(sizeSpan);
        item.appendChild(details);

        const removeButton = document.createElement('button');
        removeButton.className = 'batch-file-remove';
        removeButton.dataset.index = String(i);
        removeButton.title = 'Remove';

        const closeIcon = document.createElement('i');
        closeIcon.className = 'ri-close-line';
        removeButton.appendChild(closeIcon);

        // Attach click handler directly
        removeButton.addEventListener('click', () => removeBatchFile(i));

        item.appendChild(removeButton);
        batchFileList.appendChild(item);
    });

    const totalSize = batchFiles.reduce((s, f) => s + f.size, 0);
    batchSummary.textContent = `${batchFiles.length} file${batchFiles.length !== 1 ? 's' : ''} \u2022 ${formatFileSize(totalSize)}`;
}

// --- Batch Transfer (WebRTC, sequential per-file) ---

async function startBatchTransfer(peerId, files) {
    const peer = peers.get(peerId);
    if (!peer) return;

    sendQueue = files.map(f => ({ file: f, peerId }));
    currentSendIndex = 0;
    isBatchSending = true;

    // Show progress overlay
    batchProgressOverlay.classList.remove('hidden');
    document.getElementById('batchProgressTitle').textContent = `Sending to ${peer.name}`;
    renderBatchProgressList();
    batchProgressActions.innerHTML = '';

    // Ensure connection and open data channel before starting the queue
    if (!peer.connection || peer.connection.connectionState !== 'connected' || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        await startConnection(peerId);

        const maxWaitMs = 5000;
        const intervalMs = 100;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitMs) {
            const updatedPeer = peers.get(peerId);
            if (
                updatedPeer &&
                updatedPeer.connection &&
                updatedPeer.connection.connectionState === 'connected' &&
                updatedPeer.dataChannel &&
                updatedPeer.dataChannel.readyState === 'open'
            ) {
                break;
            }
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }

    sendNextInQueue(peerId);
}

function renderBatchProgressList() {
    // Clear existing content
    batchProgressList.innerHTML = '';

    sendQueue.forEach((item, i) => {
        let statusClass = 'pending';
        let statusIcon = 'ri-time-line';
        if (i < currentSendIndex) { statusClass = 'done'; statusIcon = 'ri-check-line'; }
        else if (i === currentSendIndex) { statusClass = 'active'; statusIcon = 'ri-loader-4-line'; }

        const itemDiv = document.createElement('div');
        itemDiv.className = `batch-file-item ${statusClass}`;

        const iconEl = document.createElement('i');
        iconEl.className = `${statusIcon} batch-file-icon`;
        itemDiv.appendChild(iconEl);

        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'batch-file-details';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'batch-file-name';
        nameSpan.textContent = item.file.name;

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'batch-file-size';
        sizeSpan.textContent = formatFileSize(item.file.size);

        detailsDiv.appendChild(nameSpan);
        detailsDiv.appendChild(sizeSpan);
        itemDiv.appendChild(detailsDiv);

        const progressWrapDiv = document.createElement('div');
        progressWrapDiv.className = 'batch-file-progress-wrap';

        const progressContainerDiv = document.createElement('div');
        progressContainerDiv.className = 'progress-container small';

        const progressBarDiv = document.createElement('div');
        progressBarDiv.className = 'progress-bar';
        progressBarDiv.id = `sendProgress-${i}`;
        progressBarDiv.style.width = (i < currentSendIndex ? '100' : '0') + '%';

        progressContainerDiv.appendChild(progressBarDiv);
        progressWrapDiv.appendChild(progressContainerDiv);
        itemDiv.appendChild(progressWrapDiv);

        batchProgressList.appendChild(itemDiv);
    });
    batchProgressSummary.textContent = `${Math.min(currentSendIndex, sendQueue.length)}/${sendQueue.length} completed`;
}

function sendNextInQueue(peerId) {
    if (currentSendIndex >= sendQueue.length) {
        // All done
        isBatchSending = false;
        batchProgressSummary.textContent = `All ${sendQueue.length} files sent!`;
        batchProgressActions.innerHTML = `<button class="btn btn-primary" id="btnCloseBatchProgress">Done</button>`;
        document.getElementById('btnCloseBatchProgress').onclick = () => {
            batchProgressOverlay.classList.add('hidden');
        };
        showToast(`${sendQueue.length} files sent successfully`, 'success');
        return;
    }

    renderBatchProgressList();
    const item = sendQueue[currentSendIndex];
    sendFileForBatch(peerId, item.file, currentSendIndex);
}

function sendFileForBatch(peerId, file, queueIndex) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        showToast('Connection not ready. Try again.', 'error');
        isBatchSending = false;
        batchProgressOverlay.classList.add('hidden');
        return;
    }

    peer.pendingFile = file;
    peer.pendingQueueIndex = queueIndex;

    peer.dataChannel.send(JSON.stringify({
        type: 'batch-header',
        name: file.name,
        size: file.size,
        mime: file.type,
        index: queueIndex,
        total: sendQueue.length
    }));
}

// Legacy single-file header for backwards-compatibility
function sendFileHeader(peerId, file) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        showToast('Connection not ready. Try again.', 'error');
        return;
    }

    peer.pendingFile = file;

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
    const queueIndex = peer.pendingQueueIndex;

    if (!file || !dc) return;

    let offset = 0;

    const readSlice = (o) => {
        const slice = file.slice(offset, o + CHUNK_SIZE);
        const reader = new FileReader();
        reader.onload = (e) => {
            if (dc.readyState !== 'open') return;

            dc.send(e.target.result);
            offset += e.target.result.byteLength;

            // Update per-file progress bar if batch sending
            if (queueIndex !== undefined) {
                const pct = (offset / file.size) * 100;
                const bar = document.getElementById(`sendProgress-${queueIndex}`);
                if (bar) bar.style.width = `${pct}%`;
            }

            if (offset < file.size) {
                if (dc.bufferedAmount > 1024 * 1024) {
                    setTimeout(() => readSlice(offset), 50);
                } else {
                    readSlice(offset);
                }
            } else {
                dc.send(JSON.stringify({ type: 'file-complete' }));
                peer.pendingFile = null;

                // If batch, advance queue
                if (isBatchSending && queueIndex !== undefined) {
                    currentSendIndex++;
                    sendNextInQueue(peerId);
                } else {
                    showToast('File sent successfully', 'success');
                }
            }
        };
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}

// Receiving - single file (legacy)
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

    modalTitle.textContent = `${sender.name} wants to send you a file`;
    modalContent.innerHTML = `
        <div class="file-info">
            <i class="ri-file-line"></i>
            <div class="file-details">
                <span class="file-name">${msg.name}</span>
                <span class="file-size">${formatFileSize(msg.size)}</span>
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

// Receiving - batch files
function handleIncomingBatchHeader(msg, senderId) {
    const sender = peers.get(senderId);
    if (!sender) return;

    // Show the batch incoming UI
    if (msg.index === 0) {
        incomingBatch = [];
        incomingBatchTotal = msg.total;
        incomingBatchReceived = 0;
        currentIncomingIndex = 0;

        // Build placeholder list
        batchIncomingTitle.textContent = `${sender.name} wants to send ${msg.total} file${msg.total > 1 ? 's' : ''}`;
        batchIncomingOverlay.classList.remove('hidden');

        batchIncomingActions.innerHTML = `
            <button class="btn btn-secondary" id="btnRejectBatch">Decline All</button>
            <button class="btn btn-primary" id="btnAcceptBatch">Accept All</button>
        `;

        document.getElementById('btnRejectBatch').onclick = () => {
            sender.dataChannel.send(JSON.stringify({ type: 'transfer-rejected' }));
            batchIncomingOverlay.classList.add('hidden');
            incomingFile = null;
            incomingBatch = [];
        };

        document.getElementById('btnAcceptBatch').onclick = () => {
            batchIncomingActions.innerHTML = '';
            sender.dataChannel.send(JSON.stringify({ type: 'transfer-accepted' }));
        };
    }

    // Record file info
    incomingBatch[msg.index] = { name: msg.name, size: msg.size, mime: msg.mime };
    renderIncomingBatchList();

    // Set current incoming file for chunk receiving
    incomingFile = {
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        senderId: senderId,
        batchIndex: msg.index
    };
    receivedChunks = [];
    receivedSize = 0;

    // Auto-accept subsequent files after first was accepted
    if (msg.index > 0) {
        sender.dataChannel.send(JSON.stringify({ type: 'transfer-accepted' }));
    }
}

function renderIncomingBatchList() {
    batchIncomingList.innerHTML = incomingBatch.map((f, i) => {
        if (!f) return '';
        let statusClass = 'pending';
        let statusIcon = 'ri-time-line';
        if (i < incomingBatchReceived) { statusClass = 'done'; statusIcon = 'ri-check-line'; }
        else if (i === currentIncomingIndex) { statusClass = 'active'; statusIcon = 'ri-loader-4-line'; }

        return `
            <div class="batch-file-item ${statusClass}">
                <i class="${statusIcon} batch-file-icon"></i>
                <div class="batch-file-details">
                    <span class="batch-file-name">${f.name}</span>
                    <span class="batch-file-size">${formatFileSize(f.size)}</span>
                </div>
                <div class="batch-file-progress-wrap">
                    <div class="progress-container small">
                        <div class="progress-bar" id="recvProgress-${i}" style="width:${i < incomingBatchReceived ? '100' : '0'}%"></div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    batchIncomingSummary.textContent = `${incomingBatchReceived}/${incomingBatchTotal} received`;
}

function receiveChunk(data) {
    if (!incomingFile) return;
    receivedChunks.push(data);
    receivedSize += data.byteLength;

    const progress = (receivedSize / incomingFile.size) * 100;

    // Update correct progress bar based on batch or single
    if (incomingFile.batchIndex !== undefined) {
        const bar = document.getElementById(`recvProgress-${incomingFile.batchIndex}`);
        if (bar) bar.style.width = `${progress}%`;
    } else {
        const bar = document.getElementById('receiveProgressBar');
        if (bar) bar.style.width = `${progress}%`;
    }
}

function finishReceivingFile() {
    if (!incomingFile) return;

    const blob = new Blob(receivedChunks, { type: incomingFile.mime });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = incomingFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // If batch receiving
    if (incomingFile.batchIndex !== undefined) {
        incomingBatchReceived++;
        currentIncomingIndex = incomingFile.batchIndex + 1;
        renderIncomingBatchList();

        if (incomingBatchReceived >= incomingBatchTotal) {
            batchIncomingSummary.textContent = `All ${incomingBatchTotal} files received!`;
            batchIncomingActions.innerHTML = `<button class="btn btn-primary" id="btnCloseIncoming">Done</button>`;
            document.getElementById('btnCloseIncoming').onclick = () => {
                batchIncomingOverlay.classList.add('hidden');
            };
            showToast(`Received ${incomingBatchTotal} files`, 'success');
        }
    } else {
        showToast(`Received ${incomingFile.name}`, 'success');
        modalOverlay.classList.add('hidden');
    }

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
    const files = Array.from(e.target.files);
    if (!files.length) return;
    shareFileInput.value = '';

    const totalSize = files.reduce((s, f) => s + f.size, 0);

    modalTitle.textContent = `Uploading ${files.length} File${files.length > 1 ? 's' : ''}`;
    modalContent.innerHTML = `
        <div class="batch-file-list" id="uploadFileList">
            ${files.map((f, i) => `
                <div class="batch-file-item">
                    <i class="ri-upload-cloud-line batch-file-icon"></i>
                    <div class="batch-file-details">
                        <span class="batch-file-name">${f.name}</span>
                        <span class="batch-file-size">${formatFileSize(f.size)}</span>
                    </div>
                </div>
            `).join('')}
        </div>
        <div class="progress-container" id="uploadProgressContainer">
            <div class="progress-bar" id="uploadProgressBar"></div>
        </div>
        <p class="upload-status" id="uploadStatus">Uploading ${files.length} file${files.length > 1 ? 's' : ''}... (${formatFileSize(totalSize)})</p>
    `;
    modalActions.innerHTML = '';
    modalOverlay.classList.remove('hidden');

    try {
        const formData = new FormData();
        files.forEach(f => formData.append('files', f));

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
                showToast('Upload failed. Files may be too large (max 100MB each).', 'error');
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
    const filesList = data.files || [data]; // backward compat
    const totalSize = filesList.reduce((s, f) => s + f.size, 0);

    modalTitle.textContent = `${filesList.length} File${filesList.length > 1 ? 's' : ''} Ready to Share`;
    modalContent.innerHTML = `
        <div class="batch-file-list" style="max-height: 200px; overflow-y: auto; margin-bottom: 1rem;">
            ${filesList.map(f => `
                <div class="batch-file-item done">
                    <i class="ri-check-line batch-file-icon"></i>
                    <div class="batch-file-details">
                        <span class="batch-file-name">${f.name}</span>
                        <span class="batch-file-size">${formatFileSize(f.size)}</span>
                    </div>
                    <div class="share-link-box compact">
                        <input type="text" class="share-link-value" value="${f.url}" readonly />
                        <button class="btn-copy btn-copy-link" data-url="${f.url}" title="Copy link">
                            <i class="ri-file-copy-line"></i>
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
        <p class="share-link-note">${filesList.length} file${filesList.length > 1 ? 's' : ''} \u2022 ${formatFileSize(totalSize)} \u2022 Links expire in ${filesList[0].expiresIn}</p>
    `;
    modalActions.innerHTML = `
        <button class="btn btn-secondary" id="btnCopyAll"><i class="ri-file-copy-line"></i> Copy All Links</button>
        <button class="btn btn-primary" id="btnCloseShare">Done</button>
    `;

    document.getElementById('btnCloseShare').onclick = () => {
        modalOverlay.classList.add('hidden');
    };

    document.getElementById('btnCopyAll').onclick = () => {
        const allLinks = filesList.map(f => f.url).join('\n');
        navigator.clipboard.writeText(allLinks).then(() => {
            showToast('All links copied to clipboard!', 'success');
        });
    };

    modalContent.querySelectorAll('.btn-copy-link').forEach(btn => {
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.dataset.url).then(() => {
                showToast('Link copied!', 'success');
            });
        });
    });
}

// Start
connectSignaling();
