---
title: Setup Guide
type: guide
status: active
date: 2026-11-03
tags:
  [
    guide,
    setup,
    development,
    local,
    native-runtime,
    sqlite,
    electron,
    onboarding,
  ]
description: Set up Vision for native source development, Electron development, and isolated Demo use.
aliases: [setup-guide, installation, getting-started, local-dev]
related_code: [[package.json]]
---

# Setup Guide

Vision development uses native processes and one SQLite database file. The backend opens the file
in-process through Bun's `node:sqlite` and the system SQLite library, so there is no database
server to install or run ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). The macOS desktop
package carries the compiled backend, the database tool, the frontend and the migration files.
Agents use their provider's built-in sandbox; see
[[docs/guides/devcontainer|Agent Sandbox Guide]].

## Prerequisites

| Tool       | Version | Purpose                                                  |
| ---------- | ------- | -------------------------------------------------------- |
| Bun        | 1.4.2   | Workspaces, development, checks, and backend compilation |
| Node.js    | 20+     | Electron packaging tools                                 |
| SQLite     | 3.39.0+ | The system library the backend uses (macOS 13 or later)  |

## Install

```bash
git clone <repository-url>
cd Vision
bun install --frozen-lockfile
bun run install:electron
```

There is no root `.env.local`. Shared provider keys may live in the root `.env`; local backend
overrides belong in `apps/node-backend/.env.local` (optional and not shipped as an example file: create it yourself; the loader reads it first, then the root `.env`, and a real process environment value always wins), and frontend `VITE_*` values belong in
`apps/frontend/.env.local`. See [[docs/reference/environment-variables|Environment Variables]].
Never commit credentials.

## Start development

Launch the native development profile:

```bash
bun run dev
```

`bun run dev` compiles the TypeScript Electron shell into `packaging/electron/out/`
([[docs/adr/196-electron-shell-typescript|ADR-196]]), prepares the `vision_dev` runtime layout,
and starts the watched backend and the Vite frontend
(`packaging/electron/scripts/native-development.ts`). It does not open an Electron window; use
`bun run electron:dev` for the desktop shell. The database is
`database/vision.sqlite3` under the `Vision Development` application-data directory
(`VISION_DEV_USER_DATA` overrides the directory). The backend creates the file on first start and
applies pending `db/migrations/` files before it listens.

The Vite development server always listens on `127.0.0.1` because its proxy exposes the local data
API. Open the frontend at `http://127.0.0.1:8080`: the browser calls `/api` same-origin and the
proxy forwards it to the backend named by `VISION_DEV_API_TARGET`, which `bun run dev` sets. The
backend sends no CORS headers, so a frontend on another origin cannot use it ([[docs/adr/233-loopback-only-backend|ADR-233]]).

For focused work, run the workspace scripts directly. In development and test the backend uses
`./data/vision.sqlite3` unless `VISION_DATABASE_PATH` names another file, and it creates and
migrates that file when it starts. Backend tests need no database setup: each test file gets its own
copy of a migrated SQLite template ([[docs/testing/testing|Testing Guide]]).

## Demo application

```bash
./install-demo.sh
open "/Applications/Vision Demo.app"
```

The Demo uses deterministic synthetic data and its own SQLite database below
`~/Library/Application Support/Vision Demo`. It never touches real Vision data. Reset it only with
`bun run demo:reset-native`; the reset takes effect on the next Demo launch.

## Common commands

| Command                                  | Purpose                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `bun run dev`                            | Start the native development profile                                                 |
| `bun run electron:dev`                   | Start Electron explicitly in the native development profile                          |
| `bun run build`                          | Build the production frontend                                                        |
| `bun run lint` / `bun run lint:backend`  | Lint frontend (plus import boundaries and dead code) and backend                     |
| `bun run typecheck`                      | Type-check the frontend                                                              |
| `bun run test` / `bun run test:frontend` | Run backend tests, or the full frontend suite with a backend on a temporary SQLite file |
| `bun run test:watch`                     | Watch all backend tests                                                              |
| `bun run test:electron`                  | Build the Electron shell, then run its Electron and native-runtime tests             |
| `bun run typecheck:electron`             | Type-check the Electron shell and its preload                                        |
| `bun run native:isolated-smoke`          | Run the complete isolated native smoke                                               |
| `bun run native:smoke`                   | Run native backend and health checks                                                 |

Schema changes go through the SQLite migration runner (`bun run db:migrate`,
`bun run db:status`); no Python toolchain is needed. See [[docs/guides/migrations|Database Migrations]].

## Related

- [[docs/getting-started|Getting Started]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/guides/backend-configuration|Backend Configuration]]
- [[docs/testing/testing|Testing Guide]]
- [[docs/troubleshooting|Troubleshooting]]
