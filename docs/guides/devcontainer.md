---
title: Devcontainer Guide
type: guide
status: active
date: 2026-08-13
updated: 2026-08-27
tags: [guide, devcontainer, apple-container, security, claude-code, development, postgres, egress]
description: How to use the Vision devcontainer (Apple's container runtime) for isolated development with Claude Code --dangerously-skip-permissions mode. Covers the vision-claude launcher, squid SNI egress policy, persistence, and known limitations.
aliases: [devcontainer-guide, devcontainer, dev-container, claude-code-container]
---

# Devcontainer Guide

The Vision devcontainer provides a hardened, self-contained development environment designed for running Claude Code with `--dangerously-skip-permissions`. It runs the entire stack — PostgreSQL 18, backend, and frontend — natively inside one container, with no nested containers.

The sandbox runs on **Apple's `container` runtime** (`apple/container`), not Docker. It was migrated off Docker Compose / Docker Desktop in [[docs/adr/077-devcontainer-apple-container-runtime|ADR-077]]; there is no `devcontainer.json` and no `compose.yaml`. You launch it with the `vision-claude` host command (described below), never with an editor's "Reopen in Container" or the `@devcontainers/cli`.

> [!info] When to use this
> The devcontainer is **optional**. Use it when you want to run `claude --dangerously-skip-permissions` safely, because the container's egress proxy limits what an autonomous agent can reach on the network. Normal development with `bun run dev` on the host works fine without it.

> [!warning] Security model
> The egress lock isolates the **host from Claude**, not Claude from a hostile repo. A malicious project could still exfiltrate anything inside the container — including the `~/.claude` credentials volume. Only enable `--dangerously-skip-permissions` for trusted repositories.

## What runs inside

| Component | Runtime | Port |
|---|---|---|
| PostgreSQL 18 (apt, native) | entrypoint-managed cluster | `5432` (in-container) |
| Backend (bun + Express) | `bun run dev` | `3002` (published to `127.0.0.1`) |
| Frontend (Vite) | `bun run dev` | `8080` (published to `127.0.0.1`) |
| Alembic migrations | Python venv at `./venv` | — |
| Claude Code | installed into the image | — |

The base image is plain `debian:bookworm-slim`. The container user is `dev` (UID 1000) and has **no sudo** — privilege-sensitive setup runs in the root entrypoint before the session drops to `dev`.

PostgreSQL major version (18) intentionally matches production so schema behavior is consistent across environments.

## Prerequisites

- macOS only. `apple/container` is a macOS-native tool; this launcher cannot run on Linux or Windows (see [[docs/adr/077-devcontainer-apple-container-runtime|ADR-077]]).
- [apple/container](https://github.com/apple/container) installed, with the system VM started:

  ```sh
  container system start
  ```

- The `vision-claude` fish function on your `PATH` (ships at `~/.config/fish/functions/vision-claude.fish`). It walks up from `$PWD` to the repo root and calls the host launcher at `.devcontainer/bin/claude`.
- Your Claude OAuth token stored in the macOS Keychain under the service `vision-claude-code-token` (see [Authentication](#authentication)). On non-macOS hosts there is no Keychain path — export `CLAUDE_CODE_OAUTH_TOKEN` instead.

## First-time setup

1. **Store your Claude token in the Keychain** (one time, on the host):

   ```sh
   claude setup-token        # prints a token starting with sk-ant-… ; copy it
   security add-generic-password \
     -s "vision-claude-code-token" \
     -a "$USER" \
     -w                      # prompts you to paste the token (won't echo)
   ```

2. **Launch from anywhere in (or under) the repo:**

   ```sh
   vision-claude --dangerously-skip-permissions
   ```

   The first run does a `container build` of the hardened image, then `container run -d --name vision-dev …` and replays the lifecycle scripts as `dev`. The build takes a few minutes (PostgreSQL apt install + bun install). Subsequent launches reuse the running container or `container start` a stopped one, so they are fast.

   On launch the wrapper stages a sanitized copy of your host `~/.claude`, forwards the Keychain token into the container, runs `post-create.sh` once (Postgres cluster init, `ftm_user` role + `financial_transactions` database, Python venv, `bun install`) and `post-start.sh` on every start.

3. **Start the app and a Claude session.** `vision-claude` drops you straight into Claude. To run the dev stack, open a shell in the container:

   ```sh
   container exec -it --user dev vision-dev bash
   # inside the container:
   bun run dev          # starts backend + frontend concurrently
   ```

Migrations are **not** run by `post-create.sh`. On the first `bun run dev`, the backend's `migrate.js` preflight creates the `alembic_version` table with `VARCHAR(64)` and then invokes alembic, matching the production entrypoint flow. Running alembic before the backend would leave a `VARCHAR(32)` column that breaks once revision IDs exceed 32 chars.

## Everyday commands

```sh
# Launch Claude in the sandbox (build/start is idempotent):
vision-claude --dangerously-skip-permissions

# Open a shell instead of Claude:
container exec -it --user dev vision-dev bash

# Force a full rebuild (after editing the Dockerfile or the allowlist):
VISION_REBUILD=1 vision-claude --dangerously-skip-permissions
```

> [!tip] Browser access from the host
> The container publishes `127.0.0.1:8080:8080` and `127.0.0.1:3002:3002`. Once `bun run dev` is running inside the container, the host can reach `http://localhost:8080` (frontend) and `http://localhost:3002/health` (backend). They are bound to `127.0.0.1` only, so other devices on your LAN can't see them.

## Network policy

Egress is enforced by an in-container **squid** proxy running as a peek-and-splice SNI filter, backed by an iptables egress lock — both applied by the root entrypoint on every start (fail-closed: if squid is down, egress stays denied).

- **squid SNI filter** (`127.0.0.1:3128`). All outbound HTTP(S) must traverse squid. It peeks the TLS **SNI hostname** and *splices* allowed hosts (tunnels without decrypting — end-to-end TLS is preserved, no MITM) and terminates everything else. Because enforcement is on the **hostname**, an exfil endpoint sharing an allowed CDN IP can't sneak through, and `CONNECT`-host ≠ SNI domain-fronting is defeated.
- **iptables egress lock**. Only the proxy UID may originate outbound packets; everything else is dropped. IPv6 is default-deny.

`HTTP(S)_PROXY` is set in the container and `NODE_USE_ENV_PROXY=1` makes Node ≥24's global `fetch` honor it too, so `claude`, `bun`, `npm`, `git`, `gh`, `pip`, and app `fetch` all egress through squid.

**The allowlist is a list of hostnames, not resolved IPs**, and it is **baked into the image** (`/etc/squid/allowlist.txt`) — it is not read live from the workspace, so changes require a rebuild. It is generated by `LockBox/sync.sh`, which concatenates two sources:

- `LockBox/base-allowlist.txt` — the shared floor for every agent sandbox (Anthropic API + auth, GitHub git/API/CDN).
- `.devcontainer/allowlist.extra.txt` — Vision's project-specific additions (Claude Code auth/docs, npm/bun, GitHub container registry, PyPI, Yahoo Finance, and the Aikido malware list).

To change egress: edit `base-allowlist.txt` (shared — widens egress for all sandboxes) or `.devcontainer/allowlist.extra.txt` (Vision only), re-run `LockBox/sync.sh`, then rebuild:

```sh
VISION_REBUILD=1 vision-claude --dangerously-skip-permissions
```

Localhost traffic (backend ↔ postgres ↔ frontend) bypasses the proxy via `NO_PROXY`.

> [!note] What's not covered
> WebSearch / WebFetch run Anthropic-side, not through the proxy. ECH (encrypted SNI) destinations fail closed (no readable SNI → terminated). Blocked egress surfaces as a TLS/cert error or `CONNECT 403`; the definitive log is `/var/log/squid/access.log` (`dev`-readable; `TCP_DENIED`/`NONE` = blocked). Run `.devcontainer/bin/doctor` for a one-shot readiness check.

## Isolation model

There is no `--security-opt no-new-privileges` flag (apple/container doesn't provide one); the **VM boundary** replaces it. On top of that the container runs with `--cap-drop ALL` (re-adding only the few caps the entrypoint needs for iptables, permission fixes, and the Postgres/squid privilege-drops), and setuid bits are stripped, so `dev` cannot escalate. The repo's `.devcontainer` directory is re-mounted **read-only on top of** the read-write workspace, so a compromised in-container agent can't rewrite the launcher or Dockerfile that run on your Mac. Edit `.devcontainer` on the host only, then rebuild.

## Persistent volumes

Named `apple/container` volumes preserve state across container rebuilds:

| Volume | Mount path | Contains |
|---|---|---|
| `vision-claude` | `/home/dev/.claude` | Claude Code config + session history |
| `vision-pgdata` | `/var/lib/postgresql` | Postgres data directory |
| `vision-venv` | `/workspaces/Vision/venv` | Container's Python venv (alembic) |
| `vision-nm-root` | `/workspaces/Vision/node_modules` | Container's JS dependencies (root) |
| `vision-nm-frontend`, `vision-nm-backend`, `vision-nm-shared`, `vision-nm-types` | `<workspace>/node_modules` | Container's JS dependencies (per bun workspace) |
| `vision-nm-electron` | `/workspaces/Vision/packaging/electron/node_modules` | Shields the host's Electron deps (never installed in-container) |

### Dependency isolation (`node_modules/` + `./venv`)

`node_modules/` and `./venv` hold platform-specific artifacts — native `.node` binaries (esbuild, rollup, lightningcss, tailwind-oxide) and a venv whose `bin/python` symlinks a specific CPython. Sharing one copy over the bind mount meant an install on either side overwrote the other's binaries, so every host↔container switch broke the other side's dev loop (`bun run db:upgrade` failing with "cannot execute binary file") until a full reinstall. Each tree is now shadowed by its own named volume mounted at the **same in-repo path**, so `./venv/bin/alembic`, `node_modules/.bin`, `$ALEMBIC_BIN` and `bun run db:*` resolve identically on both sides — just into container-private storage. `.devcontainer/bin/doctor` fails if a stale container is still sharing the host's trees.

Because the trees are separate, **dependency changes do not cross the boundary**: after a host-side `bun install` (or a `git pull` that moves `bun.lock`), run `bun install` inside the container too — `post-start.sh` warns when `bun.lock` is newer than the container's `node_modules`. The volumes survive `VISION_REBUILD=1`; reset instructions are in [`.devcontainer/README.md`](../../.devcontainer/README.md).

The workspace directory (`/workspaces/Vision`) is a bind mount, so edits appear on the host immediately. The repo's `.git` is bind-mounted **read-only** and no git credential is forwarded, so git inside the container is read-only — commit and push from your host (see [Git](#git-read-only-inside)).

## Claude config sync (host ↔ container)

The container's `~/.claude` and `~/.claude.json` are an **isolated copy**, not a live bind of your host config (a raw bind would expose host secrets and corrupt `~/.claude.json` under concurrent writes). The `vision-claude` wrapper stages a sanitized copy of host `~/.claude` and `post-start.sh` pulls it in on every start, so host-side changes (new agents, edited rules) are picked up automatically. Note that `hooks`, `mcpServers`, and `enabledPlugins` are stripped during staging — re-add them inside the container if you want them active there.

> [!warning] In-container config changes must be pushed back
> If you change Claude config **inside** the container (agents, plugins, slash commands, hooks, MCP servers, rules, settings, memory), it is not part of the mounted workspace and will be lost on the next rebuild unless it is synced back to the host. The wrapper autosyncs on session exit (opt-in via `VISION_AUTOSYNC=1`); the manual fallback (e.g. after a crash) is:
>
> ```sh
> vision-claude-sync push
> ```
>
> Repo-level config (`CLAUDE.md`, `.claude/skills/`, `.claude/agents/`) lives in the mounted workspace and needs **no** sync.

The `vision-claude-sync` fish function also supports `pull` (refresh container from host) and `status` (show what differs). Both directions use `rsync --update` (newer-wins) and a `jq` merge for `.claude.json`; no deletes.

## Authentication

Your host Claude credentials live in the macOS Keychain. The `vision-claude` wrapper retrieves the token at exec time (`security find-generic-password -s vision-claude-code-token -w`) and forwards it to the container as `CLAUDE_CODE_OAUTH_TOKEN` — credentials only ever land in the Keychain or in container process memory, never in a plaintext file.

The first time `security` reads the entry, macOS prompts you. **Allow** (per invocation) is the more defensible choice for a host-compromise threat model; **Always Allow** trades that protection for fewer prompts.

To rotate the token:

```sh
security delete-generic-password -s "vision-claude-code-token"
# then re-run claude setup-token + security add-generic-password
```

As a fallback the wrapper also picks up `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` from your shell env (worse posture — plaintext on disk).

## Git (read-only inside)

The container can **read** git history but cannot change it: `.git` is mounted read-only, no `GH_TOKEN`/`GITHUB_TOKEN` is forwarded, and no ssh-agent is forwarded. So `git status`/`diff`/`log`/`show` work, but `git commit`/`push` and `gh pr create` fail by design. Make changes inside the container (they appear on the host via the bind mount), then **commit and push from your host**, where your gitconfig, signing key, and gh auth live.

## Known limitations

**Browser workloads (Playwright and Puppeteer)** — Chromium and its system libraries are not
installed, and the hardened egress allowlist excludes browser download hosts. Run E2E tests and
PDF-rendering development on the host. The scheduled E2E workflow remains the supported Linux
browser environment.

**Electron `.dmg` build** — `bun run dist` requires macOS native tools. Run on the host, not in this container.

**App `fetch` to non-allowlisted hosts** — works for allowlisted hosts via `NODE_USE_ENV_PROXY=1` (e.g. yahoo-finance reaches `*.finance.yahoo.com` through the proxy); anything not in the baked allowlist is denied.

**Host Ollama** — blocked. Add the host's address to the allowlist (`base-allowlist.txt` or `allowlist.extra.txt`), re-run `sync.sh`, and rebuild if you want it reachable.

## Related

- [[.devcontainer/README.md]] — concise user-facing reference for the sandbox; this guide mirrors it.
- [[docs/adr/077-devcontainer-apple-container-runtime|ADR-077]] — the migration off Docker Compose to apple/container.
- [[.devcontainer/Dockerfile]] — `debian:bookworm-slim` base, PostgreSQL 18 apt install, bun, Claude Code, baked egress allowlist.
- [[docs/guides/setup]] — standard (non-container) local development setup.
- [[docs/security/container-hardening]] — production container security policies.
- [[docs/reference/environment-variables]] — complete environment variable reference.
