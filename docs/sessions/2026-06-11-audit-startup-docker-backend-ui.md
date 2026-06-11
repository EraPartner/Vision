---
title: "Session audit — startup/Docker performance, unaudited backend, premium UI (2026-06-11)"
type: session
date: 2026-06-11
tags:
  - audit
  - performance
  - startup
  - docker
  - electron
  - ui
  - session
description: "Inline audit of the areas no prior round covered: startup flow + Docker performance (new lens), never-audited backend modules, frontend state layer, and the V9–V12 premium UI code. 14 findings, deduped against all TODO.md rounds."
---

# Session audit — 2026-06-11

Single-session inline audit (no subagents). Scope was chosen to **complement** the seven
prior audit rounds in `TODO.md` ([[docs/reference/codebase-audit-2026-05|May 2026 report]],
June rounds 1–7): everything below was checked against the open items and the
"Audited & clean" lists before filing — **no item here duplicates TODO.md**.

Lenses requested: correctness, performance, code design, premium/Apple UI, functionality,
plus a dedicated lens on **startup flow + Docker performance**.

> [!info] Working-tree caveat
> Another agent was actively fixing TODO.md items in the working tree during this audit.
> Files in flux (data hooks, chart consumers, repositories listed in `git status`) were
> deliberately **not** re-audited. Findings below are in stable, untouched code paths.

## Coverage

- **Startup/Docker:** `docker-compose*.yml` (root + Electron-baked — verified in sync),
  `Dockerfile`, `docker-entrypoint.sh`, backend boot (`main.js`, `startup/warmup.js`,
  `database/connection.js`), Electron orchestration (`packaging/electron/main.js`: launch,
  compose fast paths, health polling, quit).
- **Backend (never audited before):** `middleware/requestMetrics.js`,
  `services/aggregationRefresh.js`, `jobs/refreshCashflowForecastMc.js`, `lib/network.js`,
  `integrations/ollama/client.js`, `routes/watchlist.js` + repository.
- **Frontend state layer:** `stores/settingsStore.ts`, all 8 contexts (App/Theme/
  SettingsPreload/Workspace read fully), and the V9–V11 premium commit (`dialogGenie.ts`,
  `useUpcomingPlannedPayments.ts`, `Sparkline` scrub, `NetSummaryCard`, `SuggestionCard`).
- **UI premium pass:** design tokens (`index.css`), reduced-motion/-transparency coverage,
  focus-ring idioms, raw-color token bypasses, Electron shell feel (splash, window state).

---

## Findings — startup flow & Docker performance

### P1 (high) Quit runs `docker compose down`, defeating the warm-boot fast path ^p1-compose-down

- **Files:** `packaging/electron/main.js` — `will-quit` handler calls `stopContainers()`
  (≈line 3085), which runs `compose … down` (line 1178–1181); `composeStartOrUp()`
  (lines 1141–1176) implements a `compose start` fast path for *existing stopped*
  containers.
- **Why it matters:** `down` **removes** containers + network on every quit, so the
  `compose start` fast path the launcher carefully implements can almost never fire for a
  packaged app — every boot pays full container/network recreation instead of a much
  cheaper `start` of existing containers. The boot-mark telemetry (`compose_up` phase)
  will show the difference directly.
- **Fix:** use `compose stop` on quit (function is even named `stopContainers`); keep
  `down` for the explicit clean-run flow (`docker-compose.clean.yml`) and maintenance
  paths. Note `restart: unless-stopped` semantics are preserved: user-stopped containers
  do not auto-start when the Docker daemon relaunches.
- **Verify:** quit + relaunch packaged app; boot marks should show `compose_up` dropping
  to sub-second `compose start`, and `docker ps -a` should show the containers surviving
  quit as `exited`.

### P2 (medium) Dockerfile busts the dependency layer on shared-utils / i18n edits ^p2-docker-layers

- **File:** `Dockerfile` — stage 1 copies `packages/` (line 18), `i18n/source` (19) and
  `scripts/generate-locales.js` (20) **before** `RUN bun install` (21); stage 2 copies
  `packages/` (62) before its install (65).
- **Why it matters:** any edit to `packages/shared-utils/src/*` or a locale string
  invalidates the `bun install --frozen-lockfile` layer → full dependency reinstall in
  every image build. This tax is paid on each dev-watcher rebuild
  (Electron dev mode rebuilds the image on source change) and in CI.
- **Fix:** copy only the workspace manifests (`packages/*/package.json`) before install
  (bun resolves the workspace graph from manifests); copy full `packages/` and
  `i18n/source` *after* the install layer, before the build steps that need them.
