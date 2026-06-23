---
title: "ADR-062: Frontend Type-Check Gate Enforcement"
type: adr
status: Accepted
date: 2026-05-29
tags: [adr, typescript, ci, type-safety, tooling, quality-gate]
description: The CI type-check job was validating zero files; made it real, fixed the 160 latent type errors it had been hiding, and wired CI to enforce it.
aliases: [adr-062, typecheck gate, tsc gate]
---

# ADR-062: Frontend Type-Check Gate Enforcement

## Status
Accepted

## Date
2026-05-29

## Context

The CI `typecheck` job (`.github/workflows/ci.yml`, mirrored in `release.yml`) ran
`cd apps/frontend && bunx tsc --noEmit`. That command resolves `apps/frontend/tsconfig.json`,
which is a **solution-style** config: `"files": []` with `references` to `tsconfig.app.json`
and `tsconfig.node.json`. Without `tsc -b` (build mode), project references are **not**
followed, so the invocation type-checked **zero files** (verified: `tsc --listFilesOnly`
reports 0 files via `tsconfig.json` vs **435** via `tsconfig.app.json`).

Because the Vite production build uses SWC (`@vitejs/plugin-react-swc`), which strips types
without checking them, **no step in the build or CI pipeline actually type-checked the app
source.** The gate was green while validating nothing. Over time this allowed **160 type
errors across 57 files** to accumulate on `main` undetected — a mix of:

- Config lag (`target`/`lib` pinned to ES2020 while code used ES2021 `String.replaceAll` and
  ES2022 `Array.at`).
- A missing dev dependency (`@types/d3-array`) leaving chart code implicitly `any`.
- Library/API drift (react-router v7 removed the `future` prop; react-day-picker v10 renamed
  `classNames` keys and replaced `IconLeft`/`IconRight` with `Chevron`; Zod v4 `z.record`
  requires an explicit key schema; vitest 4 changed the `vi.fn<…>` generic form).
- Genuine latent bugs (e.g. `TransactionsPage` optimistic-edit wrote `bank_account` instead of
  `bank` and spread un-coerced values; `SplitItem`/`OwedSummary` API types were out of sync;
  nullable indexing in `CategoryTrendChart`).

## Decision

1. Add a real **`typecheck`** script to `apps/frontend/package.json`:
   `tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.node.json --noEmit`, plus a root
   `typecheck` script that filters to the frontend workspace.
2. Point the CI `typecheck` job and the `release.yml` type-check step at
   `cd apps/frontend && bun run typecheck` (real, references both leaf projects).
3. Bump the frontend `target`/`lib` from **ES2020 → ES2022** (`apps/frontend/tsconfig.app.json`,
   `apps/frontend/tsconfig.json`, `config/tsconfig.app.json`) — the runtime targets
   (evergreen browsers + Electron) fully support it and SWC already emits these features.
4. Add the genuinely-missing `@types/d3-array` dev dependency.
5. Fix all **160** type errors so the now-real gate is green, fixing the latent bugs above
   along the way.

## Consequences

- **Positive:** the type-check gate now validates 435 files; type regressions are caught in CI
  instead of reaching `main`. Several real runtime bugs were fixed as a side effect.
- **Positive:** developers get accurate `tsc` results locally via `bun run typecheck`.
- **Follow-up (done):** `components/ui/calendar.tsx` has since been migrated to the
  react-day-picker v10 styling API — `classNames` keys renamed (`caption`→`month_caption`,
  `cell`→`day`, `day`→`day_button`, `nav_button*`→`button_previous`/`button_next`,
  `head_row`→`weekdays`, `row`→`week`, `day_selected`→`selected`, …), `IconLeft`/`IconRight`
  replaced by the `Chevron` component, and the temporary cast removed. Typecheck + tests pass;
  a visual spot-check of the calendar theme in the running app is the only remaining item
  (tracked in `TODO.md`).
- **Verification:** `bun run typecheck` exits 0 (app + node); backend `tsc -p tsconfig.check.json`
  exits 0; frontend 1,379 tests pass; backend 1,983 tests pass; ESLint 0 errors.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/031-openapi-type-generation-frontend|ADR-031: OpenAPI Type Generation]]
