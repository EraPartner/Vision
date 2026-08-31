---
title: Gated Release Candidate Promotion and Artifact Attestation
type: adr
status: Accepted
date: 2026-08-31
tags: [adr, release, supply-chain, trivy, sbom, provenance, attestations]
description: Release images are pushed without tags, scanned and migration-tested by digest, then promoted; macOS artifacts receive GitHub attestations before publication.
aliases: [ADR-116, gated release promotion, release attestations]
---

# ADR-116: Gated Release Candidate Promotion and Artifact Attestation

## Status

Accepted

## Date

2026-08-31

## Context

The older release flow assigned public image tags before its vulnerability scan and migration
round-trip completed. A failed gate could therefore leave a rejected image reachable through a
normal release tag. The macOS DMG and ZIP files had sibling checksums, but release-asset replacement
or tampering outside the authorized workflow could replace an artifact and its checksum together.

## Decision

The Docker job pushes a multi-platform image index without tags and addresses it only by digest.
Trivy scans that digest with the repository's shared `.trivyignore` accepted-risk policy. The same
candidate boots under Compose and completes a downgrade/upgrade migration round-trip. Only after
every gate passes does `docker buildx imagetools create` promote that exact index to semver tags and,
when appropriate, `latest`. The workflow then verifies every promoted tag resolves to the scanned
digest. BuildKit provenance and Software Bill of Materials attestations remain attached to the
same index.

The final release job uses GitHub's pinned `actions/attest` action to attest the DMG, native app ZIP,
and source-launcher ZIP after artifact download and before the GitHub Release is created. Its
job-scoped release permissions are joined by the three attestation-specific grants:
`id-token: write`, `attestations: write`, and `artifact-metadata: write`. Checksums remain published
as a convenient offline integrity check; attestations provide repository and workflow provenance.

## Consequences

- A scan or migration failure leaves only an untagged digest candidate, not a user-facing release.
- CI and release scans share one accepted-risk list, so an exception cannot pass CI and unexpectedly
  block the release solely because the two Trivy invocations drifted.
- Published macOS artifacts can be verified against the repository with `gh attestation verify`.
- This repository can validate workflow structure locally, but the first live tagged release must
  confirm token permissions and attestation verification end to end.

## Related

- [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI Supply Chain Security Tooling]]
- [[docs/adr/051-docker-compose-sync-named-volumes|ADR-051: Docker Compose Sync and Named Volumes]]
- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/index|All ADRs]]
