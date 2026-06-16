# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

> Rebuilt 2026-06-16 after the June audit-backlog clears (`5ac3656c`, `65d3dac0`, `a28dd694`)
> left this file empty while several ADRs still cited "tracked in `TODO.md`". The running-stack /
> built-`.app` / hardware verification items have been completed by the user and removed.

## Open follow-ups (actionable)

- [ ] 🔼 Resolve Kinesis `timeFrame=60` unit ambiguity (ADR-065)
  - `config/kinesisConfig.js` comments said "minutes"; `docs/reference/environment-variables.md`
    said "days"; `providerHealthService` probes with `timeframe=60`. Both docs now flag the unit
    as **unverified** (2026-06-16) rather than asserting. Resolve empirically (fetch `trendline`
    with different `timeframe` values, compare point density) before changing — a wrong unit
    silently changes returned density for all Kinesis metals history.
- [ ] 🔼 Empty-state standardization sweep (T15, ADR-070) — `components/shared/EmptyState.tsx`
      already exists and is adopted on transactions/recipients/portfolio list pages. Sweep the
      remaining pages that show data lists but lack a consistent empty/zero-data state. Per-page
      judgment (dashboards, NotFound, admin, and chart-only pages are intentionally exempt).
- [ ] 🔽 Scorecard `reason` strings are English-only (ADR-081). **Low value:** the UI already
      localizes via the structured `code`; `reason` is an English fallback for API/tests that
      users don't normally see. Localize only if API consumers need it.

## Deferred by design (product/scope decisions — not defects)

- [ ] 🔽 Belgian tax point-in-time FX rates (ADR-058/059) — multi-currency conversion still uses
      today's rates, not purchase-date rates. Same "v3 bucket" as the tax-engine-drift advisory.
- [ ] 🔽 Tax-engine-drift "law-change advisory" banner (ADR-059 option #9).
- [ ] 🔽 Dutch LLM chat support (ADR-024) — deferred until per-model quality is validated.
- [ ] 🔽 Transparent v1→v2 backup migration (ADR-040) — v1 backups stay v1 until re-exported.
- [ ] 🔽 Rolling-window walk-forward backtest (cash-flow-forecast) — only per-calendar-month today.
- [ ] 🔽 Electron async file I/O for `loadSettings`/`saveSettings` — deferred (module-load coupling).
- [ ] ⏬ `split_audit` archival for a future multi-tenant world (ADR-013).
- [ ] ⏬ Bundle a minimal Python runtime for Alembic in the Electron build (ADR-027) — only if the
      bundling strategy materially changes.
- [ ] ⏬ Decide whether to remove the legacy `/api/info/*` router (`main.js:303`). The ADR-016
      shadow middleware is already retired; full removal of `/api/info` is a separate, undecided call.

## Optional cleanup — decided won't-do unless the area is touched anyway

- [ ] 🔽 `buildExclusionClauses` consolidation. `infoRepositoryStatistics.js:76` and
      `infoRepo.monthly.js:124` re-implement the canonical exclusion semantics inline. The code is
      correct and explicitly documented as matching `services/filterBuilder.buildExclusionClauses`.
      Forcing the shared helper into these hand-built aggregation queries (which already emit their
      own joins, `AND`-prefixed clauses, and `params.length`-based placeholders) is a risky refactor
      in money-path SQL for **zero** behavior change. Leave as-is.

## Done in the 2026-06-16 deferred-items audit pass

- [x] ✅ ShortcutsOverlay: added an Electron-only "Desktop app menu" section listing ⌘N (new
      transaction), ⇧⌘I (import CSV), ⌃⌘S (toggle sidebar), ⌘1–9 (go to section) — closes the
      ADR-072 follow-up. 4 new `shortcuts.*` i18n keys (en + nl), gated on `isElectron()`.
- [x] ✅ Doc-drift corrected: `*FailedTitle` Dutch keys (all 18 translated), `CustomCategoryChart`
      removal (ADR-041 addendum), `calendar.tsx` v10 migration (adr/index.md), aggregation shadow
      mode already retired (ADR-016).
- [x] ✅ Kinesis `timeFrame` unit contradiction reconciled to "unverified" in `kinesisConfig.js`
      and `environment-variables.md` (value unchanged — needs an empirical probe, see above).
- [x] ✅ Running-stack / built-`.app` / hardware verifications completed by the user (calendar
      visual spot-check, 4K-TV GPU profiling, AZERTY accelerator test, E2E visual snapshots,
      import→commit E2E, migrations 0039–0043).
