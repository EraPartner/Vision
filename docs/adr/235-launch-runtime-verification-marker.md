---
title: "ADR-235: Hash the native runtime payload once per installed version"
type: adr
status: accepted
date: 2026-10-20
tags: [adr, electron, native-runtime, packaging, startup, performance, integrity]
description: "The native runtime payload is SHA-256 verified in full on the first launch of each installed payload (manifest digest, which covers the app version) and recorded in a marker in the application data directory. Later launches with the same manifest only check that exactly the listed regular files exist with their recorded sizes; any mismatch falls back to the full hash. A boot mark names the mode and its cost."
aliases: [adr-235, runtime verification marker, launch manifest cache]
related_code:
  [
    "packaging/electron/runtime/runtime-manifest.ts",
    "packaging/electron/runtime/native.ts",
    "packaging/electron/main.ts",
  ]
---

# ADR-235: Hash the native runtime payload once per installed version

## Status

Accepted.

## Date

2026-10-20

## Context

`discover()` in the native runtime called `verifyRuntimeManifest` on every launch, before
PostgreSQL starts. That reads and SHA-256 hashes every file in the packaged payload (PostgreSQL,
the compiled backend, the frontend and migrations) in a worker thread, so every cold start paid for
reading the whole payload from disk. The payload only changes when the application is replaced,
and the application bundle is code-signed. Packaging still runs the full check at build time
(`finalize-native-package.ts`).

## Decision

- `verifyRuntimeManifestOnLaunch` reads `manifest.json` and computes its SHA-256. The manifest
  lists every file's path, size and hash and the app version, so its digest identifies one
  installed payload.
- With no matching marker it runs the existing full verification (every hash, sizes, no missing,
  extra, symlinked or special files). On success it writes
  `<userData>/native/<runtimeId>/runtime-verification.json` (mode `0600`) with the manifest
  digest, app version, resolved payload path, entry count and time. The marker stays inside the
  application data directory, never in the bundle. Failing to write it does not block startup.
- When the marker matches the manifest digest, the app version and the payload path, the launch
  only checks that exactly the listed files exist as regular files with their recorded byte
  sizes, and that no extra, symlinked or special entries exist. If that check fails for any
  reason, the launch falls back to the full hash verification, which then rejects a corrupt
  payload as before (`NATIVE_RUNTIME_CORRUPT`).
- An update, reinstall, moved payload or changed manifest therefore re-hashes once. A missing
  manifest in a packaged app still fails closed; development checkouts without a manifest skip
  verification as before.
- The native runtime reports the verification as a boot phase, `runtime_manifest_full` or
  `runtime_manifest_cached`, through the existing `[startup]` boot trace and launch summary.

## Consequences

- Later launches avoid reading the whole payload. The saving was not measured here; the boot
  phases make it visible on the Mac.
- Between full checks, a same-size in-place modification of a payload file is not detected by
  the launch check. That requires write access to the signed application bundle, whose code
  signature remains the primary integrity control; any size, file-set or manifest change still
  triggers a full check. Deleting the marker forces a full check on the next launch.
- The build-time and smoke-test full verification (`verifyRuntimeManifest`) is unchanged.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/adr/234-electron-report-pdf-printing|ADR-234]] — removed the Chromium payload from the same manifest
