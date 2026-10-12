---
title: "ADR-205: Vision Native phase 1 hand-over"
type: adr
status: accepted
date: 2026-10-12
tags:
  [
    adr,
    swift,
    macos,
    native-app,
    electron,
    phase-1,
    phase-4,
    switch-over,
    audit-log,
    keychain,
    backup,
    demo,
    adr-158,
    adr-204,
  ]
description: "Accepted on 2026-10-12. Records what phase 1 of Vision Native delivered (target and CI, runtime, shell, backup and restore, audit anchor, Demo variant, parity exit checklist, backup interop in CI), what the Demo-only rule of ADR-204 means until phase 4, the switch-over steps deferred to phase 4 (data directory, Keychain service names, iCloud backup folder, audit key and witness migration) and the product questions Tor must answer before the hand-over."
aliases: [adr-205, vision native hand-over, phase 1 hand-over]
---

# ADR-205: Vision Native phase 1 hand-over

## Status

Accepted on 2026-10-12 (proposed the same day). As before acceptance,
[[docs/adr/072-electron-native-desktop-integration|ADR-072]],
[[docs/adr/113-native-macos-runtime|ADR-113]] and
[[docs/adr/196-electron-shell-typescript|ADR-196]] stay in force for the Electron app, as
[[docs/adr/204-vision-native-swift-app-target|ADR-204]] says.

## Date

2026-10-12

## Context

ADR-204 lets phase 1 exit with "feature parity with Electron, backup round-trip tests pass both
ways, hand-over ADR". Phase 1 was delivered in five steps on `claude/swift-native-phase-1*`
branches:

| Step | Delivered                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a   | `apps/native/` target (XcodeGen, Swift 6, Swift Testing), the `native-macos` CI job on `macos-26`, `install-native.sh`                                                                                                       |
| 1b   | `RuntimeSupervisor` and `NativeRuntime`: own PostgreSQL 18 cluster and backend, payload verification, Demo seed activation, quit and keep-services                                                                           |
| 1c   | The `WKWebView` shell: preload bridge, navigation and download policy, menus, dock, badge, vibrancy, accent colour, launch and error state                                                                                   |
| 1d   | Backup and restore: the same `.visionbak` / `.visionbak.enc` bundles, Keychain passphrase, restore allow-list, quit-time backup                                                                                              |
| 1e   | The audit anchor and Keychain witness (all six `electronAudit` channels, restore continuity), the Demo variant, the [[docs/reference/native-parity/phase-1-exit\|phase 1 exit checklist]] and backup and audit interop in CI |

Facts this decision builds on:

