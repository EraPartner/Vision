---
title: Security Documentation Index
type: security-index
status: active
date: 2026-04-10
updated: 2026-05-29
tags: [security, index, validation, rate-limiting, ci-cd, supply-chain, gitleaks, secrets-scanning, ssrf, electron]
description: Security practices and policies for the Vision application including input validation, rate limiting, SSRF guard for outbound URLs, and supply chain security (secrets scanning, dependency audit, container scanning, Electron --ignore-scripts)
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
- Admin auth model (token-or-open + CSRF guard) is documented in [[docs/adr/063-admin-auth-csrf-guard|ADR-063]] and [[docs/security/data-protection|Data Protection]]. The superseded RFC1918 fallback is [[docs/adr/037-admin-auth-localhost-fallback|ADR-037]].

## Supply Chain Security (2026-05-07)

- **[[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI Supply Chain Security Tooling]]** - Secrets scanning (gitleaks in CI + pre-commit hook), dependency vulnerability audit (`bun audit`), container image scanning (Trivy), Electron permission handler hardening, strict CSP on error page
- **[[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]]** - Full documentation of security scanning jobs (`secrets-scan`, `deps-audit`, `trivy-scan`) and setup instructions
- **[[docs/guides/contributing|Contributing Guide]]** - Developer setup including pre-commit hook installation (`git config core.hooksPath .githooks`, `brew install gitleaks`)

## Hardening — 2026-05-29

- **Admin auth: token-or-open + CSRF guard** — [[docs/adr/063-admin-auth-csrf-guard|ADR-063]] replaces the RFC1918 IP-allowlist admin fallback (ADR-037) with two co-operating guards: `adminAuth.js` is now token-or-open (no IP check; timing-safe Bearer when `ADMIN_AUTH_TOKEN` is set, open otherwise), and new `csrfGuard.js` blocks cross-site state-changing browser requests via `Sec-Fetch-Site` (allow `same-origin`/`none`, reject `same-site`/`cross-site`) with an `Origin` allowlist fallback. Mounted before `adminAuthMiddleware` on `/api/admin`. See [[docs/security/data-protection#admin-auth-token-or-open--csrf-guard-2026-05-29|Data Protection — Admin Auth]].
- **SSRF guard for outbound price-provider URLs** — New `lib/urlSafety.js` module (`assertPublicHttpUrl`, `isBlockedIpv4`, `isBlockedIpv6`, `BlockedUrlError`) blocks private/loopback/link-local/CGNAT/unspecified addresses at both the write boundary (investment create/update → 400) and the fetch boundary (custom provider `_fetchJson` + redirect hops, 5 MB response cap). See [[docs/security/input-validation#outbound-request-guard-ssrf-2026-05-29|Input Validation — SSRF guard]] and [[docs/integrations/price-providers#custom-provider-url-constraints-2026-05-29|Price Providers — Custom URL constraints]].
- **Electron release build `--ignore-scripts`** — `release.yml` packaging step now runs `npm ci --ignore-scripts` to block transitive lifecycle scripts in the dependency tree during `.dmg` signing. See [[docs/security/container-hardening#electron-release-build-supply-chain-hardening-2026-05-29|Container Hardening — Electron supply chain]].

## Past Hardening

- **Phase 7 Hardening (May 2026):** See [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049]] for Electron backup/restore safety enhancements and [[docs/adr/002-database-schema|ADR-002]] for Phase 6.1 corrective migration of `updated_at` constraints.
