---
title: Security Documentation Index
type: security-index
status: active
date: 2026-04-10
tags: [security, index, validation, rate-limiting]
description: Security practices and policies for the Vision application including input validation and rate limiting
aliases: [security, security docs, input validation, rate limiting]
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
- [[docs/security/data-protection|Data Protection & CSP]] - Content Security Policy, data protection, privacy
- [[docs/security/ai-data-access|AI Data Access Policy]] - Tool allowlist, rate limits, no-external-calls guarantee, audit logging
- [[docs/security/dependency-security-remediation-2026-04|Dependency Security Remediation (2026-04)]] - Workspace dependency hardening and validation outcomes
- Admin auth token middleware (`ADMIN_AUTH_TOKEN`) is documented in [[docs/api/admin|Admin API]] and [[docs/reference/environment-variables|Environment Variables]].
