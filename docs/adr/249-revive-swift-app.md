---
title: "ADR-249: Revive the Swift app and bring it to full parity"
type: adr
status: accepted
date: 2026-10-25
tags: [adr, architecture, swift, swiftui, native-app, parity, electron, adr-214]
description: "Accepted on 2026-10-25 by Tor. The retired Vision Native Swift app is restored under apps/native/ from d9b0836, caught up to today's TypeScript app and brought to full visual and functional parity. The TypeScript backend and PostgreSQL stay; Electron stays the product until a switch-over is decided. Swift builds run only in a manual macOS workflow, never in PR CI."
aliases: [adr-249, revive swift app, swift parity]
related_code:
  [
    "apps/native/",
    "scripts/native-openapi.ts",
    "scripts/native-design-tokens.ts",
    "scripts/native-strings.ts",
    "scripts/native-navigation.ts",
    ".github/workflows/swift-build.yml",
    "scripts/ci-classify.ts",
  ]
---

# ADR-249: Revive the Swift app and bring it to full parity

## Status

Accepted on 2026-10-25 by Tor. Supersedes the retirement in
[[docs/adr/214-retire-vision-native-swift-port|ADR-214]]. ADR-213 (Swift backend) stays rejected.

## Date

2026-10-25

## Context

ADR-214 retired the Swift port on 2026-10-19 and required a new ADR from Tor before restarting
it. After the shared Mac optimisation phases A to C, Tor decided (2026-10-25):

> "I want the old port to be caught up to the current typescript port and then i want visual and
> functional parity." "I want full visual parity, in terms of design tokens and all other
> things. I want full functional parity too ... I want a swift app now."

At its last commit (`d9b0836`) the port had SwiftUI versions of all 40 routes and all 154
dialogs, sheets, popovers and menus, but it ran only in the Debug Demo on synthetic data, and its
dialogs and some controls used stock macOS presentation instead of Vision's.

## Decision

1. Restore `apps/native/`, its generators (`scripts/native-*.ts`, `scripts/lib/nativeCodegen.ts`),
   `install-native.sh` and the parity inventory (`docs/reference/native-parity/`) from `d9b0836`,
   and regenerate the API client, design tokens, String Catalog and navigation from today's
   sources.
2. Catch the app up to today's TypeScript app, then bring it to full visual parity (every design
   token, glass, blur, hover, motion, centred glass dialogs instead of macOS sheets and alerts)
   and full functional parity. Nothing is cut from either app.
3. The Swift app stays a frontend and app shell over the same TypeScript backend, `openapi.yaml`
   and PostgreSQL. ADR-213 stays rejected.
4. Electron stays the product until the Swift app passes real-data checks and Tor decides a
   switch-over. The switch-over (data directory, Keychain, backup folder) gets its own ADR with a
   verified backup first, per the packaging persistence rules.
5. Swift is compiled only by `.github/workflows/swift-build.yml`, which runs on
   `workflow_dispatch` alone. Changes under `apps/native/` skip the application CI, as `docs/`
   does. The generator tests run with `bun run native:test-generators`, outside CI.

## Consequences

- Every feature change lands in both frontends until Electron is retired.
- Compile errors are found only when the manual workflow runs, so Swift branches are built before
  they merge.
- Visual parity needs side-by-side review rounds on Tor's Mac.
- Plan and progress: `projects/vision/queries/2026-10-25-swift-port-parity-plan.md` in Tor's vault.

## Related

- [[docs/adr/214-retire-vision-native-swift-port|ADR-214]]
- [[docs/adr/204-vision-native-swift-app-target|ADR-204]]
- [[docs/adr/205-vision-native-hand-over|ADR-205]]
- [[docs/adr/index|All ADRs]]
