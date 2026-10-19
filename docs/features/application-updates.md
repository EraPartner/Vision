---
title: Application Updates
type: feature
status: active
date: 2026-10-19
tags: [feature, updates, electron, native-runtime, backup, checksum, release]
description: Native packaged-app update path with backup, checksum verification, and rollback boundaries; source checkouts update outside the app.
aliases: [update system, application updater]
related_code:
  [
    "packaging/electron/updater.ts",
    "packaging/electron/native-update-installer.ts",
    "packaging/electron/main.ts",
    ".github/workflows/release.yml",
  ]
---

# Application Updates

Vision exposes update information from `/api/admin/update/check`. The packaged app is the only
in-app install path ([[docs/adr/217-retire-source-launcher-update-channel|ADR-217]]):

| `update_mode` | Use                                                     | Installer                            |
| ------------- | ------------------------------------------------------- | ------------------------------------ |
| `native`      | Packaged macOS application                              | Verified release ZIP/app replacement |
| `source`      | Browser deployment or unpackaged (development) Electron | None; update the checkout by hand    |

Browser deployments and development runs receive release information but no in-app installer. The
operator updates the source deployment and database in its own maintenance window.

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
7. launches the replacement Vision application. Successful launch is the installer commit point;
   removal of the old application is best-effort cleanup. A cleanup failure is reported as a warning
   and keeps the running replacement, rather than rolling back to a partly deleted old bundle.
   A launch failure still rolls back before this commit point. This launch result is not a
   database-backed readiness check.

Paths are validated before extraction or replacement. A checksum mismatch, unsupported platform,
or failed backup stops the operation without activating the staged application.

## Development runs

An unpackaged Electron run (`bun run electron:dev` or `bun run electron:prod` from a checkout)
reports update availability with `update_mode: "source"` but never downloads or installs a
release. It skips the delayed background prompt, and *Install update* in Settings › About opens the
GitHub release page instead (`manual_download`). Update the checkout itself and restart. The
former source-launcher bundle (`vision-source-launcher-*.zip`, `launch.command`) and its generated
shell installer were removed by [[docs/adr/217-retire-source-launcher-update-channel|ADR-217]].

## Renderer behavior

The topbar update badge and its dialog (`UpdateNotification`) were removed by
[[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]. One shared query,
`useUpdateStatus` (key `["update-status"]`, `GET /api/admin/update/check`), is polled every five
minutes while the window is visible and refetched on window focus. The sidebar's Settings row shows
a dot (with a screen-reader label) while it reports an update, and Settings › About reads the same
status: it shows the latest version, publish date, release notes and release-page link, offers
*Check for updates* (which refreshes the shared query), and, in Electron only, an *Install update*
button that runs the backup, download, install and restart phases through the updater bridge.
Web clients see the status and release link but no install control.

The Electron inter-process communication surface includes mode lookup, update check, native
installation, progress, and restart events. It does not expose an image-pull operation.

## Release pipeline

`.github/workflows/release.yml` verifies code and generated artifacts, runs native runtime checks,
builds the macOS app and disk image, computes checksums, attests the artifacts, generates the
packaged-app CycloneDX SBOM, and creates the GitHub release. The
release job verifies build provenance before publishing. No application image is built or published.

## Rollback boundaries

Application rollback and database rollback are separate. Replacing the app does not downgrade the
database. Alembic downgrades require explicit review and a backup. A failed native database switch
keeps the previous database until validation succeeds.

## Security properties

- GitHub's protected release process is the trusted publisher. The updater does not verify an
  independent update-signing key or an attestation. An actor able to publish a new ZIP and matching
  checksum through GitHub could supply a malicious update.
- Release downloads use HTTPS and require the ZIP's sibling checksum from the same GitHub release.
  Missing, malformed and mismatched checksums stop automatic installation; the checksum detects
  corruption and asset mismatch within this trust boundary.
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
- [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]] — update controls move to the sidebar dot and Settings › About
- [[docs/components/layout|Layout components]]
- [[docs/adr/168-github-release-trust-boundary|ADR-168]]
- [[docs/adr/217-retire-source-launcher-update-channel|ADR-217]] — source-launcher channel retired
