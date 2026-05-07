---
title: Security Documentation Index
type: security-index
status: active
date: 2026-04-10
updated: 2026-05-07
tags: [security, index, validation, rate-limiting, ci-cd, supply-chain, gitleaks, secrets-scanning]
description: Security practices and policies for the Vision application including input validation, rate limiting, and supply chain security (secrets scanning, dependency audit, container scanning)
aliases: [security, security docs, input validation, rate limiting, supply chain security]
---

# Security Documentation

Security practices and policies for Vision.

## Areas

```dataview
TABLE title, description
FROM "docs/security"
WHERE type = "security"
SORT title ASC
```

## Topics

- [[docs/security/input-validation|Input Validation]] - Input sanitization and validation
- [[docs/security/rate-limiting|Rate Limiting]] - Request rate controls
- [[docs/security/data-protection|Data Protection & CSP]] - Content Security Policy, path traversal prevention, data protection, privacy, backup encryption, Phase 7 restore safety, Electron permission hardening, error-page strict CSP
- [[docs/security/ai-data-access|AI Data Access Policy]] - Tool allowlist, rate limits, no-external-calls guarantee, audit logging
- [[docs/security/container-hardening|Container Hardening]] - Docker defense-in-depth: non-root user, dropped capabilities, read-only filesystem, resource limits, healthcheck, CI image scanning
- [[docs/security/dependency-security-remediation-2026-04|Dependency Security Remediation (2026-04)]] - Workspace dependency hardening and validation outcomes
- Admin auth token middleware (`ADMIN_AUTH_TOKEN`) is documented in [[docs/api/admin|Admin API]] and [[docs/reference/environment-variables|Environment Variables]].

## Supply Chain Security (2026-05-07)

- **[[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI Supply Chain Security Tooling]]** - Secrets scanning (gitleaks in CI + pre-commit hook), dependency vulnerability audit (`bun audit`), container image scanning (Trivy), Electron permission handler hardening, strict CSP on error page
- **[[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]]** - Full documentation of security scanning jobs (`secrets-scan`, `deps-audit`, `trivy-scan`) and setup instructions
- **[[docs/guides/contributing|Contributing Guide]]** - Developer setup including pre-commit hook installation (`git config core.hooksPath .githooks`, `brew install gitleaks`)

## Past Hardening

- **Phase 7 Hardening (May 2026):** See [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049]] for Electron backup/restore safety enhancements and [[docs/adr/002-database-schema|ADR-002]] for Phase 6.1 corrective migration of `updated_at` constraints.
