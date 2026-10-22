---
title: "ADR-245: Dependency supply-chain hardening and in-repo replacements"
type: adr
status: accepted
date: 2026-10-22
tags: [adr, dependencies, supply-chain, security, bun, electron, xlsx, backup]
description: "Accepted on 2026-10-22. Installs wait 7 days for new releases, run no dependency lifecycle scripts and use the frozen lockfile; risky runtime packages are pinned exactly. Eighteen direct dependencies go (108 to 90): two were unused, the rest are replaced by in-repo code proven equal to the package by differential or before/after tests: commitlint, concurrently, supertest, recharts (AI chat), clsx, cva, zustand, @visx/gradient, tailwindcss-animate, @fontsource, d3-sankey, archiver and read-excel-file."
aliases: [adr-245, supply chain, dependency hardening, own xlsx reader, zip writer]
related_code:
  [
    "bunfig.toml",
    "packaging/electron/bunfig.toml",
    "scripts/check-workflow-supply-chain.ts",
    "scripts/commitlint.ts",
    "scripts/run-parallel.ts",
    "apps/node-backend/tests/helpers/httpAgent.ts",
    "apps/frontend/src/lib/classNames.ts",
    "apps/frontend/src/stores/createStore.ts",
    "apps/frontend/src/features/statistics/sankeyLayout.ts",
    "packaging/electron/backup/zip-writer.ts",
    "packages/shared-utils/src/xlsx/workbook.ts",
  ]
---

# ADR-245: Dependency supply-chain hardening and in-repo replacements

## Status

Accepted on 2026-10-22. Supersedes the archiver statement in
[[docs/performance/index|the performance notes]] (backups are now written by
`packaging/electron/backup/zip-writer.ts`).

## Date

2026-10-22

## Context

The dependency review of 2026-10-22 counted 108 direct dependencies, 990 packages in the root
lockfile and 320 in the desktop lockfile. Several were small, single-maintainer or unattested
packages with full access to Tor's financial data or to the backup file. Tor asked for the
hardening steps and every replacement candidate except the Yahoo Finance client.

## Decision

### Install hardening

- `bunfig.toml` (root and `packaging/electron`) sets `minimumReleaseAge` to 7 days. An urgent
  security fix younger than that is installed with `bun install --minimum-release-age=0` on
  purpose, and the PR says so.
- `trustedDependencies = []`: no dependency lifecycle script runs on install.
- The cloud SessionStart hook and the docs install with `--frozen-lockfile`.
- Single-maintainer or unattested runtime packages are pinned exactly; the `qs` and `ws`
  overrides use caret ranges so security patches still apply.
- `scripts/check-workflow-supply-chain.ts` fails on lockfile entries that resolve outside the
  npm registry or the pinned SheetJS tarball.

### In-repo replacements

Each replacement was compared with the package before the package was removed.

| Package | Replacement | Evidence |
| --- | --- | --- |
| @commitlint/cli + config | `scripts/commitlint.ts` | Same verdict on all 2,183 history commits and 28 edge cases |
| concurrently | `scripts/run-parallel.ts` | `lint` and `test:all` run unchanged |
| supertest | `apps/node-backend/tests/helpers/httpAgent.ts` | Full backend suite identical before and after (68 route-harness suites) |
| recharts (AI chat) | visx chart primitives in `ToolResultChart` | Pie contract keeps the recorded sectors |
| clsx, class-variance-authority | `apps/frontend/src/lib/classNames.ts` | 400k random differential cases equal |
| zustand | `apps/frontend/src/stores/createStore.ts` | Store tests; same API |
| @visx/gradient | inline SVG gradient in `AreaChart` | Same SVG |
| tailwindcss-animate | `tailwindAnimate.ts` | Built CSS byte-identical |
| @fontsource packages | vendored WOFF2 files with OFL licences | Same hashed asset names and preloads |
| d3-sankey | `apps/frontend/src/features/statistics/sankeyLayout.ts` (BSD-3 port) | 300k graphs, every coordinate and path equal with `Object.is` |
| archiver | `packaging/electron/backup/zip-writer.ts` | Same entries, flags, modes and contents as archiver 8; ZIP64; 4.6 GB entry verified with `unzip -t` and yauzl; slightly faster |
| read-excel-file | `packages/shared-utils/src/xlsx/` | Differential test on random, corrupted, Saxo-shaped and SheetJS-written workbooks; pinned-output tests stay |

@vitest/ui and autoprefixer were unused and removed. The backup format and restore path
(yauzl) are unchanged, so every existing `.visionbak` still opens. SheetJS stays: it is the only
reader for IBKR binary `.xls` files.

### XLSX reader deviation

read-excel-file returned a sheet with `data: undefined` when the workbook listed a sheet without
a worksheet part, which then crashed the caller. The in-repo reader throws a clear error instead.
Every other input gives the same rows, types and errors as read-excel-file 9.3.12.

## Consequences

- 108 to 90 direct dependencies, 990 to 830 root lockfile entries and 320 to 286 desktop
  lockfile entries.
- New releases reach the app one week later unless a fix is installed on purpose.
- The replaced code is ours to maintain. Its tests pin the package's former output, so a change
  in behaviour shows up as a test failure.
