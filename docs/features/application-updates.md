---
title: Application Updates
type: feature
status: active
date: 2026-08-30
updated: 2026-08-30
tags:
  [
    feature,
    updates,
    electron,
    deployment,
    native-runtime,
    docker,
    source-update,
    backup,
    rollback,
    checksums,
    supply-chain-security,
  ]
description: Native, development, source, and optional Docker update paths with provider-aware backup, verified artifacts, and rollback
aliases: [auto-update, update flow, native update, update lifecycle]
related_code:
  - packaging/electron/updater.js
  - packaging/electron/native-update-installer.js
  - packaging/electron/main.js
  - packaging/electron/preload.js
  - apps/frontend/src/lib/api/electron.ts
  - apps/frontend/src/components/notifications/UpdateNotification.tsx
  - apps/frontend/src/features/settings/sections/AboutSection.tsx
  - .github/workflows/release.yml
---

# Application Updates

## Overview

The selected runtime provider and package shape determine the update path:

| Mode     | Environment                                        | Update method                                       |
| -------- | -------------------------------------------------- | --------------------------------------------------- |
| `native` | Packaged macOS app with native provider            | Verified application ZIP and atomic app replacement |
| `dev`    | Unpackaged local Electron/source development       | Source checkout; no in-app installer                |
| `source` | Packaged shell using an explicitly linked checkout | Verified source-launcher ZIP and guarded helper     |
| `docker` | Explicit Electron Docker provider                  | Compose image pull and provider restart             |
| browser  | Non-Electron Docker/server deployment              | Operator-managed command-line update                |

Normal packaged macOS updates do not pull a Docker image. The PostgreSQL cluster, attachments,
runtime marker, and logs live outside `Vision.app` and are not replaced with the application.

## Mode resolution

Electron resolves the durable runtime marker before it configures the updater. An activated marker
is authoritative, so an environment variable cannot make later launches alternate between native
and Docker databases. An in-progress cutover blocks startup and update work.

`packaging/electron/updater.js` returns:

- `dev` for an unpackaged Electron process;
- `native` when the active provider is native;
- `source` for the explicit repository-backed packaged mode; and
- `docker` only for the explicit Compose provider.

The browser API reports `docker-compose`; it offers release information but no in-app installer.

## Backup before update

Every installable Electron update first calls `update:pre-update-backup`. This creates a normal
`.visionbak` through the active provider transport. The bundle contains:

- a PostgreSQL logical dump;
- attachment files;
- schema and bundle metadata;
- supported frontend/localStorage state when supplied by the renderer; and
- optional AES-256-GCM encryption with legacy encrypted-bundle read compatibility.

A failed backup aborts the update. The updater never treats a copy of the whole Electron
`userData` directory as a database backup.

## Native packaged update

The native update path is `update:install-shell`, despite the historical IPC name. It:

1. selects the release `Vision-<version>-arm64-mac.zip` and its sibling checksum;
2. rejects a missing or malformed checksum, digest mismatch, unsafe archive path, or an archive
   without exactly one acceptable `Vision.app` payload;
3. extracts into a private temporary directory;
4. stops the native Bun backend but leaves durable PostgreSQL and attachments in application data;
5. copies the fixed installer helper beside the staged application and launches it with argument
   arrays;
6. waits for Electron to exit, stages the new application beside the installed application, and
   atomically renames the installed and rollback bundles; and
7. reopens Vision, restoring and reopening the previous application if installation or relaunch
   fails.

If the helper cannot be launched, the old native backend is restarted and the current application
remains open. An update never changes the runtime marker.

## Source update

Source mode downloads `vision-source-launcher-<version>-arm64.zip`. The archive must contain the
expected `unsigned/Vision/package.json` layout and only relative non-traversing entries. The helper
backs up the checkout before replacement and preserves the generated
`packaging/electron/native-runtime` payload so a source update does not force a database/runtime
redownload.

New releases publish a sibling SHA-256 checksum. The older source updater retains its documented
compatibility behavior for releases that predate checksum publication; native packaged updates do
not have that exception.

## Optional Docker update

Docker mode uses the existing Compose provider methods to pull the configured application image,
restart the app service, and wait for health. It does not run in native mode. The previous image and
all named volumes remain available if the new container fails.

A registry pull verifies content addressing and transfer integrity, but it is not a substitute for
image signing or provenance verification. Release CI retains the Docker build, scan, and publish
path as a separate optional deployment artifact.

## Renderer behavior

`UpdateNotification.tsx` and `AboutSection.tsx` share the same sequence:

1. check the latest release;
2. create the provider-aware pre-update backup;
3. show `downloading` for native/source or `pulling` for Docker;
4. call `installShellUpdate()` for native/source or `triggerDockerUpdate()` for Docker; and
5. show restart/completion state or a mapped recovery error.

Outside Electron the UI shows the operator command path instead of presenting a non-functional
install button.

## IPC surface

| Handler                    | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `update:get-mode`          | Return `native`, `dev`, `source`, or `docker`           |
| `update:check-github`      | Return release metadata and resolved update mode        |
| `update:pre-update-backup` | Create a `.visionbak` with the active runtime transport |
| `update:install-shell`     | Install a verified native application or source update  |
| `update:pull-image`        | Update only the explicit Docker provider                |

The preload exposes only these fixed operations. Renderer input cannot supply an executable or a
shell command.

## Release pipeline

`.github/workflows/release.yml` is authoritative. The macOS package job:

1. installs the locked Bun, Node.js, and Python build toolchains;
2. installs the exact Alembic and PyInstaller build dependencies;
3. downloads the pinned Chrome Headless Shell;
4. downloads and SHA-256-verifies the pinned Postgres.app release artifact, then uses only its
   PostgreSQL 18.6 build files;
5. builds the production frontend and complete native payload;
6. packages the arm64 DMG and ZIP;
7. stages the source-launcher ZIP; and
8. publishes SHA-256 files for every release artifact.

The Docker image job remains independent and optional. Verify/version gates run before either
publication path. See [[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]].

## Rollback boundaries

There are two separate rollback concerns:

- **Application rollback:** the native installer automatically retains and restores the previous
  `Vision.app` when replacement or relaunch fails. Durable data is not part of this swap.
- **Data rollback:** use the verified `.visionbak` restore path. It stages a fresh database and
  attachment tree and activates them only after schema and readiness validation. Do not copy files
  into the live PostgreSQL data directory.

Docker-to-native provider rollback is different again. After native writes begin, the stopped
Docker copy is stale and preserving those writes requires a reverse logical migration. See
[[docs/guides/native-macos-runtime#rollback|Native macOS Runtime Guide — Rollback]].

## Security properties

- Native package checksum is mandatory and fail-closed.
- Archive extraction rejects path traversal and unexpected application layout.
- Installer processes receive fixed executable paths and argument arrays.
- Native backend stop/restart is bounded; durable PostgreSQL is not replaced during app updates.
- Backup failure prevents installation.
- Admin authentication, loopback binding, and the active-runtime marker are unchanged by updates.

## Related documentation

- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/adr/023-update-installer-checksum-verification|ADR-023]]
- [[docs/adr/113-native-macos-runtime|ADR-113]]
