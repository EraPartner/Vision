---
title: "ADR-254: Stop the Swift port and remove it from main"
type: adr
status: accepted
date: 2026-10-26
tags:
  [
    adr,
    architecture,
    swift,
    native-app,
    electron,
    typescript,
    retirement,
    adr-214,
    adr-249,
  ]
description: "Accepted on 2026-10-26 by Tor. The revived Swift app (ADR-249, ADR-250, ADR-252) is stopped and removed from main with its generators, lint, build workflow, install script, measurement mode and documentation. Electron with the React/TypeScript frontend and TypeScript backend stays the only desktop app. The code stays in Git history at 7334283. The Apple Foundation Models helper (ADR-246) and the exhaustive API enum checks (ADR-251) stay."
aliases: [adr-254, remove swift app, stop swift port]
related_code:
  [
    "scripts/ci-classify.ts",
    "scripts/mac-baseline.ts",
    "packaging/electron/apple-ai/main.swift",
  ]
---

# ADR-254: Stop the Swift port and remove it from main

## Status

Accepted on 2026-10-26 by Tor. It supersedes
[[docs/adr/249-revive-swift-app|ADR-249]],
[[docs/adr/250-swift-design-system-parity|ADR-250]] and
[[docs/adr/252-swift-type-strictness|ADR-252]]. The retirement in
[[docs/adr/214-retire-vision-native-swift-port|ADR-214]] applies again.

## Date

2026-10-26

## Context

ADR-249 revived the Swift app on 2026-10-25 and PRs #360, #361, #362, #364 and #365 brought it
through phases 1, 2a, 2b and the smoothing phase. The phase 3 real-data PR (#367) was still a
draft. On 2026-10-26 Tor decided:

> "we're stopping the swift port" ... "I am sticking with electron" ... "close it, archive the
> swift port until there is no trace and make sure we're back to perfect typescript/electron with
> no trace of swift" ... "close it, and it shouldn't be in main"

## Decision

Stop the Swift port. #367 is closed unmerged. Everything the revival added outside the frontend
is removed from `main`:

- The Swift app `apps/native/` and `install-native.sh`.
- The Swift generators, lint and their tests: `scripts/native-{design-tokens,fixtures,lint,navigation,openapi,strings}.ts`,
  `scripts/lib/nativeCodegen.ts`, `scripts/native-tests/` and the `native:generate*` and
  `native:test-generators` package scripts.
- The Swift build: `.github/workflows/swift-build.yml`, the `apps/native/` skip in
  `scripts/ci-classify.ts` and its test, the Swift lint step in `.githooks/pre-commit` and the
  `apps/native/` entries in `.gitignore`.
- The Swift measurement mode of the Mac baseline: `scripts/lib/mac-baseline/native.ts`,
  `scripts/tests/mac-baseline-native.test.ts`, the `--native`, `--compare` and profiling options
  of `scripts/mac-baseline.ts` and the `sample` binary allowance in `config/knip.json`.
  `scripts/mac-baseline.ts` and `docs/performance/mac-baseline.md` are back to their state before
  ADR-249.
- The Swift-only documentation: the native app architecture page, the native parity inventory
  under `docs/reference/native-parity/` and the Swift section of the appearance page.

The code is not archived on a branch or tag. Git history keeps it: `7334283` is the last `main`
commit with the full Swift app, `d9b0836` the state that ADR-214 retired, and #367's unmerged
branch head is `9866212`.

Kept:

- `vision-apple-ai` (`packaging/electron/apple-ai/main.swift`,
  [[docs/adr/246-apple-foundation-models-helper|ADR-246]]). It is a Swift helper of the Electron
  app, not part of the port.
- [[docs/adr/251-exhaustive-api-enums-in-typescript|ADR-251]]: the contract-guard enum checks and
  frontend switch exhaustiveness are TypeScript and stay.
- The Electron native runtime (bundled PostgreSQL 18, `VISION_NATIVE_*` variables,
  `native:smoke`, `demo:reset-native`, Vision Demo), as in ADR-214. "Native" there means the
  Electron app's bundled runtime.

## Consequences

- One desktop app again; CI and the pre-commit hook no longer know about Swift.
- The superseded ADRs stay as history. Their links to the removed documentation pages are kept
  as plain text.
- Restarting a Swift or other native rewrite needs a new ADR accepted by Tor. The code can be
  restored from `7334283` with `git checkout 7334283 -- apps/native ...`.

## Related

- [[docs/adr/214-retire-vision-native-swift-port|ADR-214: Retire the Vision Native Swift port]]
- [[docs/adr/249-revive-swift-app|ADR-249: Revive the Swift app (superseded)]]
- [[docs/architecture/electron|Electron architecture]]
- [[docs/adr/index|All ADRs]]
