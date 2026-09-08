---
title: Application Updates
type: feature
status: active
date: 2026-09-08
tags: [feature, updates, electron, native-runtime, backup, checksum, release]
description: Native packaged and source-launcher update paths with backup, checksum verification, and rollback boundaries.
aliases: [update system, application updater]
related_code:
  [
    "packaging/electron/updater.js",
    "packaging/electron/main.js",
    ".github/workflows/release.yml",
  ]
---

# Application Updates

Vision exposes update information from `/api/admin/update/check`. Electron selects one of two
install paths:

| Mode             | Use                        | Installer                                                    |
| ---------------- | -------------------------- | ------------------------------------------------------------ |
| `native`         | Packaged macOS application | Verified release ZIP/app replacement                         |
| `source` / `dev` | Source checkout            | Generated source-launcher bundle or operator-managed restart |

Browser deployments receive release information but no in-app installer. The operator updates the
source deployment and database in its own maintenance window.

## Backup before update

The Electron main process creates a native backup before it replaces application files. A failed
backup blocks installation. The updater pauses the runtime watchdog, stops the native backend and
database in order, performs the install, and keeps rollback state until the updated app opens.

Backup and restore use the same native transport as manual `.visionbak` operations. An in-progress
database switch blocks update work.

## Packaged native update

The updater:

1. fetches release metadata from the configured GitHub release source;
2. selects the macOS artifact for the running architecture;
3. downloads the artifact and checksum;
4. verifies the SHA-256 digest before extraction;
5. creates a backup and stops the native runtime;
6. stages and installs the replacement; and
7. restarts Vision and retains recovery state until startup succeeds.

Paths are validated before extraction or replacement. A checksum mismatch, unsupported platform,
or failed backup stops the operation without activating the staged application.

## Source update

Source mode downloads the generated source-launcher bundle and checksum from the release. The
launcher validates the target checkout and performs the repository-specific update outside the
running Electron process. Development mode reports update availability without treating a working
tree as a packaged application.

## Renderer behavior

`UpdateNotification` displays availability, download, install, success, and failure states. It calls
the Electron updater bridge only when that bridge exists. Web clients display operator guidance
instead of an install control.

The Electron inter-process communication surface includes mode lookup, update check, native/source
installation, progress, and restart events. It does not expose an image-pull operation.

## Release pipeline

`.github/workflows/release.yml` verifies code and generated artifacts, runs native runtime checks,
builds the macOS app and disk image plus source-launcher bundle, computes checksums, attests the
artifacts, and creates the GitHub release. No application image is built or published.

## Rollback boundaries

Application rollback and database rollback are separate. Replacing the app does not downgrade the
database. Alembic downgrades require explicit review and a backup. A failed native database switch
keeps the previous database until validation succeeds.

## Security properties

- Release downloads use HTTPS and are pinned by an expected checksum.
- Archive extraction rejects traversal and unsupported entries.
- Installation is gated on a successful backup.
- The renderer cannot pass arbitrary commands to the main process.
- Secrets and database credentials are not included in release metadata or logs.

## Related

- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]]
