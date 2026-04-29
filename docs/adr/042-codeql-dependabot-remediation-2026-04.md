---
title: "CodeQL + Dependabot Security Remediation (2026-04-29)"
type: adr
status: Accepted
date: 2026-04-29
tags: [security, codeql, dependabot, cors, rate-limiting, path-injection, redos, electron]
description: Triage and remediation of 7 Dependabot alerts (tar CVEs) and 17 CodeQL/Trivy findings across CORS, rate-limiting, type coercion, path injection, ReDoS, and HTML sanitization
aliases: [codeql remediation april 2026, dependabot tar remediation, security hardening 2026-04]
related_code: ["packaging/electron/package.json", "apps/node-backend/src/main.js", "apps/node-backend/src/middleware/rateLimiter.js", "apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/services/dataImportService.js", "apps/frontend/src/utils/sanitize.ts", "scripts/validate-locales.js"]
---

# ADR-042: CodeQL + Dependabot Security Remediation (2026-04-29)

## Status

Accepted

## Date

2026-04-29

## Context

GitHub Security tab surfaced 24 alerts across two scanners:

- **7 Dependabot alerts** — all in `packaging/electron/package-lock.json`; all `tar@6.2.1` CVEs (race condition, hardlink/symlink path traversal, drive-relative path bypass) plus one `@tootallnate/once@2.0.0` control-flow issue via `http-proxy-agent` → `@electron/get`
- **17 CodeQL/Trivy alerts** — mix of CRITICAL/HIGH on main branch: CORS credentials misconfiguration, missing rate limiters, type confusion on user input, path injection in tmpdir operations, ReDoS-prone regex, incomplete HTML sanitization, SQL injection false positive

## Decision

**Ship as two PRs.** Classification and per-finding disposition:

### PR 1 — Dependency upgrades

| Package | From | To | Alerts closed |
|---------|------|----|---------------|
| `electron-builder` | `^25.0.0` | `^26.0.0` | `tar@6.2.1` → `tar@7.x`; all 6 tar CVEs closed |
| `@tootallnate/once` | `2.0.0` | removed (not in dep graph of v26) | alert #31 closed |

`packaging/electron/package-lock.json` regenerated via `npm install`; `bun.lock` regenerated via `bun install`. `npm audit` reports 0 vulnerabilities post-upgrade.

### PR 2 — Code fixes and suppressions

| Alert | Location | Root cause | Fix |
|-------|----------|------------|-----|
| CORS + credentials | `main.js:~184` | Wildcard origin combined with `Allow-Credentials: true` | Wildcard now dev-only without credentials; credentials only sent when origin is in explicit allowlist |
| Missing rate limiter (attachments) | `main.js:342`, `rateLimiter.js` | No limiter on upload/download routes | New `attachmentRateLimiter` (60 req/min) mounted via `mountRouter` |
| Missing rate limiter (SPA fallback) | `main.js:373`, `rateLimiter.js` | Static file fallback unthrottled | New `spaRateLimiter` (600 req/min) applied to `GET /^(?!\/api)/` |
| Type confusion (separator) | `importRoutes.js:~273,297` | `req.query` value can be an array; `.length` check passes on arrays ≠ single char | `String()` coercion before length check in both `/recipients` and `/categories` routes |
| Path injection (cleanup) | `importRoutes.js:cleanup()` | `fs.unlink` on multer tmp path without containment guard | `TMP_ROOTS` allowlist check (`os.tmpdir()`, `/tmp`, `/private/tmp`) before unlink |
| Path injection (readFile) | `dataImportService.js:35,137` | `fs.readFile(filePath, encoding)` with caller-controlled path/encoding | New `safeReadCsv()` helper: resolves path, validates against `TMP_ROOTS`, allowlists encoding |
| ReDoS (validate-locales) | `scripts/validate-locales.js:29` | Multiline `/g` regex with alternation under quantifier → exponential backtrack | Replaced with line-by-line `.split('\n')` + anchored single-line `exec`; no backtrack risk |
| Incomplete HTML strip | `sanitize.ts:stripHtml` | Single-pass `<[^>]*>` fails on `<<a>script>` — first pass removes `<a>` leaving `<script>` | Loop until stable: each iteration removes ≥1 char or terminates |
| SQL injection (admin vacuum) | `admin.js:228` | Dynamic `VACUUM "${table}"` flagged by scanner | False positive: `table` validated against `pg_stat_user_tables` allowlist (lines 207–211); added `// codeql[js/sql-injection]` suppression with justification |
| Missing rate limiter (admin vacuum) | `admin.js:206` | Scanner misses route-level `adminMutateLimiter` middleware | False positive: limiter IS applied; added `// codeql[js/missing-rate-limiting]` suppression with justification |

### Dismissals (manual, GitHub UI)

| Alert | Reason |
|-------|--------|
| `@tootallnate/once@2.0.0` (Dependabot #31) | Closed by electron-builder v26 upgrade (not in graph) |
| Trivy pip alerts #38, #39, #40 | `venv/` is gitignored; never deployed; local dev artifact only — dismiss as `not_applicable` |

## Consequences

**Positive:**
- All 7 Dependabot `tar` CVEs resolved without code changes — one dep bump
- CORS no longer allows credential leakage via `*` wildcard in production
- Attachment upload/download and SPA fallback paths are now rate-limited
- CSV import service defends against path traversal and encoding injection at the service boundary
- `stripHtml` loop-stable; cannot be bypassed by nested-tag trick
- `validate-locales.js` regex no longer presents a ReDoS attack surface in CI pipelines
- CodeQL false-positive suppressions documented inline — future scans will auto-close those alerts

**Negative:**
- `electron-builder` major bump (25→26): test `dist` output on target platforms after merge. macOS arm64 confirmed via local smoke build during remediation.
- `spaRateLimiter` at 600 req/min is generous but may surface with aggressive prefetching clients; adjust if needed

**Neutral:**
- `@tootallnate/once` disappears from dep graph entirely; no replacement needed

## Related

- [[docs/security/dependency-security-remediation-2026-04|Dependency Security Remediation 2026-04]]
- [[docs/security/rate-limiting|Rate Limiting Policy]]
- [[docs/security/input-validation|Input Validation]]
- [[docs/adr/039-docker-container-hardening|ADR-039 — Docker Container Hardening]]
- [[docs/adr/index|All ADRs]]
