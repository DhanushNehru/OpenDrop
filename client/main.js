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

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

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

// --- Transfer State ---
let currentTransferTarget = null;
let transferInProgress = false;

// Receiver state
let incomingBatch = null;
let receivedChunks = [];
let currentFileReceivedSize = 0;
let batchReceivedSize = 0;

// Sender state
let outgoingBatch = null;

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

    // Click to send file(s)
    el.addEventListener('click', () => {
        currentTransferTarget = id;
        fileInput.click();
    });

    // Drag-and-drop support
    el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('drag-over');
    });

    el.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('drag-over');
    });

    el.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
    });

    el.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        if (transferInProgress) {
            showToast('A transfer is already in progress', 'error');
            return;
        }

        currentTransferTarget = id;
        await initiateTransfer(id, files);
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
// Data Channel & Batch Transfer Protocol
// ---------------------------

function setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => console.log(`DataChannel open with ${peers.get(peerId)?.name}`);
    dc.onclose = () => console.log(`DataChannel closed with ${peers.get(peerId)?.name}`);

    dc.onmessage = (e) => {
        if (typeof e.data === 'string') {
               let msg;
             try {
                 msg = JSON.parse(e.data);
             } catch (err) {
                 console.warn('Received invalid JSON over data channel from peer', peerId, err, e.data);
                 return;
             }
            switch (msg.type) {
                // Receiver-side messages
                case 'batch-header':
                    handleIncomingBatchRequest(msg, peerId);
                    break;
                case 'file-start':
                    handleFileStart(msg);
                    break;
                case 'file-complete':
                    handleFileComplete(msg);
                    break;
                case 'batch-complete':
                    handleBatchComplete();
                    break;
                case 'batch-cancelled':
                    handleBatchCancelled();
                    break;

                // Sender-side messages
                case 'batch-accepted':
                    startSendingBatch(peerId);
                    break;
                case 'batch-rejected':
                    showToast('Transfer was declined', 'error');
                    outgoingBatch = null;
                    transferInProgress = false;
                    modalOverlay.classList.add('hidden');
                    document.querySelector('.modal').classList.remove('batch-modal');
                    break;
            }
        } else {
            // Binary data = file chunk
            receiveChunk(e.data);
        }
    };
}

// ---------------------------
// File Selection & Transfer Initiation
// ---------------------------

fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length || !currentTransferTarget) return;

    if (transferInProgress) {
        showToast('A transfer is already in progress', 'error');
        fileInput.value = '';
        return;
    }

    await initiateTransfer(currentTransferTarget, files);
    fileInput.value = '';
});

async function initiateTransfer(peerId, files) {
    const peer = peers.get(peerId);

    // If the peer no longer exists, bail out and reset any transfer state
      if (!peer) {
          if (typeof transferInProgress !== 'undefined') {
              transferInProgress = false;
          }
          if (typeof outgoingBatch !== 'undefined') {
              outgoingBatch = null;
          }
          showToast('The selected recipient is no longer available.', 'error');
          return;
      }
     // Mark transfer as in progress as soon as a transfer is initiated
     if (typeof transferInProgress !== 'undefined') {
         transferInProgress = true;
     }
     if (!peer.connection || peer.connection.connectionState !== 'connected') {
         try {
              await startConnection(peerId);
          } catch (err) {
              // Failed to establish the connection: reset transfer state and notify the user
              if (typeof transferInProgress !== 'undefined') {
                  transferInProgress = false;
              }
              if (typeof outgoingBatch !== 'undefined') {
                  outgoingBatch = null;
              }
              showToast('Unable to start connection. Please try again.', 'error');
              return;
          }

         const maxWaitMs = 10000; // maximum time to wait for data channel to open
         const pollIntervalMs = 200;
         const startTime = Date.now();

         const waitForChannel = () => {
             const elapsed = Date.now() - startTime;
             const p = peers.get(peerId);
             if (p?.dataChannel?.readyState === 'open')
                 {
                 sendBatchHeader(peerId, files);
             } 
             else if (elapsed >= maxWaitMs)
                 {
                 // Timeout: reset any pending transfer state and notify the user
                 if (typeof transferInProgress !== 'undefined') {
                     transferInProgress = false;
                 }
                 if (typeof outgoingBatch !== 'undefined')
                     {
                     outgoingBatch = null;
                 }
                 showToast('Unable to establish data channel. Please ensure the recipient is online and try again.', 'error');
             } 
             else 
                {
                 setTimeout(waitForChannel, pollIntervalMs);
             }
         };
         setTimeout(waitForChannel, 500);
     } 
     else 
        {
         sendBatchHeader(peerId, files);
     }
    }

