## OpenDrop

<div align="center">

**A free, secure, open-source file sharing tool.**  
Transfer files across your local network directly from device to device using WebRTC, or upload and share via link.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Frontend-GitHub%20Pages-green)](https://dhanushnehru.github.io/OpenDrop/)

[Live Demo](https://dhanushnehru.github.io/OpenDrop/) • [Report a Bug](../../issues) • [Request a Feature](../../issues)

</div>

---

## Table of Contents

- [About](#about)
- [How It Works](#how-it-works)
- [How to Use](#how-to-use)
- [Local Development](#local-development)
  - [Prerequisites](#prerequisites)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Install Dependencies](#2-install-dependencies)
  - [3. Run the Signaling Server](#3-run-the-signaling-server)
  - [4. Serve the Frontend](#4-serve-the-frontend)
- [Self-Hosting](#self-hosting)
  - [Frontend — GitHub Pages](#frontend--github-pages)
  - [Backend — Signaling Server](#backend--signaling-server)
- [License & Attribution](#license--attribution)

---

## About

OpenDrop lets you share files instantly — no accounts, no cloud storage, no middleman. It works in two modes:

- **Same-Network Transfer** — Peer-to-peer, directly between devices on the same Wi-Fi. Files never touch any server.
- **Share via Link** — Upload a file and get a shareable download link that expires in 24 hours.

---

## How It Works

OpenDrop is split into two parts:

| Part | Description |
|------|-------------|
| **Client (Frontend)** | A static HTML/CSS/JS site. Manages the UI and WebRTC peer-to-peer connections. Hosted on GitHub Pages. |
| **Server (Backend)** | A lightweight Node.js WebSocket signaling server. Matches devices on the same network and brokers the initial WebRTC handshake. Also handles file uploads for shareable links. |

> **Privacy note:** For local transfers, your files are sent entirely peer-to-peer over WebRTC Data Channels and **never touch the signaling server**.

---

## How to Use

### Same-Network Transfer
1. Open OpenDrop on two devices connected to the same Wi-Fi network.
2. The devices will **auto-discover** each other — no pairing or setup needed.
3. Click a peer's name to select a file and send it directly (peer-to-peer, no server involved).

### Share via Link
1. Click **"Share via Link"** on any device.
2. Select a file to upload — you'll receive a shareable download link.
3. Send the link to anyone. The link **expires after 24 hours**.

---

## Local Development

Since the frontend uses native ES Modules, **no bundler or build tool is required**.

### Prerequisites

Make sure you have the following installed before getting started:

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | v16 or higher | Runs the signaling server |
| [npm](https://www.npmjs.com/) | Comes with Node.js | Installs server dependencies |
| [Python 3](https://www.python.org/) | v3.x | Serves the static frontend locally |

You can verify your installations by running:

```bash
node --version
npm --version
python3 --version
```

---

### 1. Clone the Repository

```bash
git clone https://github.com/DhanushNehru/OpenDrop.git
cd OpenDrop
```

---

### 2. Install Dependencies

The signaling server has its own `package.json`. Navigate to the `server` directory and install its dependencies:

```bash
cd server
npm install
```

This installs all required Node.js packages listed in `server/package.json` (such as the WebSocket library).

> **Note:** The frontend has **no dependencies** to install — it runs as plain HTML/CSS/JS in the browser.

---

### 3. Run the Signaling Server

From inside the `server` directory, start the server:

```bash
node index.js
```

You should see output confirming the server is running (e.g., `Signaling server listening on port 3000`).

> Keep this terminal window open. The signaling server must be running for peer discovery and file-link uploads to work.

---

### 4. Serve the Frontend

Open a **new terminal window**, navigate to the `client` directory, and start a local HTTP server using Python:

```bash
cd client
python3 -m http.server 8080
```

Then open your browser and go to:

```
http://localhost:8080
```

> **Why not just open `index.html` directly?** Because the frontend uses ES Modules (`type="module"`), which browsers block when loaded via `file://` URLs due to CORS restrictions. A local HTTP server is required.

---

### Connecting the Frontend to Your Local Server

By default, the frontend is configured to point to the production signaling server. For local development, update the `SIGNALING_URL` variable in `/client/main.js` to point to your local server:

```js
// client/main.js
const SIGNALING_URL = "ws://localhost:3000"; // ← change this for local dev
```

Revert this change before pushing to production.

---

### Full Local Setup (Quick Reference)

```bash
# Terminal 1 — Start the signaling server
git clone https://github.com/DhanushNehru/OpenDrop.git
cd OpenDrop/server
npm install
node index.js

# Terminal 2 — Serve the frontend
cd OpenDrop/client
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

---

## Self-Hosting

### Frontend — GitHub Pages

This repository includes a GitHub Action to automatically deploy the `client` folder to GitHub Pages.

1. Go to your repository **Settings** on GitHub.
2. Navigate to **Pages** in the left sidebar.
3. Under **Build and deployment**, set the source to **GitHub Actions**.
4. The site will automatically deploy on every push to `main`.

---

### Backend — Signaling Server

You can deploy the backend for free using [Koyeb](https://www.koyeb.com/) or [Render](https://render.com/).

1. Log into Koyeb or Render and select **"New Web Service"**.
2. Connect your GitHub repository.
3. Use the following build settings:

   | Setting | Value |
   |---------|-------|
   | Root Directory | `server` |
   | Build Command | `npm install` |
   | Start Command | `node index.js` |

4. Once deployed, copy the generated URL (e.g., `wss://your-app-name.koyeb.app`).
5. Update the `SIGNALING_URL` variable in `/client/main.js` with your new URL:

   ```js
   const SIGNALING_URL = "wss://your-app-name.koyeb.app";
   ```

6. Push to `main` — the GitHub Action will redeploy the frontend automatically.

---

## License & Attribution

This project is licensed under the **Apache License 2.0**. See [`LICENSE`](LICENSE) for details.

**Attribution matters:**
- If you redistribute or create derivatives, keep the license and notices intact.
- Please keep the `NOTICE` file (or equivalent visible attribution) with your distribution.

**Community request** *(not a legal requirement)*:
- If you reuse OpenDrop, please mention the original project and author.git 
- If possible, let the author know by opening an issue or discussion in this repository.git 