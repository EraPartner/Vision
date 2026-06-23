---
title: ADR-077 Devcontainer Apple Container Runtime
type: decision
status: Accepted
date: 2026-06-13
tags: [infrastructure, devcontainer, apple-container, docker, macos]
description: Migrate the devcontainer launcher from Docker Compose (compose.yaml) to Apple's native container runtime (apple/container), removing the Docker Desktop dependency on macOS.
aliases: [adr-077, apple-container, devcontainer runtime]
---

# ADR-077: Devcontainer Apple/Container Runtime

## Status
Accepted

## Date
2026-06-13

## Context

The Vision devcontainer previously used Docker Compose (`compose.yaml`) as its container runtime. The host-side launcher (`bin/claude`) invoked `docker compose up -d --build`, mounted volumes, and forwarded credentials into the container. This required Docker Desktop to be installed and running on the developer's Mac.

Docker Desktop carries non-trivial overhead (a Linux VM, a background daemon, and significant RAM), and its licensing terms changed for commercial use. Apple introduced its own native container runtime (`apple/container`) for macOS, which uses a lightweight VM backed by the macOS Virtualization framework. It provides a `container` CLI with semantics close to `docker run`/`docker exec`/`docker build` but without requiring Docker Desktop.

Key differences between Docker Compose and apple/container relevant to this project:

- `--init` replaces compose's `init: true`.
- `--tmpfs` takes a bare path (no options string).
- There is no `--security-opt no-new-privileges` flag; the VM boundary replaces it.
- Named volumes (`vision-claude`, `vision-pgdata`) are native apple/container volumes; root in the entrypoint can `chown /var/lib/postgresql` to initialize Postgres (host bind mounts cannot do this due to macOS VM ownership constraints, which caused issue #333).

## Decision

Replace the Docker Compose-based devcontainer launcher with an apple/container launcher:

- `compose.yaml` is removed from `.devcontainer/`.
- `bin/claude` is rewritten to use the `container build`, `container run`, `container start`, `container exec` CLI.
- The same hardened image (`Dockerfile`), egress lock, mounts, in-container Postgres, lifecycle scripts (`post-create.sh`, `post-start.sh`), credential forwarding, and config-sync behaviour are preserved.
- Named volumes `vision-claude` and `vision-pgdata` are declared as native apple/container volumes.
- The launch-integrity gate (`vision-verify-pins`) and the autosync trap remain in place.

The `container` binary must be installed and `container system start` must have been run before invoking the launcher. The launcher checks both preconditions and exits with a clear error if either is missing.

## Consequences

### Positive

- Docker Desktop is no longer required on the developer's Mac; `container system start` is the only prerequisite.
- Lighter-weight VM startup — apple/container uses the macOS Virtualization framework directly; no separate Docker Desktop VM.
- Named volumes allow the entrypoint to initialize Postgres via `chown` (the host-bind-mount ownership issue that caused #333 is resolved).
- Licensing concerns around Docker Desktop for commercial use are eliminated.

### Negative

- **macOS only** — `apple/container` is a macOS-native tool; the devcontainer cannot be launched on Linux or Windows with this launcher. Developers on non-macOS hosts must export `CLAUDE_CODE_OAUTH_TOKEN` and adapt the run command manually.
- **README is stale** — `README.md` still references `docker compose` in several places (shell-drop instructions, port-binding descriptions). These must be updated to use `container exec` equivalents.
- **No Compose file** — Tooling that parsed `compose.yaml` (e.g. VS Code devcontainer extension auto-detect) no longer finds a compose file. The devcontainer is launched exclusively via `bin/claude`.
- **`--security-opt` flags absent** — `no-new-privileges` and `seccomp` profiles available in Docker are not available; the VM boundary provides equivalent isolation but the explicit flag is gone.

### Neutral

- The egress firewall (`iptables`, squid proxy), network policy, and allowlist mechanism are unchanged — they run inside the container and are independent of the outer runtime.
- The `vision-claude-sync` fish functions and Keychain credential flow are unchanged.

## Related

- [[.devcontainer/bin/claude]] — Rewritten launcher using `container` CLI
- [[.devcontainer/README.md]] — Needs docker-compose references updated to `container exec` equivalents
- [[docs/adr/index|All ADRs]]