// ---------------------------
// Sender Flow
// ---------------------------

function sendBatchHeader(peerId, files) {
    const peer = peers.get(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') {
          // Data channel is not ready: reset transfer state to avoid leaving UI stuck
         if (typeof transferInProgress !== 'undefined') {
             transferInProgress = false;
         }
         if (typeof outgoingBatch !== 'undefined') {
             outgoingBatch = null;
         }
        showToast('Connection not ready. Try again.', 'error');
        return;
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    outgoingBatch = {
        targetPeerId: peerId,
        files: files,
        totalSize: totalSize,
        currentFileIndex: 0,
        currentFileOffset: 0,
    };
    transferInProgress = true;

    peer.dataChannel.send(JSON.stringify({
        type: 'batch-header',
        files: files.map(f => ({ name: f.name, size: f.size, mime: f.type })),
        totalSize: totalSize,
        fileCount: files.length,
    }));

    showSenderModal(peer.name, files, totalSize);
}

function showSenderModal(peerName, files, totalSize) {
    const modalEl = document.querySelector('.modal');
    modalEl.classList.add('batch-modal');

    modalTitle.textContent = `Sending to ${peerName}`;
    modalContent.innerHTML = `
        <div class="batch-summary">
            <span>${files.length} file${files.length > 1 ? 's' : ''}</span>
            <span class="file-size">${formatSize(totalSize)}</span>
        </div>
        <div class="file-list" id="senderFileList">
        </div>
        <div class="progress-container" id="senderOverallProgress">
            <div class="progress-bar" id="senderOverallBar"></div>
        </div>
        <p class="upload-status" id="senderStatusText">Waiting for acceptance...</p>
    `;

    // Populate file list using DOM APIs to avoid injecting filenames into innerHTML
     const senderFileListEl = document.getElementById('senderFileList');
     files.forEach((f, i) => {
         const itemEl = document.createElement('div');
         itemEl.className = 'file-list-item';
         itemEl.id = `sendFile${i}`;
         const iconEl = document.createElement('i');
         iconEl.className = 'ri-file-line';
         const detailsEl = document.createElement('div');
         detailsEl.className = 'file-details';
         const nameEl = document.createElement('span');
         nameEl.className = 'file-name';
         nameEl.textContent = f.name;
         const sizeEl = document.createElement('span');
         sizeEl.className = 'file-size';
         sizeEl.textContent = formatSize(f.size);
         detailsEl.appendChild(nameEl);
         detailsEl.appendChild(sizeEl);
         const statusEl = document.createElement('div');
         statusEl.className = 'file-status';
         statusEl.id = `sendStatus${i}`;
         const statusIconEl = document.createElement('i');
         statusIconEl.className = 'ri-time-line';
         statusEl.appendChild(statusIconEl);
         itemEl.appendChild(iconEl);
         itemEl.appendChild(detailsEl);
         itemEl.appendChild(statusEl);
         senderFileListEl.appendChild(itemEl);
     });

    modalActions.innerHTML = `
        <button class="btn btn-secondary" id="btnCancelSend">Cancel</button>
    `;
    modalOverlay.classList.remove('hidden');

    document.getElementById('btnCancelSend').onclick = () => {
        const peer = peers.get(outgoingBatch?.targetPeerId);
        if (peer?.dataChannel) {
            if (peer.dataChannel.readyState === 'open') {
                peer.dataChannel.send(JSON.stringify({ type: 'batch-cancelled' }));
            }
            try {
                peer.dataChannel.close();
            } catch (e) {
                // Ignore errors while closing the data channel on cancel
            }
        }
        outgoingBatch = null;
        transferInProgress = false;
        modalOverlay.classList.add('hidden');
        modalEl.classList.remove('batch-modal');
    };
}

function startSendingBatch(peerId) {
    if (!outgoingBatch) return;

    const statusEl = document.getElementById('senderStatusText');
    if (statusEl) statusEl.textContent = 'Sending...';

    sendNextFileInBatch(peerId);
}

function sendNextFileInBatch(peerId) {
    const batch = outgoingBatch;
    if (!batch) return;

    const peer = peers.get(peerId);
    const dc = peer && peer.dataChannel ? peer.dataChannel : null;
     if (!dc || dc.readyState !== 'open') {
         const statusEl = document.getElementById('senderStatusText');
         if (statusEl) {
             statusEl.textContent = 'Transfer canceled: receiver disconnected.';
         }
         if (typeof modalOverlay !== 'undefined' && modalOverlay) {
             modalOverlay.classList.add('hidden');
         }
         const modalEl = document.querySelector('.modal');
         if (modalEl) {
             modalEl.classList.remove('batch-modal');
         }
         outgoingBatch = null;
         transferInProgress = false;
         return;
     }
    const fileIndex = batch.currentFileIndex;
     if (fileIndex < 0 || fileIndex >= batch.files.length) {
         // Invalid index; reset transfer state to avoid inconsistent behavior.
         outgoingBatch = null;
         transferInProgress = false;
         return;
     }
    const file = batch.files[fileIndex];

    // Mark this file as active in sender UI
    const fileEl = document.getElementById(`sendFile${fileIndex}`);
    if (fileEl) fileEl.classList.add('active');
    const statusIcon = document.getElementById(`sendStatus${fileIndex}`);
    if (statusIcon) statusIcon.innerHTML = '<i class="ri-loader-4-line"></i>';

    // Notify receiver which file is starting
    dc.send(JSON.stringify({
        type: 'file-start',
        index: fileIndex,
        name: file.name,
        size: file.size,
        mime: file.type,
    }));

    let offset = 0;
    batch.currentFileOffset = 0;

    const readSlice = (o) => {
        const slice = file.slice(o, o + CHUNK_SIZE);
        const reader = new FileReader();
        reader.onload = (evt) => {
             // If the data channel is no longer available, abort and reset state.
             if (!dc || dc.readyState !== 'open') {
                 outgoingBatch = null;
                 transferInProgress = false;
                 const statusEl = document.getElementById('senderStatusText');
                 if (statusEl) {
                     statusEl.textContent = 'Transfer canceled: receiver disconnected.';
                 }
                 // Also close the modal and clear batch-specific styling so the UI
                 // does not remain stuck in a "sending" state.
                 if (typeof modalOverlay !== 'undefined' && modalOverlay) {
                     modalOverlay.classList.add('hidden');
                 }
                 const modalEl = document.querySelector('.modal');
                 if (modalEl) {
                     modalEl.classList.remove('batch-modal');
                 }
                 return;
             }

            dc.send(evt.target.result);
            offset += evt.target.result.byteLength;
            batch.currentFileOffset = offset;

            updateSenderProgress(batch);

            if (offset < file.size) {
                if (dc.bufferedAmount > 1024 * 1024) {
                    setTimeout(() => readSlice(offset), 50);
                } else {
                    readSlice(offset);
                }
            } else {
                dc.send(JSON.stringify({
                    type: 'file-complete',
                    index: fileIndex,
                }));

                if (fileEl) {
                    fileEl.classList.remove('active');
                    fileEl.classList.add('completed');
                }
                if (statusIcon) statusIcon.innerHTML = '<i class="ri-check-line"></i>';

                batch.currentFileIndex++;
                batch.currentFileOffset = 0;

                if (batch.currentFileIndex < batch.files.length) {
                    sendNextFileInBatch(peerId);
                } else {
                    dc.send(JSON.stringify({ type: 'batch-complete' }));

                    const statusEl = document.getElementById('senderStatusText');
                    if (statusEl) {
                        statusEl.textContent = `All ${batch.files.length} file${batch.files.length > 1 ? 's' : ''} sent!`;
                    }

                    modalActions.innerHTML =
                        '<button class="btn btn-primary" id="btnCloseSender">Done</button>';
                    document.getElementById('btnCloseSender').onclick = () => {
                        modalOverlay.classList.add('hidden');
                        document.querySelector('.modal').classList.remove('batch-modal');
                        outgoingBatch = null;
                        transferInProgress = false;
                    };

                    showToast(`Sent ${batch.files.length} file${batch.files.length > 1 ? 's' : ''} successfully`, 'success');
                }
            }
        };
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}

function updateSenderProgress(batch) {
    let bytesSent = 0;
    for (let i = 0; i < batch.currentFileIndex; i++) {
        bytesSent += batch.files[i].size;
    }
    bytesSent += batch.currentFileOffset;

    const overallPct = batch.totalSize > 0 ? (bytesSent / batch.totalSize) * 100 : 0;

    const bar = document.getElementById('senderOverallBar');
    if (bar) bar.style.width = `${overallPct}%`;

    const statusEl = document.getElementById('senderStatusText');
    if (statusEl) {
        statusEl.textContent = `Sending file ${batch.currentFileIndex + 1} of ${batch.files.length} (${Math.round(overallPct)}%)`;
    }
}

// ---------------------------
// Receiver Flow
// ---------------------------

function handleIncomingBatchRequest(msg, senderId) {
    const sender = peers.get(senderId);
    if (!sender) return;

    if (transferInProgress) {
        if (sender.dataChannel?.readyState === 'open') {
            sender.dataChannel.send(JSON.stringify({ type: 'batch-rejected' }));
        }
        showToast(`Declined files from ${sender.name} — transfer in progress`, 'error');
        return;
    }
    // Validate incoming batch header from untrusted peer
     const files = msg && msg.files;
     const totalSize = msg && msg.totalSize;
     const filesValid = Array.isArray(files);
     const totalSizeValid =
         typeof totalSize === 'number' && Number.isFinite(totalSize) && totalSize >= 0;
     if (!filesValid || !totalSizeValid) {
         if (sender.dataChannel?.readyState === 'open') {
             sender.dataChannel.send(JSON.stringify({ type: 'batch-rejected' }));
         }
         console.warn('Received invalid batch-header from peer', senderId, msg);
         showToast(`Received invalid file transfer request from ${sender.name}`, 'error');
         return;
     }

    transferInProgress = true;
     const fileCount = files.length;

    incomingBatch = {
        senderId: senderId,
        files: files,
        totalSize: totalSize,
        currentFileIndex: -1,
        receivedFiles: [],
    };
    receivedChunks = [];
    currentFileReceivedSize = 0;
    batchReceivedSize = 0;

    const modalEl = document.querySelector('.modal');
    modalEl.classList.add('batch-modal');

    modalTitle.textContent = `${sender.name} wants to send ${fileCount} file${fileCount > 1 ? 's' : ''}`;
    modalContent.innerHTML = `
        <div class="batch-summary">
            <span>${fileCount} file${fileCount > 1 ? 's' : ''}</span>
            <span class="file-size">${formatSize(totalSize)}</span>
        </div>
        <div class="file-list" id="receiverFileList">
        </div>
        <div class="progress-container hidden" id="receiveOverallProgressContainer">
            <div class="progress-bar" id="receiveOverallBar"></div>
        </div>
    `;
     const receiverFileListEl = document.getElementById('receiverFileList');
     msg.files.forEach((f, i) => {
         const itemEl = document.createElement('div');
         itemEl.className = 'file-list-item';
         itemEl.id = `recvFile${i}`;
         const iconEl = document.createElement('i');
         iconEl.className = 'ri-file-line';
         itemEl.appendChild(iconEl);
         const detailsEl = document.createElement('div');
         detailsEl.className = 'file-details';
         const nameEl = document.createElement('span');
         nameEl.className = 'file-name';
         nameEl.textContent = f.name;
         detailsEl.appendChild(nameEl);
         const sizeEl = document.createElement('span');
         sizeEl.className = 'file-size';
         sizeEl.textContent = formatSize(f.size);
         detailsEl.appendChild(sizeEl);
         itemEl.appendChild(detailsEl);
         const progressMiniEl = document.createElement('div');
         progressMiniEl.className = 'file-progress-mini hidden';
         progressMiniEl.id = `recvProgress${i}`;
         const progressBarMiniEl = document.createElement('div');
         progressBarMiniEl.className = 'progress-bar-mini';
         progressBarMiniEl.id = `recvBar${i}`;
         progressMiniEl.appendChild(progressBarMiniEl);
         itemEl.appendChild(progressMiniEl);
         const statusEl = document.createElement('div');
         statusEl.className = 'file-status';
         statusEl.id = `recvStatus${i}`;
         const statusIconEl = document.createElement('i');
         statusIconEl.className = 'ri-time-line';
         statusEl.appendChild(statusIconEl);
         itemEl.appendChild(statusEl);
         receiverFileListEl.appendChild(itemEl);
     });

    modalActions.innerHTML = `
        <button class="btn btn-secondary" id="btnRejectBatch">Decline All</button>
        <button class="btn btn-primary" id="btnAcceptBatch">Accept All</button>
    `;
    modalOverlay.classList.remove('hidden');

    document.getElementById('btnRejectBatch').onclick = () => {
        if (sender.dataChannel?.readyState === 'open') {
            sender.dataChannel.send(JSON.stringify({ type: 'batch-rejected' }));
        }
        modalOverlay.classList.add('hidden');
        modalEl.classList.remove('batch-modal');
        incomingBatch = null;
        transferInProgress = false;
    };

    document.getElementById('btnAcceptBatch').onclick = () => {
        if (sender.dataChannel?.readyState === 'open') {
            document.getElementById('btnRejectBatch').style.display = 'none';
            document.getElementById('btnAcceptBatch').style.display = 'none';
            document.getElementById('receiveOverallProgressContainer').classList.remove('hidden');
            sender.dataChannel.send(JSON.stringify({ type: 'batch-accepted' }));
        } else {
            // Data channel is no longer available; clean up UI and state
            modalOverlay.classList.add('hidden');
            modalEl.classList.remove('batch-modal');
            incomingBatch = null;
            transferInProgress = false;
        }
    };
}

function handleFileStart(msg) {
    if (!incomingBatch || !incomingBatch.files || !Array.isArray(incomingBatch.files)) return;
    
     const index = Number(msg.index);
     if (!Number.isInteger(index) || index < 0 || index >= incomingBatch.files.length) {
         console.warn('Received invalid file index in handleFileStart:', msg.index);
         return;
     }
     incomingBatch.currentFileIndex = index;
    receivedChunks = [];
    currentFileReceivedSize = 0;

    const fileEl = document.getElementById(`recvFile${index}`);
    if (fileEl) fileEl.classList.add('active');

    const statusIcon = document.getElementById(`recvStatus${index}`);
    if (statusIcon) statusIcon.innerHTML = '<i class="ri-loader-4-line"></i>';

    const progressEl = document.getElementById(`recvProgress${index}`);
    if (progressEl) progressEl.classList.remove('hidden');
}

function receiveChunk(data) {
    if (
         !incomingBatch ||
         !incomingBatch.files ||
         !Array.isArray(incomingBatch.files) ||
         incomingBatch.currentFileIndex < 0 ||
         incomingBatch.currentFileIndex >= incomingBatch.files.length
     ) 
     {
         return;
     }

    receivedChunks.push(data);
    currentFileReceivedSize += data.byteLength;
    batchReceivedSize += data.byteLength;

   const currentFile =
         incomingBatch.files && incomingBatch.files[incomingBatch.currentFileIndex];
     if (!currentFile) {
         console.warn('Received chunk for invalid/missing file; resetting incoming batch', {
             currentFileIndex: incomingBatch.currentFileIndex,
             filesLength: incomingBatch.files ? incomingBatch.files.length : undefined,
         });
         // Reset transfer state to avoid processing data for an unknown file.
         incomingBatch = null;
         receivedChunks = [];
         currentFileReceivedSize = 0;
         batchReceivedSize = 0;
           // Also clear any global transfer-in-progress flag and close the incoming transfer UI.
          if (typeof transferInProgress !== 'undefined') {
              transferInProgress = false;
          }
          // Hide the batch transfer modal overlay using the same elements used elsewhere.
          if (typeof modalOverlay !== 'undefined' && modalOverlay) {
              modalOverlay.classList.add('hidden');
          }
          // Remove the batch-modal state from the main modal element.
          let modalEl = (typeof modal !== 'undefined' && modal) ? modal : document.querySelector('.modal');
          if (modalEl) {
              modalEl.classList.remove('batch-modal');
          }
         return;
     }
     const filePct =
         currentFile.size > 0 ? (currentFileReceivedSize / currentFile.size) * 100 : 0;
    const miniBar = document.getElementById(`recvBar${incomingBatch.currentFileIndex}`);
    if (miniBar) miniBar.style.width = `${filePct}%`;

     const overallPct = incomingBatch.totalSize > 0 ? (batchReceivedSize / incomingBatch.totalSize) * 100 : 0;
    const overallBar = document.getElementById('receiveOverallBar');
    if (overallBar) overallBar.style.width = `${overallPct}%`;
}

function handleFileComplete(msg) {
    if (!incomingBatch) return;

    // Coerce the incoming index to an integer (data channel JSON may deserialize as string).
    let completedIndex = msg.index;
    if (typeof completedIndex === 'string') {
        completedIndex = parseInt(completedIndex, 10);
    }

    // Validate the coerced index; treat invalid indices as out-of-order.
    if (!Number.isInteger(completedIndex)) {
        console.warn('Invalid fileComplete index; resetting incoming batch', {
            expectedIndex: incomingBatch.currentFileIndex,
            receivedIndex: msg.index,
            normalizedIndex: completedIndex,
        });
        // Reset transfer state to avoid associating incorrect data with a file.
        transferInProgress = false;
        incomingBatch = null;
        receivedChunks = [];
        currentFileReceivedSize = 0;
        batchReceivedSize = 0;
        transferInProgress = false;
        // Also close any visible batch modal and overlay, matching other cancel/close paths.
        const modalOverlay = document.getElementById('modalOverlay');
        if (modalOverlay) {
            modalOverlay.classList.add('hidden');
        }
        document.querySelectorAll('.modal.batch-modal').forEach((modal) => {
           modal.classList.remove('batch-modal');
             modal.classList.add('hidden');
        });
        return;
    }

    // Ensure the completed file index matches the file currently being received.
    if (completedIndex !== incomingBatch.currentFileIndex) {
        console.warn('Out-of-order fileComplete message; resetting incoming batch', {
            expectedIndex: incomingBatch.currentFileIndex,
            receivedIndex: msg.index,
            normalizedIndex: completedIndex,
        });
        // Reset transfer state to avoid associating incorrect data with a file.
         transferInProgress = false;
        incomingBatch = null;
        receivedChunks = [];
        currentFileReceivedSize = 0;
        batchReceivedSize = 0;
        // Also close any visible batch modal and overlay, matching other cancel/close paths.
        const modalOverlay = document.getElementById('modalOverlay');
        if (modalOverlay) {
            modalOverlay.classList.add('hidden');
        }
        document.querySelectorAll('.modal.batch-modal').forEach((modal) => {
            modal.classList.remove('batch-modal');
             modal.classList.add('hidden');
        });
        return;
    }

    const fileInfo = incomingBatch.files[completedIndex];

     if (!fileInfo) {
         console.warn('Missing file info for completed file; resetting incoming batch', {
             index: msg.index,
         });
         incomingBatch = null;
         receivedChunks = [];
         currentFileReceivedSize = 0;
         batchReceivedSize = 0;
         return;
     }

    const blob = new Blob(receivedChunks, { type: fileInfo.mime });

    incomingBatch.receivedFiles.push({ name: fileInfo.name, blob: blob });

    const fileEl = document.getElementById(`recvFile${msg.index}`);
    if (fileEl) {
        fileEl.classList.remove('active');
        fileEl.classList.add('completed');
    }
    const statusIcon = document.getElementById(`recvStatus${msg.index}`);
    if (statusIcon) statusIcon.innerHTML = '<i class="ri-check-line"></i>';

    const progressEl = document.getElementById(`recvProgress${msg.index}`);
    if (progressEl) progressEl.classList.add('hidden');

    receivedChunks = [];
    currentFileReceivedSize = 0;
}

function handleBatchComplete() {
    if (!incomingBatch) return;

    const fileCount = incomingBatch.receivedFiles.length;
    showToast(`Received ${fileCount} file${fileCount > 1 ? 's' : ''}`, 'success');

    incomingBatch.receivedFiles.forEach((rf, i) => {
        const targetIndex = (typeof rf.index === 'number') ? rf.index : i;
        const fileEl = document.getElementById(`recvFile${targetIndex}`);
        if (fileEl) {
            const btn = document.createElement('button');
            btn.className = 'file-download-btn';
            btn.title = `Download ${rf.name}`;
            btn.setAttribute('aria-label', `Download ${rf.name}`);
            btn.innerHTML = '<i class="ri-download-line"></i>';
            btn.onclick = () => downloadBlob(rf.blob, rf.name);
            fileEl.appendChild(btn);
        }
    });

    modalActions.innerHTML = `
        <button class="btn btn-secondary" id="btnCloseBatch">Close</button>
        <button class="btn btn-primary" id="btnDownloadAll">
            <i class="ri-download-line"></i> Download All
        </button>
    `;

    document.getElementById('btnCloseBatch').onclick = () => {
        modalOverlay.classList.add('hidden');
        document.querySelector('.modal').classList.remove('batch-modal');
        incomingBatch = null;
        transferInProgress = false;
    };

    document.getElementById('btnDownloadAll').onclick = () => {
        incomingBatch.receivedFiles.forEach((rf, i) => {
            setTimeout(() => downloadBlob(rf.blob, rf.name), i * 300);
        });
    };
}

function handleBatchCancelled() {
    showToast('Transfer was cancelled', 'error');
    modalOverlay.classList.add('hidden');
    document.querySelector('.modal').classList.remove('batch-modal');
    incomingBatch = null;
    outgoingBatch = null;
    receivedChunks = [];
    transferInProgress = false;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    const modalEl = document.querySelector('.modal');
    modalEl.classList.add('batch-modal');

    modalTitle.textContent = `Uploading ${files.length} File${files.length > 1 ? 's' : ''}`;
    modalContent.innerHTML = `
        <div class="batch-summary">
            <span>${files.length} file${files.length > 1 ? 's' : ''}</span>
            <span class="file-size">${formatSize(totalSize)}</span>
        </div>
         <div class="file-list"></div>
        <div class="progress-container" id="uploadProgressContainer">
            <div class="progress-bar" id="uploadProgressBar"></div>
        </div>
        <p class="upload-status" id="uploadStatus">Uploading...</p>
    `;

     const fileListEl = modalContent.querySelector('.file-list');
     if (fileListEl) {
         files.forEach((f, i) => {
             const item = document.createElement('div');
             item.className = 'file-list-item';
             item.id = `uploadFile${i}`;
             const icon = document.createElement('i');
             icon.className = 'ri-upload-cloud-line';
             item.appendChild(icon);
             const details = document.createElement('div');
             details.className = 'file-details';
             const nameSpan = document.createElement('span');
             nameSpan.className = 'file-name';
             nameSpan.textContent = f.name;
             const sizeSpan = document.createElement('span');
             sizeSpan.className = 'file-size';
             sizeSpan.textContent = formatSize(f.size);
             details.appendChild(nameSpan);
             details.appendChild(sizeSpan);
             item.appendChild(details);
             fileListEl.appendChild(item);
         });
     }

    modalActions.innerHTML = '';
    modalOverlay.classList.remove('hidden');

    try {
        const formData = new FormData();
        files.forEach(f => formData.append('files', f));

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/upload-batch`);

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
                showBatchShareResult(data);
            } else {
                showToast('Upload failed. Files may be too large.', 'error');
                modalOverlay.classList.add('hidden');
                modalEl.classList.remove('batch-modal');
            }
        };

        xhr.onerror = () => {
            showToast('Upload failed. Check your connection.', 'error');
            modalOverlay.classList.add('hidden');
            modalEl.classList.remove('batch-modal');
        };

        xhr.send(formData);
    } catch (err) {
        showToast('Upload failed.', 'error');
        modalOverlay.classList.add('hidden');
        modalEl.classList.remove('batch-modal');
    }
});

function showBatchShareResult(data) {
    modalTitle.textContent = `${data.files.length} File${data.files.length > 1 ? 's' : ''} Ready to Share`;
     // Clear any existing content
     modalContent.innerHTML = '';
     // Create the file list container
     const fileListContainer = document.createElement('div');
     fileListContainer.className = 'file-list';
     data.files.forEach((f, i) => {
         // File list item
         const fileListItem = document.createElement('div');
         fileListItem.className = 'file-list-item';
         const checkIcon = document.createElement('i');
         checkIcon.className = 'ri-check-double-line';
         fileListItem.appendChild(checkIcon);
         const fileDetails = document.createElement('div');
         fileDetails.className = 'file-details';
         const fileNameSpan = document.createElement('span');
         fileNameSpan.className = 'file-name';
         fileNameSpan.textContent = f.name;
         const fileSizeSpan = document.createElement('span');
         fileSizeSpan.className = 'file-size';
         fileSizeSpan.textContent = formatSize(f.size);
         fileDetails.appendChild(fileNameSpan);
         fileDetails.appendChild(fileSizeSpan);
         fileListItem.appendChild(fileDetails);
         fileListContainer.appendChild(fileListItem);
         // Share link box
         const shareLinkBox = document.createElement('div');
         shareLinkBox.className = 'share-link-box';
         const input = document.createElement('input');
         input.type = 'text';
         input.id = `shareLink${i}`;
         input.value = f.url;
         input.readOnly = true;
         const copyButton = document.createElement('button');
         copyButton.className = 'btn-copy';
         copyButton.id = `copyBtn${i}`;
         copyButton.title = 'Copy link';
         copyButton.setAttribute('aria-label', 'Copy link');
         const copyIcon = document.createElement('i');
         copyIcon.className = 'ri-file-copy-line';
         copyButton.appendChild(copyIcon);
         shareLinkBox.appendChild(input);
         shareLinkBox.appendChild(copyButton);
         fileListContainer.appendChild(shareLinkBox);
     });
     modalContent.appendChild(fileListContainer);
     const expiresNote = document.createElement('p');
     expiresNote.className = 'share-link-note';
     expiresNote.textContent = `Links expire in ${data.expiresIn}`;
     modalContent.appendChild(expiresNote);


    modalActions.innerHTML = `
        <button class="btn btn-secondary" id="btnCopyAll">Copy All Links</button>
        <button class="btn btn-primary" id="btnCloseShare">Done</button>
    `;

    data.files.forEach((f, i) => {
        document.getElementById(`copyBtn${i}`).onclick = () => {
            navigator.clipboard.writeText(f.url).then(() => {
                showToast('Link copied!', 'success');
            });
        };
    });

    document.getElementById('btnCopyAll').onclick = () => {
        const allLinks = data.files.map(f => f.url).join('\n');
        navigator.clipboard.writeText(allLinks).then(() => {
            showToast('All links copied to clipboard!', 'success');
        });
    };

    document.getElementById('btnCloseShare').onclick = () => {
        modalOverlay.classList.add('hidden');
        document.querySelector('.modal').classList.remove('batch-modal');
    };
}

// Prevent browser default file drop behavior
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Start
connectSignaling();