- **Verify:** `docker build` twice with a one-line change in
  `packages/shared-utils/src/money.js` between runs — second build must show
  `CACHED` on the install layer.

### P3 (medium) Dev rebuild watcher disagrees with `DOCKER_PATHS` ^p3-watcher

- **File:** `packaging/electron/main.js` — `watchTargets` (line 2971) =
  `apps/frontend`, `apps/node-backend`, `package.json`, `bun.lock[b]`; `DOCKER_PATHS`
  (lines 121–126) additionally includes `packages/`, `i18n/`, `scripts/generate-locales.js`.
- **Two consequences:** (a) editing `packages/` or `i18n/source` in Electron dev mode
  never triggers the auto-rebuild — the container keeps serving stale shared-utils/locales
  until relaunch (the *next* launch then rebuilds via the skip-build cache check, which
  does consult `DOCKER_PATHS` — confusing split behavior); (b) both watched app dirs
  contain `node_modules/` (verified present), so installs fire spurious rebuilds; only
  editor temp files are filtered (line 3026).
- **Fix:** add `packages/` and `i18n/source` to `watchTargets`; in the watch callback,
  ignore `node_modules/`, `dist/`, and dot-directories.

### P4 (medium, verify on stack) Backend shutdown likely always burns the 10 s force-exit ^p4-shutdown

- **Files:** `apps/node-backend/src/main.js` — `shutdown()` awaits
  `httpServer.close()` (line 511) with a 10 s force-exit backstop (line 482);
  `packaging/electron/main.js:875` — the health watchdog uses a
  `keepAlive: true` agent, so an idle keep-alive socket to the backend is the norm.
