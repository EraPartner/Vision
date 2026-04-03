---
title: Electron Desktop Architecture
type: architecture-doc
status: active
date: 2026-04-02
tags: [architecture, electron, desktop, packaging]
description: Electron desktop application architecture, IPC communication, and packaging configuration
aliases: [electron, desktop app, packaging, IPC, main process]
related_code: ["packaging/electron/", "apps/frontend/src/", "apps/node-backend/src/main.js"]
---

# Electron Desktop Architecture

## Overview

Vision runs as an Electron desktop application, bundling the React frontend and Node.js backend into a single distributable package.

---

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────┐
│                   Main Process                       │
│  ┌───────────────────────────────────────────────┐  │
│  │  Electron Main (BrowserWindow management)     │  │
│  │  ├── Creates renderer window                  │  │
│  │  ├── Manages app lifecycle                    │  │
│  │  ├── Handles native OS features               │  │
│  │  └── Spawns backend server                    │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ IPC
┌──────────────────────┴──────────────────────────────┐
│                  Renderer Process                    │
│  ┌───────────────────────────────────────────────┐  │
│  │  React App (Chromium)                         │  │
│  │  ├── UI components                            │  │
│  │  ├── State management                         │  │
│  │  └── API calls to localhost backend           │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│                  Backend Process                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Express Server (Node.js/Bun)                 │  │
│  │  ├── REST API                                 │  │
│  │  ├── PostgreSQL connection                    │  │
│  │  └── External service integrations            │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Communication Pattern

The frontend communicates with the backend via **HTTP on localhost**, not via Electron IPC:

```
Renderer (React) ──HTTP──▶ Express Backend (localhost:3002)
```

This design choice means:
- The backend is a standard Express app (testable independently)
- The frontend is a standard React app (deployable to web)
- Electron is just the packaging layer

---

## Configuration

### Location

Electron configuration is in `packaging/electron/`.

### Key Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `contextIsolation` | true | Security: isolate preload from renderer |
| `nodeIntegration` | false | Security: no Node.js in renderer |
| `sandbox` | true | Security: sandboxed renderer |

---

## Startup Sequence

1. **Electron Main** starts
2. **Backend server** is spawned as a child process
3. **Wait for backend** to be ready (health check)
4. **Create BrowserWindow** loading the frontend
5. **Frontend** connects to backend at `http://localhost:3002`

---

## Packaging

### Platforms

- **macOS** — `.dmg` / `.app`
- **Windows** — `.exe` / `.msi`
- **Linux** — `.AppImage` / `.deb`

### Bundled Components

- React frontend (built with Vite)
- Node.js backend (bundled with dependencies)
- PostgreSQL (external — not bundled)

---

## Native Features

### Backup/Restore

Settings include a **Backup** tab for Electron-specific backup/restore:
- Export configuration to file
- Import configuration from file

### Auto-Update

Electron can check for and apply updates:

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/update/check` | Check for available updates |
| `POST /api/admin/update/apply` | Acknowledge update |
| `POST /api/admin/update/apply-and-restart` | Apply and restart app |

---

## Security Considerations

### Context Isolation

```javascript
// preload.ts
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Only expose safe, validated functions
  getVersion: () => ipcRenderer.invoke('get-version'),
});
```

### CSP Headers

The backend sets Content-Security-Policy headers appropriate for Electron:
- `img-src` includes `https:` for remote news thumbnails
- `script-src` restricts script sources
- `default-src` limits resource loading

---

## Development

### Running Electron

```bash
# Development mode
bun run electron:dev

# Production mode
bun run electron:prod
```

### Debugging

- **Main process:** `electron --inspect`
- **Renderer process:** Chrome DevTools (Cmd+Option+I)
- **Backend process:** Standard Node.js debugging

---

## Related

- [[docs/guides/deployment]] — Deployment guide
- [[docs/reference/scripts]] — Build scripts
- [[docs/security/index]] — Security documentation
