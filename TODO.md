# TODO

Legend: **P1** blocker/foundation · **P2** high-value · **P3** nice-to-have

---

## Bugs

~~Rate limiting kicks in immediately. When disabling GlobalRateLimitier (commenting out), this issue doesn't occur~~ — **Fixed**: global limiter removed from API routes; per-route limiters (admin: 10/min, import: 5/min) remain for expensive/destructive ops.

### Missing translations

_None tracked._

---

## Features

_None tracked._

---

## Architecture / Foundation

### ~~P1 — Unified API envelope~~ — ✅ Implemented

ADR-026 wired end-to-end: backend `wrapResponse` + envelope `errorHandler`, shared error-code enum in `packages/types/errors.ts`, frontend `unwrapEnvelope` + `ApiClientError`, per-route audit + per-consumer migration, integration + hook tests green.

### ~~P2 — Viz library dedupe~~ — Superseded by [ADR-028](docs/adr/028-reaffirm-visx-over-recharts.md)

visx/d3 retained as canonical chart primitive stack. Unused sub-packages (`@visx/hierarchy`, `@visx/text`, `@visx/tooltip`) removed as hygiene win.

### P2 — Electron sync I/O → promises (runtime paths)

Remaining sync sites: `loadI18n` / `loadSettings` / `saveSettings` in `packaging/electron/main.js` (lines 11, 48, 98, 119, 154, 167, 239, 250, 261, 272). 14+ call sites, coupled to module-load init. Convert alongside startup restructure, not standalone.

### P3 — Env var naming standardization

Unify across `docker-compose*.yml`, `packaging/electron/`, `apps/node-backend/src/config/`. Single canonical list, documented in `docs/reference/env-vars.md`.

---

## Hardening

### P2 — Electron CSP meta tag audit

`apps/frontend/index.html` has no `<meta http-equiv="Content-Security-Policy">`. Renderer runs with default CSP. Define nonce-based policy aligned with `.claude/rules/web/security.md`. Verify against Electron `contextIsolation: true` + `sandbox: true` posture.

### P3 — Electron build-cancellation in dev file-watcher

`packaging/electron/main.js:~1558-1604` rapid-fire triggers can stack docker rebuilds. Debounce + cancel in-flight rebuild on new event.

### P3 — Dockerfile frontend-builder prune

`Dockerfile:12-13, 44-45` copies `apps/node-backend/package.json` into frontend-builder stage. Revisit dropping once lockfile/workspace install tolerates it without `--frozen-lockfile` break.

---

## Dropped

- ~~Frontend banner consuming `/health/detailed`~~ — endpoint never built, speculative UI, no user demand.