- **Why it matters:** `server.close()` does not terminate *idle keep-alive* connections
  on Node < 19 semantics, and Bun's `node:http` behavior here is unverified — if idle
  sockets keep the server open, **every** `docker compose stop`/quit waits the full 10 s
  (force-exit or Docker's SIGKILL), slowing quit and restart cycles and making shutdown
  look unclean in logs.
- **Fix:** call `httpServer.closeIdleConnections?.()` right after initiating
  `httpServer.close()`; optionally destroy the Electron `healthAgent` before stopping
  containers.
- **Verify:** time `docker compose stop app` while the app window is open — should drop
  from ~10 s to <1 s; backend log should show clean exit, not
  "Graceful shutdown timed out".

### P5 (low) Boot splash is a bare data-URL — perf telemetry exists to do better ^p5-splash

- **File:** `packaging/electron/main.js` lines 2753–2756: hardcoded-English
  "Starting Vision…", hardcoded `#0f172a` background (wrong in light theme), no icon,
  no progress.
- **Why it matters:** this is the single most-seen "slow" moment of the packaged app —
  cold starts can sit on it through image pull + postgres init + migrations. The shell
  already emits structured boot marks (`bootMark`) and i18n is initialized *before* the
  window opens (line 2739), so a localized, theme-aware splash with phase feedback
  ("Pulling image… / Starting database… / Warming caches…") is cheap to build and would
  remove most perceived startup cost. Counts double as a premium-feel item.

> [!success] Startup paths verified clean (skip next audit)
> Root vs Electron-baked compose **in sync** (only intentional image/name/env diffs; both
> carry `attachments_data` + `vision_cache_data`); db healthcheck tuning; parallel
> container start (no `depends_on`) + backend's own 40-attempt backoff poll;
> `docker-entrypoint.sh` (DB wait correctly moved into backend); Alembic-skip cache
> volume; postgres 18 `/var/lib/postgresql` mount (correct for v18 PGDATA); pool config
> (5 s connect timeout, 30 s statement timeout, read-only transient retry, poisoned-client
> destroy); warmup orchestration (offline probe gates outbound fetches, in-flight guards
> on intervals, tri-state `warmupStatus` + `/health/detailed` contract); Electron
> `checkDocker` socket fast path, parallel init (port/env/docker/pre-pull/skip-build),
> tiered health polling, dev skip-build cache; hand-rolled gzip middleware backpressure;
> SPA shell served from memory; graceful-shutdown interval cleanup.

---

## Findings — backend (modules never audited)

### B1 (medium) Ollama `chatStream` keeps only the **last** chunk's tool calls ^b1-ollama-tools

- **File:** `apps/node-backend/src/integrations/ollama/client.js` lines 311–313:
  `toolCalls = msg.tool_calls;` inside the per-chunk handler — assignment, not
  accumulation.
- **Why it matters:** when Ollama streams multiple tool calls across separate NDJSON
  chunks (model/version dependent), all but the last chunk's calls are silently dropped —
  the AI-chat tool loop then executes a subset of what the model asked for.
- **Fix:** `toolCalls.push(...msg.tool_calls)` (init `[]`), dedupe defensively on
  `function.name` + arguments if double-emission is observed. Add a unit test streaming
  two chunks with one tool call each and assert both survive.

### B2 (low) Ollama stream timeout is a total budget, not an inactivity timeout ^b2-ollama-timeout

- **File:** same file, line 225 — `withTimeout(signal, requestTimeoutMs)` wraps the whole
  streaming request; default `OLLAMA_REQUEST_TIMEOUT_MS` is 600 000 (`config/env.js:87`).
- **Why it matters:** a healthy stream that takes >10 min total (large model on CPU, long
  context) is aborted mid-generation even though tokens are actively flowing, surfacing
  as a confusing `TIMEOUT` in chat.
- **Fix:** reset the timer on every chunk read (idle timeout, e.g. 120 s without a chunk)
  instead of one fixed budget; keep a generous absolute ceiling if desired.
- **Also (cosmetic):** lines 226–244 log every chat turn at `info` — drop to `debug` to
  match the request-logging convention.

### B3 (low) Watchlist routes skip type validation — bad input becomes a DB 500 ^b3-watchlist

- **File:** `apps/node-backend/src/routes/watchlist.js` — POST (line 44) checks only
  presence of `name`/`asset_class`/`target_price`; PATCH (line 56) forwards `req.body`
  unchecked. The repository correctly **allowlists columns** (verified,
  `watchlistRepository.js:73`), so this is robustness, not injection: a string
  `target_price: "abc"` reaches the numeric column and 500s instead of returning a 400
  `ValidationError`.
- **Fix:** validate `target_price` (finite number), `asset_class` (enum), `currency`
  (3-letter) in both handlers, mirroring the other routes' patterns.

> [!success] Backend modules verified clean (skip next audit)
> `middleware/requestMetrics.js` (reservoir sampling, 500-store cap, unmatched-route
> collapse, window eviction); `services/aggregationRefresh.js`;
> `jobs/refreshCashflowForecastMc.js` (bounded concurrency, per-user error isolation);
> `lib/network.js` (SYN-bounding timer, 30 s cache, in-flight dedupe); Ollama client
> error taxonomy + abort composition (apart from B1/B2); watchlist repository
> allowlisting; CORS/CSP/security-header middleware in `main.js`.

---

## Findings — frontend correctness / functionality

### F1 (medium) Dismissing a recurring payment reminder silences it **forever** ^f1-dismiss

- **File:** `apps/frontend/src/hooks/useUpcomingPlannedPayments.ts` — dismissed set is
  keyed by `pt.id` alone (lines 47–60, 88) and persisted to localStorage with no expiry.
- **Why it matters:** recurring planned transactions keep their row id while
  `planned_date` advances each cycle. Dismiss this month's rent reminder once → the id
  stays in the dismissed set → **every future occurrence** is filtered from both the
  banner and the dashboard SuggestionCard. The set also grows unboundedly. This predates
  the V11 refactor (the old banner had identical semantics — verified against
  `c80a16ff^`) but now affects two surfaces and the macOS dock badge count.
- **Fix:** key dismissals as `` `${id}:${planned_date}` `` so each occurrence re-surfaces
  when it becomes due; prune entries whose date is past on every write (also fixes the
  growth). Migrate by simply ignoring old numeric-only entries.
- **Verify:** frontend test — dismiss a recurring item, advance its `planned_date`
  (mock), assert it reappears in `visibleUpcoming`.

## Findings — UI / premium-Apple feel

### U1 (medium) 141 raw Tailwind palette colors bypass the semantic tokens ^u1-raw-colors

- **Scope (grep `text|bg-(red|green|blue|emerald|rose|amber)-NNN` in components/pages/
  features, tests excluded):** top offenders `pages/ImportReviewPage.tsx` (7),
  `components/devtools/*` (17), `pages/portfolio/WatchlistPage.tsx` (6),
  `pages/portfolio/PerformancePage.tsx` (5), `features/imports/TransactionImportCard.tsx`
  (5), `features/ai-chat/OllamaStatusBanner.tsx` (5), `components/tax/TaxProfileDialog.tsx`
  (3), admin pages (8).
- **Why it matters:** these hardcoded greens/reds ignore theme variants **and the new
  macOS system-accent override** (ADR-072), so exactly the surfaces above fall out of
  palette when the user switches variants — visibly cheaper than the swept pages.
  `ImportReviewPage.tsx:417` even mixes idioms in one ternary
  (`text-destructive` vs `text-emerald-600`). The B3 DeltaPill sweep stopped at the
  portfolio pages; this is the remainder.
- **Fix:** sweep to `text-accent`/`text-destructive`/`DeltaPill`/Badge variants
  (devtools/admin last — lowest visibility). Mechanical, low-risk; suggest one commit per
  page cluster.

### U2 (medium) Electron window forgets its size/position ^u2-window-state

- **File:** `packaging/electron/main.js` `createWindow()` (line 1205) — fixed
  1280×800, centered, every launch; no bounds persistence anywhere in the file.
- **Why it matters:** restoring window frame across launches is baseline macOS behavior;
  its absence is one of the most noticeable "not a real Mac app" tells, especially next
  to the V12 native-shell work (traffic lights, menu bar, dock, vibrancy).
- **Fix:** persist `getNormalBounds()` (debounced on `resize`/`move`, plus on quit) into
  the existing `settings.json` mirror; on create, restore after clamping to the current
  display's `workArea` (handles unplugged monitors). ~25 lines, no new dependency.

### U3 (low) Boot splash (see [[#^p5-splash|P5]]) — also the premium gap ^u3-splash

Unlocalized, theme-blind, icon-less. One item, two lenses.

### U4 (low) Overscroll rubber-band in the Electron shell — visual QA ^u4-overscroll

- `overscroll-behavior` is unset app-wide (verified). In the packaged shell, rubber-band
  overscroll exposes the body background seam — and in vibrancy mode
  (`html.electron-mac.vibrancy` sets a translucent body, `index.css:488`) whatever the
  compositor shows behind it. Check at 1440px dark + light with enhancedEffects on; if a
  seam shows, `overscroll-behavior-y: none` on the scroll root is the fix.

### U5 (trivial) Two `focus:ring` stragglers vs the `focus-visible:ring` convention (33 uses); SuggestionCard hand-rolls `countSingle`/`countPlural` instead of the existing `tc()` plural helper. ^u5-nits

> [!success] Frontend/UI verified clean (skip next audit)
> `stores/settingsStore.ts` + all eight contexts — notably `ThemeContext` (epoch-guarded
> async accent application, View-Transition theme swap, first-persist skip, schedule
> resolution incl. inverted windows) and `SettingsPreloadContext` (single-fetch hydration,
> cancellation); `WorkspaceContext`; V9–V11 code: `dialogGenie.ts` (capture listener,
> recency gate, reduced-motion story), `Sparkline` scrub rendering, `NetSummaryCard`
> scrub state (pointer capture, clamped index, stale-index guard), `SuggestionCard`
> data flow, dismissed-set storage key continuity (no migration break);
> `useUpcomingPlannedPayments` query-key/window derivation (modulo F1); design-system
> hygiene: `::selection`, scrollbar styling, font smoothing,
> `prefers-reduced-motion` (incl. aurora pause) and `prefers-reduced-transparency`
> coverage; drag-drop CSV on all three import cards + window-level handoff.

---

## Suggested priority order

1. [[#^f1-dismiss|F1]] recurring-reminder dismissal (user-visible data loss of reminders)
2. [[#^p1-compose-down|P1]] `compose stop` on quit (every packaged boot benefits)
3. [[#^b1-ollama-tools|B1]] Ollama tool-call accumulation (silent AI-chat misbehavior)
4. [[#^u1-raw-colors|U1]] raw-color sweep + [[#^u2-window-state|U2]] window-state (premium polish with broad visibility)
5. [[#^p2-docker-layers|P2]]/[[#^p3-watcher|P3]] build-loop speed, [[#^p4-shutdown|P4]] shutdown timing (verify first)
6. [[#^b2-ollama-timeout|B2]], [[#^b3-watchlist|B3]], [[#^p5-splash|P5]]/[[#^u3-splash|U3]], [[#^u4-overscroll|U4]], [[#^u5-nits|U5]]

## Residual risk / not covered

- Files actively being modified by the TODO-fix agent were skipped (data hooks, chart
  consumers, repositories in `git status`) — re-audit after that batch lands if desired.
- P4 and U4 are *verify-then-fix* items: both need the running stack/app to confirm.
- No runtime profiling was done (static review only); the boot-mark telemetry already in
  place is the right tool to quantify P1/P4 before/after.
