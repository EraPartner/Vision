# TODO

Legend: **P1** blocker/foundation · **P2** high-value · **P3** nice-to-have

---

## Bugs

- Rate limiting kicks in immediately. When disabling GlobalRateLimitier (commenting out), this issue doesn't occur

### Missing translations

_None tracked._

---

## Features

_None tracked._

---

## Architecture / Foundation

### P1 — Unified API envelope (blocks envelope-consumer migration)

Backend currently emits raw `res.json(payload)`; frontend `lib/api/client.ts` has no envelope helpers. ADR-026 unimplemented. Plan's Unit 7 (envelope unwrap) blocked on this. Build end-to-end, 6–10 serial units:

1. **Backend middleware** (`apps/node-backend/src/middleware/`)
   - `wrapResponse` → `{ ok: true, data }`
   - Rewrite `errorHandler` → `{ ok: false, error: { code, message, details? } }`
   - Keep HTTP status codes.
2. **Error-code enum** — new `packages/types/errors.ts` + mirrored JS constant. Values: `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL`, etc.
3. **Frontend helpers** (`apps/frontend/src/lib/api/client.ts`)
   - `unwrapEnvelope<T>(res): T`
   - `ApiClientError extends Error { code; status; details }`
   - `parseEnvelopeError`
4. **Per-route audit** (~30 files in `apps/node-backend/src/routes/*.js`). Zero raw `res.json`. Zero `{ detail }` / `{ message }` variants.
5. **Per-consumer migration** (46 importers of `apps/frontend/src/lib/api/`). Reads via `unwrapEnvelope`. Catch blocks narrow to `ApiClientError`.
6. **Tests** — route integration asserts envelope shape; frontend hook tests assert typed-error propagation.

**Success:** zero raw `res.json` in routes, zero bare `fetch().then(r=>r.json())` outside `client.ts`, error-code enum exhaustive, ADR-026 marks Implemented.

**Do NOT batch as single unit.**

### P2 — Viz library dedupe: `@visx/*` → `recharts`

10 `@visx/*` packages still in `apps/frontend/package.json`. Consumers: chart primitives in `apps/frontend/src/components/charts/` (~2100 LOC / 12 files): `AreaChart`, `BarChart`, `LineChart`, `StackedBarChart`, `PieChart`, `DonutChart`, `Sparkline`, `ChartAxis`, `ChartLegend`, `ChartTooltip`, `palette.ts`, `index.ts`. Used by 13+ pages.

Phases:

1. **Pre-work (blocker)** — Playwright baselines per primitive, light+dark, breakpoints 320/768/1440, under `apps/frontend/tests/visual/charts/`.
2. **Port primitives** — one PR per primitive. Preserve framer-motion, LinearGradient overlays, reference lines, custom axes, stacked series, token-driven palette, hover/focus. Compose `<defs>` + custom shapes where recharts lacks parity.
3. **Drop packages** — after all primitives port + visual diffs pass. Regenerate `bun.lock`. Verify bundle shrinks.

**Do NOT batch as single unit** (tried Phase-0 Unit 4, worker refused — 2k LOC + 13 consumers exceed unit scope).

**Success:** zero `@visx/*` imports, visual diff ≤ 0.5% per chart, bundle ≥ 80kb gzipped smaller.

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
