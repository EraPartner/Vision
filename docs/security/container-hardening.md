---
title: Retired Product Container Hardening
type: security
status: retired
date: 2026-09-08
tags: [security, historical, retired-runtime, supply-chain]
description: Historical record of the retired Docker product hardening boundary and the controls that replaced it.
aliases: [retired container security, historical Docker hardening]
---

# Retired Product Container Hardening

> [!history]
> Vision no longer builds, ships, or supports a Docker or Compose product deployment. ADR-133
> supersedes ADR-039. The separate development sandbox uses Apple `container`; see
> [[docs/guides/devcontainer|Devcontainer Guide]].

The former product image used a non-root user, dropped Linux capabilities, a read-only root
filesystem, resource ceilings, loopback port binding, a health check, and Trivy image scanning.
Those controls described the removed delivery boundary and are not current operating instructions.

Current equivalents are:

- native Electron launches verified Bun and PostgreSQL child processes with restricted directories
  and loopback-only networking;
- PostgreSQL uses separate administrator, owner/migration, and application roles;
- packaged payloads and update archives use checksums and fixed path validation;
- CI runs Trivy against the repository filesystem and audits Bun and Python dependencies; and
- custom source deployments must provide their own process, network, and host isolation.

Electron release jobs continue to use frozen dependency installs and narrow lifecycle-script
execution. These supply-chain controls do not depend on a product container.

## Related

- [[docs/adr/133-native-only-runtime-and-delivery|ADR-133: Native-only runtime and delivery]]
- [[docs/adr/039-docker-container-hardening|ADR-039: Docker container hardening (superseded)]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
