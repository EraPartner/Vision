---
title: "ADR-038: Dependency Slim-Down — Supply Chain Risk Reduction"
type: adr
status: Accepted
date: 2026-04-25
tags: [adr, dependencies, security, supply-chain, frontend, backend]
description: Remove 9 third-party packages and replace with native/already-present alternatives to reduce supply-chain attack surface.
aliases: [dependency-slim-down, supply-chain]
---

# ADR-038: Dependency Slim-Down — Supply Chain Risk Reduction

## Status
Accepted

## Date
2026-04-25

## Context

The Vision monorepo had accumulated 869 transitive packages (~573 MB). Each third-party package is a potential supply-chain attack vector. An audit identified packages where the risk/reward ratio favoured removal:

- Packages wrapping only 1–3 files of the project
- Packages whose functionality could be replaced with native Node/browser APIs or already-present deps
- Dead-code UI components pulled in via shadcn/ui but never used

Packages where stakes are high (a11y, security, financial math) were explicitly kept.

## Decision

Remove the following packages across 5 phases:

### Phase 1 — Dead code & unused
| Package | Reason |
|---|---|
| `next-themes` | Only used in `sonner.tsx` to read dark mode; replaced with `document.documentElement.classList.contains('dark')` |
| `pdfkit` + GET `/financial` endpoint | GET `/financial` was a legacy route never called by the frontend; POST `/financial` (puppeteer) is the live path |

### Phase 2 — Dead UI wrappers
`react-resizable-panels`, `embla-carousel-react`, `vaul` — all three were wired up in `src/components/ui/` shims but never imported anywhere in the application. Zero-risk deletion.

`zustand` was evaluated for replacement but kept: the settings store uses 3 slices with `useShallow`, subscribeWithSelector, and fine-grained re-render semantics that a `useReducer` Context replacement would have to replicate.

### Phase 3 — date-fns → native Intl + utils
Replaced all 13 import sites. Functions mapped to:
- `format` → `Intl.DateTimeFormat` + thin helpers in `dateUtils.ts`
- `parseISO` → `new Date(iso)` with NaN guard
- `differenceInDays` → `Math.floor((a - b) / 86_400_000)`
- `startOfMonth` / `endOfMonth` → `new Date(y, m, 1)` / `new Date(y, m+1, 0)`
- `addDays` / `subMonths` → immutable `new Date(...)` helpers

Locale-sensitive display formatting preserved via `Intl.DateTimeFormat` with explicit `nl-BE` / `en-US` options.

### Phase 4 — recharts → visx (consolidation)
recharts was used in 3 files alongside an already-present visx chart stack. Consolidated all charts on visx:
- `PerformancePage.tsx` — 2 multi-series area charts + sparkline
- `NetWorthChart.tsx` — single-series scrollable area chart with right Y-axis
- `TotalValueCard.tsx` — sparkline via `<Sparkline>` component

The existing visx `AreaChart` wrapper was extended with `fillOpacity`, explicit `width` bypass, `yAxisSide`, `referenceLines`, `xTickValues`, and `tooltipTitle` props to cover the recharts feature surface.

### Phase 5 — Backend middleware inlined
| Package | Replacement |
|---|---|
| `cors` | Custom ~25 LOC Express middleware: checks `Origin` header against `settings.api.corsOrigins` allowlist, sets `Access-Control-*` headers, handles OPTIONS preflight with 204 + `Max-Age: 600` |
| `compression` | Custom ~40 LOC Express middleware: intercepts `res.write`/`res.end`, creates `createGzip()` from `node:zlib`, compresses only for `Accept-Encoding: gzip` + compressible content types + responses ≥1 KB |

## Consequences

**Positive:**
- 9 packages removed; ~80–120 fewer transitive dependencies
- ~36 MB reduction from date-fns alone; recharts + 3 dead UI wrappers add further reduction
- Backend eliminates 2 runtime deps with zero external API surface
- Smaller attack surface; fewer packages to audit on npm security advisories

**Negative / trade-offs:**
- date-fns had battle-tested edge-case handling (DST, leap years, locale quirks). Native replacements cover our actual use cases but any future use of unusual date arithmetic must be verified.
- recharts gradient stroke (`url(#strokeNetWorth)` horizontal gradient) was simplified to solid colour — minor cosmetic regression in NetWorthChart.
- Inline CORS and compression are ~70 LOC of security-sensitive middleware that must be maintained. The cors package had 100M+ weekly downloads and thorough test coverage; our replacement covers the used feature surface only.

**Neutral:**
- `tailwindcss-animate`, `zustand`, `lucide-react`, `@radix-ui/*`, `react-query`, `react-router-dom`, `framer-motion`, `sonner`, `react-hook-form` + `zod`, `decimal.js`, `puppeteer`, `csv-parse`, `multer` explicitly kept.

## Related
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/D3 chart migration]]
- [[docs/adr/028-reaffirm-visx-over-recharts|ADR-028: Reaffirm visx over recharts]]
- [[docs/adr/index|All ADRs]]
