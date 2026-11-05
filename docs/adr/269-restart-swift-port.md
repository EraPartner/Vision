---
title: "ADR-269: Restart the Swift port, frontend first, compiled in CI"
type: adr
status: accepted
date: 2026-11-05
tags:
  [
    adr,
    architecture,
    swift,
    swiftui,
    native-app,
    parity,
    electron,
    ci,
    adr-249,
    adr-254,
  ]
description: "Accepted on 2026-11-05 by Tor. Supersedes ADR-254. The Swift app is restored under apps/native/ from 7334283 and brought, phase by phase, to complete functional, visual and behavioural parity with the current React/TypeScript frontend, with the Electron app's optimisations ported to Swift. The Swift app is a frontend and shell over the TypeScript backend until that parity is reached; a native backend comes after, with its own ADR. Electron stays the product. Swift is compiled and tested by a path-gated macOS job in the main CI workflow."
aliases: [adr-269, restart swift port, swift port restart]
related_code:
  [
    "apps/native/",
    "scripts/native-openapi.ts",
    "scripts/native-design-tokens.ts",
    "scripts/native-strings.ts",
    "scripts/native-navigation.ts",
    "scripts/native-fixtures.ts",
    "scripts/native-lint.ts",
    "scripts/ci-classify.ts",
    ".github/workflows/ci.yml",
  ]
---

# ADR-269: Restart the Swift port, frontend first, compiled in CI

## Status

Accepted on 2026-11-05 by Tor. It supersedes
[[docs/adr/254-remove-swift-app|ADR-254]]. The rules of
[[docs/adr/249-revive-swift-app|ADR-249]] (parity, nothing cut, Electron stays the product until a
switch-over ADR), [[docs/adr/250-swift-design-system-parity|ADR-250]] (design-system parity) and
[[docs/adr/252-swift-type-strictness|ADR-252]] (Swift typed as strictly as the TypeScript app)
apply again, except where this ADR changes them.

## Date

2026-11-05

## Context

ADR-254 stopped the Swift port on 2026-10-26 and removed it from `main`; the last commit with the
full app is `7334283`. Since then the TypeScript app changed: SQLite replaced PostgreSQL
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]), Vision 2.0 compatibility was retired
([[docs/adr/265-retire-vision-2-compatibility|ADR-265]]), Insights opens on All time (ADR-266),
holdings can be classified by hand (ADR-267), budget imports detect their bank format (ADR-268),
the live tax year follows the calendar, and the Mac optimisation phases (ADR-255 to ADR-261)
landed in the React frontend. On 2026-11-05 Tor decided:

> "I want to continue the SwiftUI port. It should start by bringing swift up to date and working
> in a structured manner until we've got a functional, visual, behavioral, ... identical app with
> the same optimisations done (but then ported to swift of course). You should start with
> bringing the old swift port to the current typescript frontend port and then go from there.
> compile everything in the CI"

> "you should independently keep iterating until all optimisations are ported and there is
> complete functional/visual/behavioral parity for the frontend. backend is after"

## Decision

1. Restore `apps/native/`, its generators and their tests (`scripts/native-*.ts`,
   `scripts/lib/nativeCodegen.ts`, `scripts/native-tests/`), `install-native.sh` and the native
   app architecture page from `7334283`.
2. Bring the Swift frontend, in phases with one pull request each, to complete functional, visual
   and behavioural parity with the current React/TypeScript frontend, and port the Electron app's
   optimisations to Swift equivalents. Nothing is cut from either app.
3. Until that parity is reached, the Swift app is a frontend and app shell over the same
   TypeScript backend and `openapi.yaml` that Electron uses (now Bun with SQLite, ADR-263). A
   native Swift backend comes after frontend parity and needs its own ADR; until then the Swift backend of
   [[docs/adr/213-vision-native-swift-backend|ADR-213]] stays out of scope.
4. Electron stays the product. A switch-over (data directory, Keychain, backup folder) gets its
   own ADR with a verified backup first, per the packaging persistence rules.
5. CI compiles everything: the `swift` job in `.github/workflows/ci.yml` builds the app on
   `macos-26`, runs the Swift package tests and the generator tests. It runs only when the diff
   touches `apps/native/`, `scripts/native-*` or `scripts/lib/nativeCodegen.ts`
   (`scripts/ci-classify.ts`), in parallel with the TypeScript tiers, and `CI Complete` requires
   it whenever it runs. Diffs under `apps/native/` alone skip the TypeScript tiers. The manual
   `swift-build.yml` workflow and its `[swift-build]` commit marker of ADR-249 are not restored.

## Consequences

- Diffs that do not touch Swift paths pay no CI time for this. A Swift diff runs one macOS job of
  about 13 to 15 minutes (the old `swift-build` runs on 2026-10-26), in parallel with the other
  jobs.
- Every frontend feature change lands in both frontends until the switch-over.
- Changes to `openapi.yaml` or the web design tokens do not trigger the Swift job by themselves;
  the generated Swift sources are regenerated and checked in the Swift phase that adopts them.
- Plan and progress live in Tor's vault under `projects/vision`.

## Related

- [[docs/adr/254-remove-swift-app|ADR-254: Stop the Swift port (superseded)]]
- [[docs/adr/249-revive-swift-app|ADR-249: Revive the Swift app]]
- [[docs/architecture/native-app|Native app architecture]]
- [[docs/adr/index|All ADRs]]
