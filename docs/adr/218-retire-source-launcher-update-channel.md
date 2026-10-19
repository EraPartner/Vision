---
title: "ADR-218: Retire the source-launcher update channel; packaged app updates only"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, electron, updates, release, packaging, retirement, adr-023, adr-116, adr-196]
description: "Accepted on 2026-10-19 by Tor. The source-launcher distribution and update channel (packaging/electron/unsigned/launch.command, the vision-source-launcher-*.zip release asset, its source SBOM and attestation, and the generated rsync shell installer) is removed. The packaged Vision.app updater stays the only in-app install path; unpackaged development runs report update_mode \"source\" and open the release page."
aliases: [adr-218, retire source launcher, packaged updates only]
---

# ADR-218: Retire the source-launcher update channel; packaged app updates only

## Status

Accepted on 2026-10-19 by Tor. It supersedes only the source-launcher parts of
[[docs/adr/023-update-installer-checksum-verification|ADR-023]] (the shell-installer update path),
[[docs/adr/116-gated-release-candidate-promotion|ADR-116]] (attesting the source-launcher ZIP) and
[[docs/adr/196-electron-shell-typescript|ADR-196]] (the source launcher as a build entry point).
Their other decisions stay in force.

## Date

2026-10-19

## Context

Vision shipped two in-app update channels. The packaged `Vision.app` downloads
`Vision-x.y.z-arm64-mac.zip` and its `.sha256` from the GitHub release, verifies the checksum,
and replaces itself through `packaging/electron/native-update-installer.ts`. A second channel
served people who ran Vision from source through a double-clickable `launch.command`: every
release also built `vision-source-launcher-x.y.z-arm64.zip` (a `git archive` of the tag plus the
launcher), a source CycloneDX SBOM and an attestation, and an unpackaged Electron run downloaded
that ZIP and ran a generated Bash script that rsynced it over the checkout, reinstalled
dependencies and relaunched.

The source channel duplicated the packaged updater's trust and rollback work with a much larger
surface (rsync snapshots, Bun and Electron reinstall, quarantine stripping), needed tools the
packaged app does not, and had no users besides development checkouts, which update with Git.

## Decision

Retire the source-launcher channel. The packaged app updater is the only in-app install path and
behaves exactly as before.

Removed:

- `packaging/electron/unsigned/` (`launch.command`, `README.md`).
- The source update path in `packaging/electron/updater.ts`: the source-launcher asset picker, the
  shell installer preparation and its generated script, and the `"dev"` update mode. Update
  audit decisions are always recorded with mode `"native"`.
- The release workflow step that built the source-launcher ZIP, the source SBOM
  (`Vision-source.cdx.json`), its attestation, and their checksum, provenance and inventory
  entries.
- The contract field `source_launcher_available` and the `update_mode` value `"dev"` from
  `UpdateCheck` in `openapi.yaml`, the Electron IPC types and the generated frontend types.

Behaviour of an unpackaged (development) Electron run:

- `update:check-github` still reports the latest release, with `update_mode: "source"`, the value
  browser deployments already receive from `GET /api/admin/update/check`.
- The delayed background update prompt is not shown.
- *Install update* never downloads anything; it opens the GitHub release page and returns
  `manual_download`, the same result a release without a packaged app ZIP gives.

`bun run electron:prod` stays: it is still the documented way to run the production shell from a
checkout.

## Consequences

- One installer to maintain and audit. The release publishes the DMG, the native app ZIP, the
  packaged-app SBOM, the README and their checksums.
- Removing `source_launcher_available` and the `"dev"` enum value narrows a response contract.
  No shipped client read the field, and the Electron renderer and backend are released together,
  so the change is not breaking for Vision's own clients; an external client that matched on
  `"dev"` would now see `"source"` for a development run.
- Existing checkouts that used `launch.command` no longer receive in-app updates; they update with
  Git and start Vision with `bun run electron:prod` or `bun run electron:dev`.
- The internal audit endpoint and the Electron runtime bridge still accept mode `"dev"`; the
  updater no longer sends it.

## Related

- [[docs/features/application-updates|Application updates]]
- [[docs/architecture/electron|Electron architecture]]
- [[docs/guides/cicd-pipelines|CI/CD pipelines]]
- [[docs/adr/168-github-release-trust-boundary|ADR-168: GitHub release trust boundary]]
- [[docs/adr/index|All ADRs]]
