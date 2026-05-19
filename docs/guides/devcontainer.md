---
title: Devcontainer Guide
type: guide
status: active
date: 2026-05-19
tags: [guide, devcontainer, docker, security, claude-code, development, postgres, firewall]
description: How to use the Vision devcontainer for isolated development with Claude Code --dangerously-skip-permissions mode. Covers first-time setup, network policy, persistence, and known limitations.
aliases: [devcontainer-guide, devcontainer, dev-container, claude-code-container]
related_code: [[.devcontainer/devcontainer.json]]
---

# Devcontainer Guide

The Vision devcontainer provides a hardened, self-contained development environment designed for running Claude Code with `--dangerously-skip-permissions`. It runs the entire stack — PostgreSQL 18, backend, and frontend — natively inside one container, avoiding Docker-in-Docker.

> [!info] When to use this
> The devcontainer is **optional**. Use it when you want to run `claude --dangerously-skip-permissions` safely, because the container's egress firewall limits what an autonomous agent can reach on the network. Normal development with `bun run dev` on the host works fine without it.

> [!warning] Security model
> The firewall isolates the **host from Claude**, not Claude from a hostile repo. A malicious project could still exfiltrate anything inside the container — including the `~/.claude` credentials volume. Only enable `--dangerously-skip-permissions` for trusted repositories.

## What runs inside

| Component | Runtime | Port |
|---|---|---|
| PostgreSQL 18 (apt, native) | `pg_ctlcluster` | `5432` (in-container) |
| Backend (bun + Express) | `bun run dev` | `3002` (forwarded to host) |
| Frontend (Vite) | `bun run dev` | `8080` (forwarded to host) |
| Alembic migrations | Python venv at `./venv` | — |
| Claude Code | Official devcontainer feature | — |

PostgreSQL major version (18) intentionally matches `docker-compose.yml` so schema behavior is consistent across environments.

## Prerequisites

- VS Code, Cursor, or another editor with the **Dev Containers** extension (ms-vscode-remote.remote-containers)
- Or the `@devcontainers/cli` package for CLI-only use
- Docker Desktop (or a Docker-compatible runtime) with at least **NET_ADMIN** and **NET_RAW** capabilities available

## First-time setup (VS Code / Cursor)

1. Open the Vision repo.
2. `Cmd+Shift+P` → **Dev Containers: Reopen in Container**.
3. The first build takes roughly **5–10 minutes** (PostgreSQL APT install + bun system install).
4. `post-create.sh` runs automatically: initializes the Postgres cluster, creates the `ftm_user` role and `financial_transactions` database, rebuilds the Python venv, and runs `bun install`.
5. Open a terminal inside the container:

```sh
bun run dev          # starts backend + frontend concurrently
# in a second terminal:
claude --dangerously-skip-permissions
```

Migrations are **not** run by `post-create.sh`. On the first `bun run dev`, the backend's `migrate.js` preflight creates the `alembic_version` table with `VARCHAR(64)` and then invokes alembic, matching the production `docker-entrypoint.sh` flow. Running alembic before the backend would leave a `VARCHAR(32)` column that breaks once revision IDs exceed 32 chars.

## CLI-only setup

```sh
npm install -g @devcontainers/cli
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
# inside the container:
bun run dev
```

> [!tip] Port forwarding
> `forwardPorts` is an editor-side feature. When using the CLI, ports are not automatically published to the host. Add `-p 8080:8080 -p 3002:3002` to the underlying Docker run command if you need browser access from the host.

## Network policy

`init-firewall.sh` runs on every container start via `post-start.sh`. It applies a default-deny iptables egress policy and resolves an allowlist of 26 domains to IPs at startup time.

**Allowlisted domains (by category):**

