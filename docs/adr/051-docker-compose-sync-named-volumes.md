---
title: Docker Compose Named Volumes Sync Policy
type: adr
status: accepted
date: 2026-05-07
tags: [adr, docker-compose, named-volumes, ci-cd, electron, release, data-loss, v1.0.2-bug]
description: Enforces synchronization of named volumes between root and embedded Docker Compose files via CI gate to prevent data loss on updates
aliases: [compose-sync, volume-sync, named-volumes-policy]
related_code: [".github/workflows/ci.yml", ".github/workflows/release.yml", "docker-compose.yml", "packaging/electron/resources/docker-compose.yml"]
---

# ADR-051: Docker Compose Named Volumes Sync Policy

## Status
Accepted (May 2026)

## Date
2026-05-07

## Context

### The v1.0.2 Attachment Wipe Bug

Vision ships as an Electron desktop application. The packaged app includes an embedded Docker Compose file (`packaging/electron/resources/docker-compose.yml`) that is baked into the `.app` bundle at build time. This embedded file mirrors the production Docker Compose configuration (`docker-compose.yml` at repo root).

In v1.0.2, a named volume was added to the root `docker-compose.yml` to persist attachment files. However, **the embedded Electron compose file was not updated**. When users launched the packaged app:

1. The app's embedded compose file lacked the new volume definition
2. Docker Compose ran with only the volumes from the embedded file
3. The attachment volume mount failed silently or used a different location
4. On the next update, file locations changed or data was not persisted
5. **Result:** Users lost all attachments

This was a **critical data loss bug** that should have been caught before release.

### Synchronization Challenge

Both compose files serve different purposes:
- **Root `docker-compose.yml`:** Source of truth for production/development deployments
- **Embedded `packaging/electron/resources/docker-compose.yml`:** Packaged into the Electron `.app`; must be manually synced at release

The sync is manual and easy to forget because:
- The embedded file is in a subdirectory (`packaging/electron/resources/`)
- There is no automated check that they match
- Developers might add a volume to root and forget to propagate it
- The bug only surfaces in packaged builds, not during dev

## Decision

**Enforce strict synchronization of named volumes between both Docker Compose files via automated CI checks.**

### CI Implementation

1. **`verify-compose-sync` job in ci.yml** (May 2026)
   - Runs on every push to main and PR
   - Extracts named volumes from both compose files
   - Compares them; fails if they diverge
   - Added to `quality-gate` prerequisites (blocks Docker build)

2. **`verify` job in release.yml** (May 2026)
   - Runs before any Docker push or packaging
   - Same volume sync check as ci.yml
   - Must pass before release can proceed

### Sync Check Logic

```bash
ROOT_VOLS=$(awk '/^volumes:/{found=1; next} found && /^  [a-zA-Z]/{gsub(/:$/, "", $1); print $1}' docker-compose.yml | sort)
ELECTRON_VOLS=$(awk '/^volumes:/{found=1; next} found && /^  [a-zA-Z]/{gsub(/:$/, "", $1); print $1}' packaging/electron/resources/docker-compose.yml | sort)

if [ "$ROOT_VOLS" != "$ELECTRON_VOLS" ]; then
  echo "ERROR: Named volumes out of sync"
  exit 1
fi
```

Parses the YAML `volumes:` section, extracts named volume keys, compares.

### Workflow Implications

**Adding a new named volume:**

1. Edit `docker-compose.yml` — add volume definition
2. **Must also edit** `packaging/electron/resources/docker-compose.yml` — add same volume
3. Push changes to PR
4. CI `verify-compose-sync` job runs
   - If volumes match: passes, PR can merge
   - If volumes don't match: fails, blocks merge until both files are in sync
5. Once merged to main, pre-release checks and release.yml verify job confirm sync before packaging

**Key constraint:** *Every new named volume must be added to both files, or the PR will be blocked.*

## Consequences

### Positive

- **Prevents data loss:** Automated guard rail catches sync drift before release
- **Release safety:** `verify` job in release.yml ensures no data-loss bugs ship
- **Developer awareness:** CI failure message educates: "add missing volumes to packaging/electron/resources/docker-compose.yml"
- **Cost:** Minimal — simple YAML parsing, runs in <5 seconds

### Neutral

- Adds one more CI gate in quality-gate (verify-compose-sync)
- Developers must remember to sync both files when adding volumes
  - Mitigated by CI failure message
  - Mitigated by future docs and PR templates

### Negative

- None identified; the policy is defensive and low-cost

## Related

- [[docs/guides/cicd-pipelines#3-verify-compose-sync--docker-compose-sync-check|CI/CD Pipelines: Verify Compose Sync]] — Detailed CI job documentation
- [[docs/guides/deployment#6-admin-endpoints-security|Deployment Guide: Admin Endpoints Security]] — Cross-references compose sync requirement
- [[docs/architecture/electron#cicd-integration-april-may-2026|Electron Architecture: CI/CD Integration]] — Release workflow context
- `.github/workflows/ci.yml` — `verify-compose-sync` job
- `.github/workflows/release.yml` — `verify` job compose check
