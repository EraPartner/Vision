---
title: "ADR-253: Switch to the Swift app on real data"
type: adr
status: proposed
date: 2026-10-26
tags: [adr, architecture, swift, native-app, switch-over, backup, keychain, demo, adr-205, adr-249]
description: "Proposed on 2026-10-26. Tor's real data moves to the standard Swift build (Vision Native) by restoring a verified Electron backup; no data directory is moved, Demo seeding is limited to the Demo build, the backup passphrase is entered again, the standard build shares Electron's iCloud backup folder, Electron stays an untouched fallback until the real-data checks pass, and only then are the TypeScript frontend and Electron archived off main."
aliases: [adr-253, swift switch-over, real data switch-over]
related_code:
  [
    "apps/native/Sources/VisionNativeCore/Runtime/RuntimeSupervisor.swift",
    "apps/native/Sources/VisionNativeCore/Runtime/NativeVariant.swift",
    "apps/native/Sources/VisionNativeCore/Runtime/NativeDemo.swift",
    "apps/native/Sources/VisionNativeCore/Backup/BackupBundle.swift",
    "packaging/electron/backup/bundle.ts",
    "install-native.sh",
  ]
---

# ADR-253: Switch to the Swift app on real data

## Status

Proposed on 2026-10-26. Follows [[docs/adr/249-revive-swift-app|ADR-249]] (phase 3 of its plan)
and takes over the switch-over runbook of [[docs/adr/205-vision-native-hand-over|ADR-205]], which
stays superseded and is not edited.

## Date

2026-10-26

## Context

On 2026-10-26 Tor decided to move to the Swift app once its smoothing phase merged (#365). The
TypeScript backend and PostgreSQL stay; only the frontend and app shell change.

Facts this builds on:

- The Swift app has two builds of one target. "Vision Native" (`com.vaultvoyager.vision-native`,
  runtime id `vision_native`, PostgreSQL 54331, `~/Library/Application Support/Vision Native/`)
  and "Vision Native Demo" (`vision_native_demo`, 54332). Electron Vision uses
  `~/Library/Application Support/Vision/native/vision/` (runtime id `vision`, 54329). The Swift
  runtime refuses any data directory but its own (`RuntimeLayout.assertVisionNativeDirectory`).
- Both Swift builds ran the synthetic Demo seeding on every launch. When the packaged seed
  changed (a new schema revision), the launch replaced the database with the seed. On a database
  holding real data that is data loss.
- The backup bundle (`.visionbak`, v2-encrypted `.visionbak.enc`) is shared. The Swift reader is
  tested against Electron 1.0.2 bytes and, since this ADR, against a bundle from the in-repo zip
  writer that replaced `archiver` in #349.
- ADR-205's audit steps no longer apply: the audit history was removed (#338).
- Keychain items trust the code signature of the app that wrote them, so the Swift app cannot
  read Electron's stored backup passphrase.

## Decision

1. **Demo seeding only in the Demo build.** `SupervisorConfiguration.seedsDemo` is true only for
   Vision Native Demo. The standard build runs the same interrupted-restore recovery and starts on
   its own database (an empty migrated one on first launch).
2. **Data moves by backup and restore, not by moving files.** The runbook, each step checked
   before the next:
   1. In Electron Vision, make an encrypted backup and confirm it is listed; quit Electron with
      "Keep services running" off.
   2. Build and install the standard build: `./install-native.sh --own` (`--demo` installs the Demo build; without either it asks).
   3. Launch Vision Native, set the backup passphrase (the same one) in Settings > Backup, and
      restore the Electron backup there.
   4. Run the real-data checks (decision 4).
3. **Electron stays a fallback, untouched.** No Swift build reads or writes Electron's data
   directory, Keychain items or `settings.json`, and none deletes Electron's backups (decision 6). Going back means quitting Vision
   Native and opening Electron Vision; data entered in the Swift app in between is carried back
   the same way (Swift backup, Electron restore).
4. **Real-data checks before any removal.** On Tor's database: totals on each screen equal
   Electron's for the same data; imports (IBKR, Saxo XLSX, funding workbooks) never double count;
   a backup made in each app restores in the other; tax figures per year equal Electron's.
5. **Archive after the checks pass.** Only then are `apps/frontend` and the Electron shell and
   packaging removed from `main`, kept on an archive tag and branch, in a separate ADR. The runtime
   payload preparation that `install-native.sh` uses from `packaging/electron` moves with the
   Swift app, not into the archive.

6. **One backup folder.** The standard build's default backup directory is Electron's
   `Vision/Backups` in iCloud Drive (Tor chose this on 2026-10-26; `NativeVariant.backupFolderName`).
   Retention removes only `vision_backup_<deviceId>_*` files, and the device id hashes the data
   directory, so neither app prunes the other's backups. The Demo build keeps
   `Vision Native Demo/Backups`.

## Consequences

### Positive

- No file conversion: the switch reuses the restore path both apps already test.
- A seed change can never overwrite real data.
- Electron remains a working fallback until Tor signs off.

### Negative

- Two apps are maintained until the archive step.
- The passphrase is entered again, by hand.

### Neutral

- The Swift app keeps its own bundle id, data directory, port and Keychain service names.

## Related

- [[docs/adr/249-revive-swift-app|ADR-249]]
- [[docs/adr/205-vision-native-hand-over|ADR-205]]
- [[docs/adr/242-backup-before-boot-migrations|ADR-242]]
- [[docs/adr/index|All ADRs]]
