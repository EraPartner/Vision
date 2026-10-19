---
title: "ADR-196: The Electron shell is strict TypeScript compiled into out/"
type: adr
status: accepted
date: 2026-10-11
updated: 2026-10-19
tags: [adr, type-safety, typescript, electron, packaging, adr-195]
description: "Phase 5b of the type-safety plan. Every Electron main-process, preload, runtime, backup, updater and packaging-script module is strict TypeScript. tsc compiles it to CommonJS in packaging/electron/out/, which Electron, electron-builder and node --test run; every launch, test and packaging path builds first. Non-compiled resources are located from paths.ts appRoot."
aliases: [adr-196, electron typescript, type-safety phase 5b]
---

# ADR-196: The Electron shell is strict TypeScript compiled into out/

## Status

> [!warning] Partially superseded
> [[docs/adr/217-retire-source-launcher-update-channel|ADR-217]] retired the source-launcher
> update channel on 2026-10-19. The source launcher is no longer a
> build entry point; the TypeScript shell decisions remain active.

Accepted. The owner chose compiling into `out/` on 2026-10-11; the Demo build still needs one
check on macOS before release. Phase 5b of the type-safety plan; follows
[[docs/adr/195-repository-scripts-typescript|ADR-195]] (repository scripts). The alternatives were
JavaScript checked through JSDoc types (no build step) and leaving the shell as JavaScript.

## Date

2026-10-11

## Context

About 22,000 lines of the Electron shell (`packaging/electron/`) were plain CommonJS JavaScript:
the main process, the sandboxed preload, the native runtime, backup and audit modules, the updater
and the packaging scripts, with their tests. Unlike the repository scripts, these files cannot run
as `.ts` directly: the sandboxed preload may only `require("electron")`, electron-builder packages
plain JavaScript, the self-contained update installer is copied out and run on its own, and the
release job builds with Node.

## Decision

- Sources are TypeScript with ESM syntax. `tsc` emits CommonJS into `packaging/electron/out/`,
  mirroring the source layout (`out/main.js`, `out/runtime/native.js`, `out/scripts/...`).
  `packaging/electron/build.ts` (run with Bun) wipes `out/` and compiles two projects:
  `tsconfig.json` (main process, runtime, backup, scripts, tests) and `tsconfig.preload.json`
  (the preload, with DOM types). Both share `tsconfig.base.json`: `strict`,
  `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `module`/`moduleResolution` `nodenext`,
  `noEmitOnError`. Relative imports are extensionless.
- `out/` is git-ignored. Every path that runs the shell builds first: the Electron package
  scripts (`start`, `prepare:*`, `dist*`), the root `dev`, `electron:dev`, `electron:prod`,
  `native:*` and `demo:reset-native` scripts, `install.sh`, `install-demo.sh`, the release job and
  the source launcher (through `electron:prod` and `native:prepare`).
- `package.json` `main` is `out/main.js`. electron-builder packages `out/**/*` and `assets/**/*`,
  excluding compiled tests, scripts, the demo generator and the build stamp. The Demo `afterPack`
  hook is `out/scripts/finalize-native-package.js`.
- Compiled code runs one level below the package root, so `paths.ts` exports `appRoot`
  (`packaging/electron` in a checkout, the `app.asar` root when packaged). Everything that is not
  compiled (`package.json`, `assets/`, `i18n/`, `native-runtime/`, `resources/`, the repository
  root) is located from `appRoot`. Compiled siblings (the preload, the update installer, spawned
  scripts) stay relative to `__dirname`. A contract test fails if a resource lookup returns to
  `__dirname`.
- Tests keep `node:test` and run from `out/` (`bun run test:electron` builds, then runs
  `node --test 'packaging/electron/out/**/*.test.js'`). Backend tests that load Electron modules
  read them from `out/`; the backend Vitest global setup builds the shell when a source is newer
  than the last build.
- Contract tests assert that the compiled preload requires only `electron` and that the compiled
  update installer requires only Node built-ins and runs from an empty directory.
- `archiver` and `yauzl` get minimal local type declarations in `packaging/electron/types/`
  instead of new dependencies. `assets/error.js` (a renderer script loaded by `error.html`) stays
  JavaScript.
- `bun run typecheck:electron` checks both projects; the "Type Check (Backend)" CI job runs it.

## Consequences

- The shell's types are checked in CI, including the IPC contract types in `electron-api.d.ts`
  (`RestoreResult` gains the `auditStatus` field the main process already returned).
- Launching from a checkout needs Bun and the root dependencies (TypeScript) to build `out/`.
  The build takes a few seconds.
- Security settings, IPC channels and validation, the backup format, keychain and audit-anchor
  strings, native runtime identifiers, paths and grants, the generated updater script and the Demo
  seed SQL are unchanged. Malformed input that used to fail with a `TypeError` now fails with a
  named error, and three validation gaps found during the conversion are fixed with regression
  tests.
- The packaged app layout changes (code moves under `out/` inside `app.asar`), so the Demo build,
  a release build and the in-app updater need one check on macOS.
- ADRs that cite `.js` paths in `packaging/electron/` (for example ADR-113, ADR-114, ADR-142 and
  ADR-171) are historical; the same modules now have `.ts` sources.

## Related

- [[docs/architecture/electron|Electron Architecture]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/adr/195-repository-scripts-typescript|ADR-195]]
- [[docs/adr/index|All ADRs]]
