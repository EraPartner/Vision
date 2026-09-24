---
title: GitHub Release Trust Boundary for Desktop Updates
type: adr
status: Accepted
date: 2026-09-24
tags: [adr, security, release, updates, supply-chain, github]
description: Use the protected GitHub release process as Vision's desktop update trust root without a separately managed signing key.
aliases: [ADR-168, desktop update trust root]
related_code: [".github/workflows/release.yml", "packaging/electron/updater.js"]
---

# ADR-168: GitHub Release Trust Boundary for Desktop Updates

## Status

Accepted

## Date

2026-09-24

## Context

The updater downloads an application or source ZIP and its sibling checksum from one GitHub
release. Matching those values detects corruption or a mismatch between two downloaded assets.
It does not authenticate the release independently: an actor able to publish a new ZIP and checksum
can make them match. ADR-023 described that checksum as protection against compromised GitHub
release credentials; this decision corrects that claim without changing the historical record.

The sole maintainer accepts GitHub as the release publisher and does not want to create, back up,
rotate or use a separate desktop update-signing key. A keyless attestation verifier in the updater
would avoid private-key custody but still require substantial client and release engineering, and
its availability depends on repository visibility and the GitHub plan.

## Decision

- Trust the protected GitHub release workflow, release tag and release API as the source of desktop
  updates. Do not add a separate private signing key or claim an independent signature on the
  sibling `.sha256` file.
- Require a checksum asset for each automatically installed ZIP and reject a missing, malformed or
  mismatched checksum before extraction. Keep archive path checks and native install rollback.
- Stage every release asset on a draft, check the exact draft inventory and asset digests, verify
  that the tag still points to the checked commit, then publish. Enable GitHub immutable releases
  so the published tag and assets cannot be replaced. Record the maintainer's confirmation that
  the setting and tag/main protections are enabled. The first hosted release must still verify
  that the published release is immutable.
- Keep build and SBOM attestations plus release-commit checks for maintainer and consumer
  verification. The updater does not verify those attestations; the release process and GitHub
  account remain trusted.

## Consequences

- There is no personal update-signing key, backup, rotation or per-release signing step.
- Immutable releases, when enabled, protect already published asset bytes and the associated tag.
  They do not stop an actor with enough GitHub authority from publishing a new malicious release.
- The updater's checksum check cannot detect a malicious ZIP and matching checksum published
  together by that actor. GitHub account, workflow, tag and environment protections therefore
  remain release-critical. Their initial configuration is accepted on the sole maintainer's
  confirmation; this does not prove they are enforced or detect later settings drift.
- This supersedes ADR-023's compromised-release-credential threat claim and narrows ADR-116's
  release-asset replacement risk after immutable releases are enabled. The existing historical
  decisions remain unchanged.

## Related

- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Update Installer Checksum Verification]]
- [[docs/adr/116-gated-release-candidate-promotion|ADR-116: Gated Release Candidate Promotion]]
- [[docs/features/application-updates|Application Updates]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/index|All ADRs]]
