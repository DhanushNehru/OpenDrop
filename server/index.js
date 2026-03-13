const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

// Health check endpoint for Koyeb/Render/Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ---------------------------
// File Upload & Shareable Links
// ---------------------------

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FILE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory metadata store: id -> { originalName, mimeType, filePath, expiresAt }
const uploadedFiles = new Map();

// Multer config: store in uploads/ with unique filenames
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE }
});

// Upload endpoint (supports single and multiple files)
app.post('/upload', upload.array('files', 20), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const expiresAt = Date.now() + FILE_EXPIRY_MS;

    const results = req.files.map(file => {
        const fileId = uuidv4();
        uploadedFiles.set(fileId, {
            originalName: file.originalname,
            mimeType: file.mimetype,
            filePath: file.path,
            size: file.size,
            expiresAt
        });
        return {
            id: fileId,
            url: `${protocol}://${host}/download/${fileId}`,
            name: file.originalname,
            size: file.size,
            expiresIn: '24 hours'
        };
    });

    // Backwards compatibility:
    // - If exactly one file is uploaded, return both the legacy single-object shape
    //   and the new `{ files: [...] }` shape.
    // - If multiple files are uploaded, return only `{ files: [...] }`.
    if (results.length === 1) {
        const file = results[0];
        return res.json({
            ...file,
            files: [file]
        });
    }

    res.json({ files: results });
});

// Download endpoint
app.get('/download/:id', (req, res) => {
    const fileId = req.params.id;
    const meta = uploadedFiles.get(fileId);

    if (!meta) {
        return res.status(404).send('File not found or has expired.');
    }

    if (Date.now() > meta.expiresAt) {
        // Clean up expired file
        fs.unlink(meta.filePath, () => {});
        uploadedFiles.delete(fileId);
        return res.status(410).send('File has expired.');
    }

    if (!fs.existsSync(meta.filePath)) {
        uploadedFiles.delete(fileId);
        return res.status(404).send('File not found.');
    }

    res.download(meta.filePath, meta.originalName);
});

// Periodic cleanup of expired files (every 30 minutes)
setInterval(() => {
    const now = Date.now();
    uploadedFiles.forEach((meta, id) => {
        if (now > meta.expiresAt) {
            fs.unlink(meta.filePath, () => {});
            uploadedFiles.delete(id);
        }
    });
}, 30 * 60 * 1000);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to store connected clients
// Key: WebSocket instance
// Value: { id, name, ip, socket }
const clients = new Map();

// Helper functions for names
const ADJECTIVES = ['Cool', 'Happy', 'Brave', 'Smart', 'Swift', 'Silent', 'Mighty', 'Clever', 'Wild', 'Calm'];
const ANIMALS = ['Fox', 'Panda', 'Tiger', 'Eagle', 'Dolphin', 'Wolf', 'Owl', 'Bear', 'Falcon', 'Panther'];

function generateName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    return `${adj} ${animal}`;
}

// Extract IP, handling proxies
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

// Get all clients with the same IP (same network)
function getPeers(ip, excludeId) {
    const peers = [];
    clients.forEach((client) => {
        if (client.ip === ip && client.id !== excludeId) {
            peers.push({
                id: client.id,
                name: client.name
            });
        }
    });
    return peers;
}

// Send a message to a specific client
function sendToClient(targetId, message) {
    clients.forEach((client) => {
        if (client.id === targetId && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(message));
        }
    });
}

// Broadcast a message to all users on the same network (excluding sender)
function broadcastToNetwork(ip, excludeId, message) {
    clients.forEach((client) => {
        if (client.ip === ip && client.id !== excludeId && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws, req) => {
    const id = uuidv4();
    const name = generateName();
    const ip = getClientIp(req);

    // Register client
    clients.set(ws, { id, name, ip, socket: ws });

    console.log(`[+] Client connected: ${name} (${id}) from IP: ${ip}`);

    // Send the client their own info and the list of current peers on their network
    ws.send(JSON.stringify({
        type: 'init',
        id: id,
        name: name,
        peers: getPeers(ip, id)
    }));

    // Notify other peers on the network that a new device joined
    broadcastToNetwork(ip, id, {
        type: 'peer-joined',
        peer: { id, name }
    });

    ws.on('message', (messageAsString) => {
        let message;
        try {
            message = JSON.parse(messageAsString);
        } catch (e) {
            console.error('Invalid message format:', e);
            return;
        }

        const sender = clients.get(ws);
        if (!sender) return;

        // Routing WebRTC signaling messages
        switch (message.type) {
            case 'offer':
            case 'answer':
            case 'candidate':
                // The client should provide the target peer's ID
                if (message.target) {
                    sendToClient(message.target, {
                        ...message,
                        sender: sender.id
                    });
                }
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client) {
            console.log(`[-] Client disconnected: ${client.name} (${client.id})`);
            clients.delete(ws);

            // Notify others on the network
            broadcastToNetwork(client.ip, client.id, {
                type: 'peer-left',
                peerId: client.id
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