| Category | Domains |
|---|---|
| Anthropic / Claude Code | `api.anthropic.com`, `claude.ai`, `console.anthropic.com`, `statsig.anthropic.com`, `code.claude.com`, `docs.claude.com`, `sentry.io` |
| npm / bun | `registry.npmjs.org`, `bun.sh` |
| GitHub | `github.com`, `api.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `codeload.github.com`, `ghcr.io`, `pkg-containers.githubusercontent.com` |
| PyPI (Alembic) | `pypi.org`, `files.pythonhosted.org` |
| Debian / PGDG apt | `deb.debian.org`, `security.debian.org`, `apt.postgresql.org` |
| Yahoo Finance | `query1.finance.yahoo.com`, `query2.finance.yahoo.com`, `finance.yahoo.com` |
| VS Code marketplace | `marketplace.visualstudio.com`, `update.code.visualstudio.com` |

Localhost traffic (backend ↔ postgres ↔ frontend) is fully allowed. DNS is restricted to the container's configured resolver only, reducing DNS-tunneling surface.

To add a domain: edit `ALLOWED_DOMAINS` in `.devcontainer/init-firewall.sh` and re-run `sudo .devcontainer/init-firewall.sh`. The ipset is rebuilt from scratch on each invocation.

## Persistent volumes

Three named Docker volumes preserve state across container rebuilds:

| Volume | Mount path | Contains |
|---|---|---|
| `vision-claude-<devcontainerId>` | `~/.claude` | Claude Code auth tokens + session history |
| `vision-pgdata-<devcontainerId>` | `/var/lib/postgresql` | Postgres data directory |
| `vision-buncache-<devcontainerId>` | `~/.bun/install/cache` | Bun package cache |

The workspace directory (`/workspaces/Vision`) is a bind-mount so edits appear on the host immediately.

## Container permissions model

The image is built from `mcr.microsoft.com/devcontainers/base:debian-12`. The `vscode` user runs as non-root and has narrowly scoped `sudo` access:

- **`(postgres) NOPASSWD: ALL`** — lets `post-create.sh` run `psql`/`createdb` as the postgres OS user.
- **`(root) NOPASSWD:`** — only the specific binaries needed: `pg_ctlcluster`, `pg_createcluster`, `iptables`, `ipset`, `chown`, and the firewall script itself.

No blanket root access is granted.

## Environment variables set by devcontainer.json

These are injected into the container environment and do not require a `.env.local` file for basic operation:

| Variable | Value | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://ftm_user:localdev@127.0.0.1:5432/financial_transactions` | Backend database connection |
| `ALEMBIC_BIN` | `/workspaces/Vision/venv/bin/alembic` | Points to the container venv |
| `VITE_API_URL` | `http://localhost:3002` | Frontend → backend URL |
| `SERVER_HOST` | `0.0.0.0` | Backend binds on all interfaces so port-forwarding works |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` | Keeps image lean; see PDF limitation below |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | Reduces Claude Code telemetry calls |
| `DEVCONTAINER` | `true` | Allows code to detect container context |

`post-create.sh` also writes a `.env` file at the workspace root if one does not exist, so tooling that reads `.env` directly (alembic `env.py`, scripts) works without manual setup.

## Known limitations

**PDF rendering (Puppeteer)** — Chromium is not pre-installed to keep the image lean. If you need PDF generation in dev:

```sh
bunx playwright install chromium --with-deps
export PUPPETEER_EXECUTABLE_PATH=$(bunx playwright install chromium --dry-run 2>&1 | grep -oE '/[^ ]+chromium[^ ]+')
```

**Electron `.dmg` build** — `bun run dist` requires macOS native tools. Run on the host, not in this container.

**Host Ollama** — `host.docker.internal` works on Docker Desktop (macOS/Windows). On Linux, add `--add-host=host.docker.internal:host-gateway` to `runArgs` in `devcontainer.json`, and ensure the firewall allows that host IP.

**Firewall failures** — If `post-start.sh` reports `Firewall apply failed`, verify the container was started with `--cap-add=NET_ADMIN` and `--cap-add=NET_RAW`. These are declared in `devcontainer.json`'s `runArgs` but some Docker environments require explicit confirmation. Re-run `sudo .devcontainer/init-firewall.sh` once inside the container to diagnose the error.

## Related

- [[.devcontainer/README.md]] — concise user-facing reference (mirrors this guide)
- [[.devcontainer/devcontainer.json]] — container spec, feature list, port forwarding, env vars
- [[.devcontainer/Dockerfile]] — Debian 12 base image, PostgreSQL 18 APT install, bun install, sudoers config
- [[.devcontainer/init-firewall.sh]] — iptables egress allowlist implementation
- [[.devcontainer/post-create.sh]] — one-time cluster init, role/db creation, venv setup, `bun install`
- [[.devcontainer/post-start.sh]] — per-start postgres health check + firewall apply
- [[docs/guides/setup]] — standard (non-container) local development setup
- [[docs/security/container-hardening]] — production Docker container security policies
- [[docs/reference/environment-variables]] — complete environment variable reference