- The exit checklist maps all 205 shell and settings action rows. 158 are hosted unchanged, 39
  have native code, 3 are cut by decision (the updater, a dev-only menu item, a non-macOS menu
  item), 3 are gaps (#148, inherited from Electron; #203 and #204, spelling items of the text
  context menu) and 2 are unsure (#67 and #205). Outside the action rows it counts 2 bridge gaps and 6 cross-cutting
  gaps, among them the backend health watchdog and OS notifications.
- CI writes a plain and a v2-encrypted bundle and an audit transfer with the Swift code on macOS,
  and a Linux job opens them with the Electron readers (`native-interop` in `ci.yml`). The Swift
  tests open the Electron Vision 1.0.2 bundle fixture and an audit receipt, key and transfer made
  by `audit-anchor.ts`.
- One app target builds two variants: "Vision Native" (`com.vaultvoyager.vision-native`, runtime id
  `vision_native`, PostgreSQL 54331) and "Vision Native Demo" (`com.vaultvoyager.vision-native-demo`,
  `vision_native_demo`, 54332). `install-native.sh` installs the Demo variant by default.
- Both variants seed and run the synthetic Demo dataset. Neither reads, locks or writes the
  `Vision` or `Vision Demo` data directories, Keychain items or iCloud folders.
- Electron Vision keeps its data in `~/Library/Application Support/Vision/native/vision/` (runtime
  id `vision`, database `vision`, PostgreSQL 54329). Its audit key is
  `audit-anchor/key.enc`, protected by Electron `safeStorage` (`v10`, the "Vision Safe Storage"
  login Keychain item), its receipt is `audit-anchor/checkpoint.json`, and its witness is the
  Keychain item `com.vaultvoyager.vision.audit-witness` / `latest-checkpoint`
  ([[docs/adr/158-macos-keychain-audit-witness|ADR-158]]). Its backup passphrase is
  `backupPassphraseEncrypted` in `settings.json`, also under `safeStorage`. Its default backup folder
  is `Vision/Backups` in iCloud Drive.

## Decision

Proposed:

1. **Phase 1 exits** when Tor has run the manual checks on a Mac
   (`apps/native/README.md`, "Manual checks on a Mac") and accepts the gaps of the exit checklist,
   or names the ones that must be fixed first. The gaps that remain move to phase 2 as tracked work.
2. **The Demo-only rule stays until phase 4.** Until the switch-over:
   - Both variants run on the synthetic Demo seed. The standard variant exists so that its identity
     (bundle id, data directory, Keychain service names, port) can be tested, not to hold real data.
   - No Vision Native build reads Electron Vision's data directory, Keychain items, `settings.json`
     or iCloud folder, and no tool copies real data into a Vision Native directory.
   - Electron Vision stays Tor's daily app and stays shippable. Shell fixes that matter for daily use
     land in Electron first; Vision Native follows.
3. **The switch-over is a phase 4 runbook, not code in phase 1.** It starts with a tripwire,
   before anything real reaches the standard variant's directory: while
   `DEMO_RESET_USER_DATA_NAMES` in `packaging/electron/runtime/native-demo.ts` includes
   `"Vision Native"` and `packaging/electron/scripts/native-demo-cli.ts` accepts
   `--target vision-native`, a Demo reset can wipe `~/Library/Application Support/Vision Native/`.
   After phase 4 that directory holds real data, so the switch-over change removes both (and their
   tests) first, and the runbook stops if either is still present. Its steps, in order, each one
   verified before the next:
   1. Make a verified encrypted backup in Electron Vision and an export of the audit history.
   2. Quit Electron Vision with "Keep services running" off, so its PostgreSQL cluster is stopped.
   3. Data: restore that backup into Vision Native (standard variant) through Settings > Backup.
      The bundle format is shared and tested both ways in CI, so no data directory is moved or
      renamed. The cluster, runtime id (`vision_native`), roles and port stay Vision Native's.
      Rejected: renaming `Vision/native/vision/` into place, because the runtime id, the role
      names and the database name differ and would need a database rename.
   4. Audit key: read Electron's `audit-anchor/key.enc` (`v10`) with the password of the
      "Vision Safe Storage" login Keychain item (its account name is to be confirmed on the Mac;
      the reader exists, `ElectronSafeStorage` in `AuditKeyProtection.swift`) and write
      it back as `vn1` under the Vision Native wrapping key
      (`com.vaultvoyager.vision-native.audit-key` / `audit-anchor-key`). Copy `checkpoint.json`
      unchanged; its HMAC does not depend on how the key is protected.
   5. Audit witness: copy the value of `com.vaultvoyager.vision.audit-witness` /
      `latest-checkpoint` to `com.vaultvoyager.vision-native.audit-witness` / `latest-checkpoint`
      unchanged. The witness binds the receipt hash, not the service name, so no re-signing is
      needed. Electron's item stays as it is, so a rollback to Electron still verifies.
      Alternative to steps 4 and 5: a protected audit transfer (`audit:transfer-export` in
      Electron, `audit:transfer-import` in Vision Native), which needs no Keychain access across
      apps. It carries the HMAC key and Electron's `checkpoint.json`; Vision Native writes the
      receipt byte for byte as Electron serialized it (it re-serializes in canonical field order,
      which is Electron's order), protects the key as its own `key.enc`
      (`vn1`) and creates its own witness, so only `key.enc` differs from Electron's files. The
      import is accepted only on the fresh first checkpoint of a new cluster
      ([[docs/adr/161-password-protected-audit-device-transfer|ADR-161]]), so in this variant it runs
      before the restore: export the transfer in step 1 right before the backup, with no change
      in between; then launch Vision Native (standard) for the first time, import the transfer,
      and only then restore the backup (step 3). `apps/native/README.md` manual check 12 rehearses
      this order on Demo data.
   6. Backup passphrase: enter it again in Vision Native (it is stored under
      `com.vaultvoyager.vision-native.backup-passphrase`). Electron's `safeStorage` value is not
      migrated.
   7. Backup folder: decide between keeping `Vision Native/Backups` (separate retention, old
      Electron backups stay untouched) and pointing the backup directory at `Vision/Backups`. The
      device id includes the data directory path, so Vision Native never prunes Electron's
      backups in either case.
   8. Run the audit history check on the Admin overview and the backup round trip on real data,
      then retire Electron Vision in a separate ADR (ADR-204 decision 11, phase 4).
4. **Electron's Demo app** keeps `bun run demo:reset-native`; Vision Native Demo is reset with
   `bun run demo:reset-vision-native`, which writes the same `demo-reset-request.json` into
   `~/Library/Application Support/Vision Native Demo/`.

### Open product questions for Tor

1. Accept the 11 gaps of the exit checklist for phase 2, or fix some first? The candidates are
   the health watchdog, OS notifications and the spelling context menu.
2. Should the standard variant ("Vision Native") keep seeding the Demo dataset until phase 4, or
   refuse to start without a Demo marker?
3. Backup folder after the switch-over: `Vision Native/Backups` or `Vision/Backups` in iCloud
   Drive?
4. Audit migration: copy the witness item and re-protect the key (step 3.4 and 3.5), or a
   protected audit transfer?
5. Bundle identifier after the switch-over: keep `com.vaultvoyager.vision-native` or take over
   `com.vaultvoyager.vision`? Keychain items trust the code signature of the app that made them,
   so taking over the identifier alone does not give Vision Native access to Electron's items.
6. Audit notices are a sheet on the window plus a log entry; Electron posts an OS notification.
   Is the sheet acceptable, or are notifications wanted in phase 2?
7. A Demo reset on an enrolled Demo replaces the audit history under the anchor, so the next read
   reports verification failed, as in Electron Vision Demo. Should the reset also remove the Demo
   anchor and witness?
8. Default variant: a plain Xcode or CI build is "Vision Native" (standard), `install-native.sh`
   builds "Vision Native Demo". Keep this split?
9. Name of the reset script: `demo:reset-vision-native` beside the Electron `demo:reset-native`, or
   rename both?

## Consequences

### Positive

- The hand-over is checkable: one page lists every action row with its Swift symbol or reason,
  and CI proves the backup and audit formats in both directions on every native change.
- The switch-over needs no file conversion of the database: it reuses the restore path that is
  tested in CI.
- Electron stays a working fallback during and after the switch-over, because nothing of its data
  or Keychain items is changed.

### Negative

- Until phase 4, two apps are maintained. Shell fixes may be needed twice.
- The switch-over has manual steps (Keychain copy, passphrase re-entry, backup folder choice) that
  need a runbook and Tor's Mac.
- The phase 1 gaps (health watchdog, OS notifications, renderer-ready watchdog, security headers,
  zoom persistence, traffic-light position) stay until phase 2 unless Tor decides otherwise.

### Neutral

- The audit receipt format, HMAC and transfer envelope are Electron's, so either app can verify
  the other's receipts with the key.
- ADR-072, ADR-113 and ADR-196 stay in force for the Electron app until this ADR is accepted.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204]]
- [[docs/adr/158-macos-keychain-audit-witness|ADR-158]]
- [[docs/reference/native-parity/phase-1-exit|Native parity: phase 1 exit checklist]]
- [[docs/architecture/native-app|Vision Native App Architecture]]
- [[docs/adr/index|All ADRs]]
