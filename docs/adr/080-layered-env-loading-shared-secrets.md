---
title: ADR-080 - Layered Backend Env Loading with a Shared Root Secrets Base
type: adr
status: accepted
date: 2026-06-16
tags: [adr, env, dotenv, configuration, secrets, provider-keys, loadDotenv, docker, local-dev, streamline, research-providers]
related: [docs/adr/030-frontend-environment-schema, docs/adr/079-multi-provider-research-aggregation, docs/reference/environment-variables]
description: Backend loadDotenv now layers two files — apps/node-backend/.env.local (dev-specific overrides) then the repo-root .env (shared secrets base, the same file Docker reads via env_file) — so context-independent secrets like provider API keys live in ONE place across local-dev and Docker. Retires the unused stray root .env.local that read by nothing and caused confusion.
---

# ADR-080: Layered Backend Env Loading with a Shared Root Secrets Base

## Status

**Accepted** — Implemented 2026-06-16.

## Date

2026-06-16

## Context

Vision had four env files in play, and which one is read depends on *how* you run the app — which was confusing (surfaced when adding the ADR-079 research provider keys):

| File | Read by | Context |
|---|---|---|
| root `.env` | `docker-compose.yml` → `env_file: .env` (root + embedded electron compose) | Docker / desktop app |
| `apps/node-backend/.env.local` | `config/loadDotenv.js` (hard-coded to this one path) | local-dev backend |
| `apps/frontend/.env.local` | Vite built-in (`VITE_`-prefixed only) | local-dev frontend |
| root `.env.local` | **nothing** | — (stray) |

Two problems:

1. **Secrets had to be duplicated.** Provider API keys are *context-independent* (the same key works in dev and Docker), but the backend read them only from `apps/node-backend/.env.local` in dev and only from root `.env` in Docker — so a key had to be pasted into two files.
2. **A stray root `.env.local`** existed that no loader reads (Bun's incidental auto-env-loading aside), so it looked like the place to put config but silently did nothing.

The env split itself is *not* removable: dev and Docker need genuinely different **DB/host config** (dev → `localhost:5433`; Docker → `db:5432` with a generated `POSTGRES_PASSWORD`). The fix is to separate *context-specific config* from *context-independent secrets*, not to merge the files wholesale.

## Decision

`loadDotenv.js` now loads **two** files, layered, into `process.env`:

1. `apps/node-backend/.env.local` — local-dev **overrides** (localhost `DATABASE_URL`, CORS, ports, log level).
2. `<repo-root>/.env` — the **shared secrets base** (provider API keys and any other context-independent secret) — the same file Docker reads via `env_file: .env`.

**Precedence** (highest first): a real `process.env` value → `apps/node-backend/.env.local` → root `.env`. Implemented by applying the dev-local file first and only setting keys not already present (`applyDotenvFile` is unchanged in that respect).

Consequences of the precedence choice:

- **Provider keys live ONCE, in root `.env`**, and are read by both Docker (compose `env_file`) and local dev (this loader's second layer).
- **Dev DB config wins**: `apps/node-backend/.env.local` sets `DATABASE_URL=…localhost…` first, so the root `.env`'s Docker DB URL never overrides it.
- **Docker is unaffected**: compose injects root `.env` into `process.env` before this runs, and `apps/node-backend/.env.local` is absent in the image, so the loader is a no-op there.

The stray **root `.env.local` is retired**: nothing reads it; secrets go in root `.env`, dev overrides in `apps/node-backend/.env.local`. (It is `.gitignore`d, so removal is a working-tree action for each clone — the templates and docs no longer reference it.)

`dotenvLoadedFrom` changes from a single path to an array of the files that were applied (it had no external consumers).

## Consequences

### Positive

1. **One home for keys.** Provider API keys (and future context-independent secrets) live only in root `.env`; no more dev-vs-Docker duplication.
2. **Less confusion.** Each file has a single clear job; the do-nothing stray is gone.
3. **Docker behavior unchanged**; dev behavior is a strict superset (now also reads root `.env` as a fallback base).

### Negative / Tradeoffs

1. **Dev relies on its own `DATABASE_URL`.** If `apps/node-backend/.env.local` omits `DATABASE_URL`, the root `.env`'s Docker DB URL (`db:5432`) would leak into a dev run and fail to connect. The `.env.local.example` ships the override, and this caveat is documented in the loader.
2. **Dev process now also sees root `.env` secrets** (e.g. `POSTGRES_PASSWORD`) even when unused — acceptable for a single-user self-hosted app on one machine.
3. **Per-clone cleanup**: existing checkouts with a stray root `.env.local` must move any real values into root `.env` and delete it (one-time, manual — the file is gitignored and may contain secrets, so it is not auto-removed).

## Implementation

- **Loader**: [[apps/node-backend/src/config/loadDotenv.js]] — layers `apps/node-backend/.env.local` then root `.env`; `dotenvLoadedFrom` is now an array.
- **Templates**: `apps/node-backend/.env.local.example` (dev overrides only; points to root `.env` for shared secrets) and root `.env.example` (carries the provider-key placeholders, noted as shared).
- **Docs**: [[docs/reference/environment-variables|Environment Variables]] updated with the layering + precedence and a "where do provider keys go" note.

## Related Decisions

- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — introduced the provider API keys whose duplication motivated this.
- [[docs/adr/030-frontend-environment-schema|ADR-030]] — frontend env schema (Vite); unaffected — the frontend keeps its own `apps/frontend/.env.local`.

## Related Docs

- [[docs/reference/environment-variables|Environment Variables Reference]]
- [[docs/adr/index|All ADRs]]
