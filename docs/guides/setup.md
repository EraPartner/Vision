---
title: Setup Guide
type: guide
status: active
date: 2026-09-08
tags:
  [
    guide,
    setup,
    development,
    local,
    native-runtime,
    postgresql,
    electron,
    onboarding,
  ]
description: Set up Vision for native source development, Electron development, and isolated Demo use.
aliases: [setup-guide, installation, getting-started, local-dev]
related_code: [[package.json]]
---

# Setup Guide

Vision development uses native processes and PostgreSQL 18. The macOS desktop package carries its
own PostgreSQL, Bun, migration, and report-browser payloads. The hardened agent sandbox described
in [[docs/guides/devcontainer|Devcontainer Guide]] is separate: it runs with Apple `container` and
is not a product deployment option.

## Prerequisites

| Tool       | Version | Purpose                                                  |
| ---------- | ------- | -------------------------------------------------------- |
| Bun        | 1.3.14  | Workspaces, development, checks, and backend compilation |
| Node.js    | 20+     | Electron packaging tools                                 |
| Python     | 3.12    | Alembic and the packaged migration executable            |
| PostgreSQL | 18.6    | Native development payload or disposable database checks |

## Install

```bash
git clone <repository-url>
cd Vision
bun install
bun run install:electron
```

There is no root `.env.local`. Shared provider keys may live in the root `.env`; local backend
overrides belong in `apps/node-backend/.env.local`, and frontend `VITE_*` values belong in
`apps/frontend/.env.local`. See [[docs/reference/environment-variables|Environment Variables]].
Never commit credentials.

## Start development

Prepare the pinned native payload once, then launch the native development profile:

```bash
bun run native:prepare
bun run dev
```

`bun run dev` starts Electron, a private PostgreSQL 18 cluster, the backend, and the frontend. The
cluster is stored under the `Vision Development` application-data directory. Startup creates
separate administrator, migration-owner, and application roles, installs required extensions, runs the
guarded migration runner, and waits for detailed readiness.

For focused frontend work, point `DATABASE_URL` at a disposable PostgreSQL 18 database and run the
workspace scripts directly. `bun run test:db` creates, migrates, and removes a private temporary
cluster automatically.

## Demo application

```bash
./install-demo.sh
open "/Applications/Vision Demo.app"
```

The Demo uses deterministic synthetic data and a separate native cluster below
`~/Library/Application Support/Vision Demo`. It never touches real Vision data. Reset it only with
`bun run demo:reset-native`; the reset takes effect on the next Demo launch.

## Common commands

| Command                                  | Purpose                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `bun run dev`                            | Start the native development profile                        |
| `bun run electron:dev`                   | Start Electron explicitly in the native development profile |
| `bun run build`                          | Build the production frontend                               |
| `bun run lint` / `bun run lint:backend`  | Lint frontend and backend                                   |
| `bun run typecheck`                      | Type-check the frontend                                     |
| `bun run test` / `bun run test:frontend` | Run backend or frontend tests                               |
| `bun run test:electron`                  | Run Electron and native-runtime contract tests              |
| `bun run test:db`                        | Run backend tests against disposable native PostgreSQL 18   |
| `bun run native:prepare`                 | Prepare the pinned development/package payload              |
| `bun run native:db-smoke`                | Check migrations, dump/restore, and attachments             |
| `bun run native:isolated-smoke`          | Run the complete isolated native smoke                      |
| `bun run native:smoke`                   | Run native backend and health checks                        |

Alembic writes must go through `bun run db:migrate` or `bun run db:upgrade`; see
[[docs/guides/migrations|Database Migrations]].

## Legacy installation boundary

The current release does not contain the retired runtime or its importer. If existing settings or
runtime state identify a legacy provider, startup fails closed. Migrate that installation with
Vision 1.0.2 before installing a native-only release. Do not delete the legacy data while deciding
how to recover it. See [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]].

## Related

- [[docs/getting-started|Getting Started]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/guides/backend-configuration|Backend Configuration]]
- [[docs/testing/testing|Testing Guide]]
- [[docs/troubleshooting|Troubleshooting]]
