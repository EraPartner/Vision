---
title: Dependency Security Remediation (2026-04)
type: security
status: active
date: 2026-04-10
tags: [security, dependencies, remediation, toolchain, vite, vitest]
description: Workspace-level dependency hardening with overrides/resolutions, toolchain upgrades, and validation outcomes
aliases: [dependency remediation april 2026, security hardening dependencies, bun audit remediation]
related_code: ["package.json", "apps/frontend/package.json", "apps/node-backend/package.json", "apps/node-backend/tests/priceProviderService.test.js"]
---

# Dependency Security Remediation (2026-04)

## Scope

This remediation batch hardened transitive dependency resolution at workspace root and upgraded frontend/backend toolchain packages to patched versions.

## Root workspace dependency hardening

Root-level `overrides` and `resolutions` were updated in [[package.json]] to pin vulnerable transitive packages:

- `path-to-regexp`: `0.1.13`
- `brace-expansion`: `1.1.13`
- `flatted`: `3.4.2`
- `lodash`: `4.18.1`
- `vite`: `8.0.8`
- `picomatch`: `4.0.4`

Existing rollup hardening was retained:

- `overrides.rollup`: `>=4.59.0`
- `resolutions.rollup`: `4.59.0`

## Toolchain upgrades

### Frontend

In [[apps/frontend/package.json]]:

- `vite` upgraded to `^8.0.8`
- `@vitejs/plugin-react-swc` upgraded to `^4.3.0`

### Backend

In [[apps/node-backend/package.json]]:

- `vitest` upgraded to `^4.1.4`

## Vitest 4 compatibility adjustment

Vitest 4 required a constructor-compatible mock implementation for `yahoo-finance2` in:

- [[apps/node-backend/tests/priceProviderService.test.js]]

The mock now uses `vi.fn().mockImplementation(function MockYahooFinance() { ... })` to preserve constructor-like behavior expected by the module usage pattern.

## Validation outcomes

- `bun audit` reports **No vulnerabilities found**.
- Backend tests pass on Vitest 4 (`^4.1.4`).
- Frontend build passes on Vite 8 (`^8.0.8`).
- Frontend lint still contains pre-existing warnings/errors unrelated to this remediation batch.

## Notes for future updates

- Keep root `overrides` and `resolutions` synchronized for security-sensitive transitive packages.
- Re-run `bun audit` after dependency updates and before release tagging.

## Related

- [[docs/security/index]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/testing/testing|Testing Documentation]]

---

## 2026-04-29 — CodeQL + Dependabot Batch Remediation

Second remediation batch; addressed 7 Dependabot alerts and 17 CodeQL/Trivy findings. Full triage and disposition documented in [[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042]].

### Dependabot — tar CVEs (PR 1)

All 6 `tar@6.2.1` CVEs (race condition Unicode APFS, hardlink/symlink path traversal, drive-relative path escapes) closed by bumping `electron-builder` `^25→^26` in `packaging/electron/package.json`. `tar@^7` resolves transitively; `npm audit` reports 0 vulnerabilities. `@tootallnate/once@2.0.0` dropped from dep graph entirely by the same upgrade.

### CodeQL — Code fixes (PR 2)

| Finding | File | Fix |
|---------|------|-----|
| CORS + credentials with wildcard | `main.js` | Wildcard dev-only, no credentials; credentials only with explicit origin allowlist |
| Missing rate limiter — attachments | `main.js`, `rateLimiter.js` | `attachmentRateLimiter` (60 req/min) added and mounted |
| Missing rate limiter — SPA fallback | `main.js`, `rateLimiter.js` | `spaRateLimiter` (600 req/min) added and mounted |
| Type confusion on `separator` | `importRoutes.js` | `String()` coercion before length check in both import routes |
| Path injection — tmpdir (cleanup) | `importRoutes.js` | `TMP_ROOTS` allowlist guard before `unlink` |
| Path injection — tmpdir (readFile) | `dataImportService.js` | `safeReadCsv()` helper validates path + allowlists encoding |
| ReDoS in locale parser | `scripts/validate-locales.js` | Line-by-line split + anchored single-line regex |
| Incomplete HTML strip | `sanitize.ts` | `stripHtml` loops until stable |
| SQL injection false positive (vacuum) | `admin.js` | `// codeql[js/sql-injection]` inline suppression with justification |
| Missing rate-limit false positive (vacuum) | `admin.js` | `// codeql[js/missing-rate-limiting]` inline suppression with justification |

### Trivy pip alerts

Three pip version alerts (#38, #39, #40) are `not_applicable`: `venv/` is gitignored and never deployed. Dismiss via GitHub UI with reason `not_applicable`.
