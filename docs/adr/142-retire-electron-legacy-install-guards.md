---
title: Retire Electron Legacy-Install Guards
type: adr
status: Accepted
date: 2026-09-13
tags: [adr, electron, native-runtime, migration, support-cutoff, recovery]
description: Retire legacy Electron user-data and Docker-runtime discovery after confirming that the sole maintained installation uses the canonical native runtime.
aliases: [ADR-142, Electron legacy cutoff]
related_code:
  - packaging/electron/main.js
  - packaging/electron/runtime/index.js
  - packaging/electron/runtime/native.js
---

# ADR-142: Retire Electron Legacy-Install Guards

## Status

Accepted on 2026-09-13.

This decision supersedes the migration-helper portion of
[[docs/adr/045-electron-app-name-userData-migration|ADR-045]] and the fail-closed legacy-runtime
boundary in [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]]. Their historical context
remains valid.

## Context

Vision has one maintained installation and one user. That installation already uses the canonical
`Vision` application-data directory and native PostgreSQL runtime. The owner explicitly ended
support for skipped-version Electron installs, the old `vision-desktop` application-data directory,
and retired Docker or embedded-Compose runtime state.

The old guards added startup branches that could rename or archive application-data directories,
select a runtime from persisted legacy settings, or refuse native startup when obsolete markers
were present. Keeping those branches would maintain an unsupported recovery promise and leave
untested storage-switching behavior in every current launch.

## Decision

- The support cutoff is 2026-09-13. There are zero maintained legacy installations.
- Vision does not discover, move, archive, import, or block on old `vision-desktop`, Docker, or
  embedded-Compose state.
- Electron selects the native runtime by default. An explicit unsupported runtime value remains a
  configuration error instead of silently changing meaning.
- Native startup replaces stale runtime ownership markers with the current native marker. It does
  not inspect retired embedded-Compose residue.
- The canonical `Vision` application identity, isolated Demo and development profiles, encrypted
  backup creation, and supported backup restore remain unchanged.
- Recovery from a legacy installation is unsupported. A user who intentionally kept such an
  installation must recover outside the current application before upgrading; the current release
  provides no importer or downgrade bridge.

## Consequences

- Current startup has one storage and runtime path.
- Reinstalling a very old release and then jumping directly to a current release can no longer
  trigger automatic data recovery.
- Historical migration ADRs and source history remain the only record of the retired behavior.
- Packaged validation must prove canonical native startup and supported backup/restore. It no
  longer needs legacy-install migration fixtures.

## Verification

```bash
bun run test:electron
bun run native:isolated-smoke
bun run dist
```

See [[docs/architecture/electron|Electron Desktop Architecture]] for the current runtime contract.
