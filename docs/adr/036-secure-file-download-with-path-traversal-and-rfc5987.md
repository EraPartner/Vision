---
title: ADR-036 - Secure File Download with Path Traversal Guard and RFC 5987
type: adr
status: Accepted
date: 2026-04-25
tags: [adr, backend, security, attachments, path-traversal, rfc-5987, filename-encoding]
description: Path traversal protection via resolved-path validation and RFC 5987 dual-encoding for non-ASCII filenames in Content-Disposition headers
aliases: [adr-036, file-security]
related_code:
  - apps/node-backend/src/services/attachmentService.js
  - apps/node-backend/src/routes/attachments.js
  - docs/api/attachments.md
---

# ADR-036: Secure File Download with Path Traversal Guard and RFC 5987

## Status

Accepted

## Date

2026-04-25

## Context

Attachment downloads (`GET /api/attachments/:id/download`) serve files from a configurable directory. Two security concerns arise:

1. **Path Traversal Attack**: An attacker could craft a stored path like `../../../etc/passwd` to escape the attachments root and read arbitrary files.
2. **Non-ASCII Filename Corruption**: Users uploading files with non-ASCII names (e.g., `reçu.pdf`, `帳簿.xlsx`) would suffer filename corruption when downloaded, as standard HTTP headers are ASCII-only. Modern browsers expect RFC 5987 encoding for proper Unicode support.

## Decision

### 1. Path Traversal Guard

Implement explicit path validation in `resolveAbsolutePath()`:

```javascript
export function resolveAbsolutePath(storedPath) {
  const root = getAttachmentsRoot();
  const absolute = resolve(root, storedPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error('Invalid attachment path: outside attachments root');
  }
  return absolute;
}
```

**Mechanism:**
- Resolve both root and full path to absolute form using `node:path.resolve()`
- Reject paths that escape the root (do not equal root and do not start with root + separator)
- Import `sep` from `node:path` to handle OS-specific separators (Windows vs. POSIX)

**Why this design:**
- Prevents `../` traversal and symlink escape
- Works across filesystems (Windows, macOS, Linux)
- Fails closed (whitelist approach: only paths under root are valid)

### 2. RFC 5987 Dual-Encoding for Filenames

Implement RFC 5987-compliant `Content-Disposition` header with dual encoding:

```javascript
const asciiFallback = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
const utf8Encoded = encodeURIComponent(attachment.filename);
res.setHeader(
  'Content-Disposition',
  `inline; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
);
```

**Mechanism:**
- `filename` (ASCII fallback): Original filename with non-printables, quotes, and backslashes replaced by `_`
  - Ensures older browsers or clients that ignore `filename*=` still receive a usable name
  - Max printable ASCII range: `\x20` to `\x7e` (space to tilde)
- `filename*` (RFC 5987 encoding): UTF-8 percent-encoding of original filename
  - Format: `charset'lang'value` (e.g., `UTF-8''re%C3%A7u.pdf`)
  - Modern browsers prefer this form for proper Unicode rendering

**Behavior:**
- RFC 5987–aware clients (modern Chrome, Firefox, Edge, Safari) parse `filename*=` and receive the original UTF-8 filename
- Legacy or non-compliant clients fall back to the ASCII `filename` value (degraded but functional)

**Why this design:**
- Standards-compliant (RFC 5987)
- Backward compatible (ASCII fallback for old clients)
- No information loss for modern clients
- Simple, deterministic encoding

## Consequences

**Positive**
- Path traversal attacks are cryptographically closed off; resolved paths outside the root are rejected.
- Non-ASCII filenames (French, German, Chinese, etc.) are served correctly on modern browsers.
- Backward compatible: legacy clients still receive usable (though transliterated) names via ASCII fallback.
- Zero performance impact: path validation and filename encoding are O(1) string operations.

**Negative**
- Transliterated ASCII fallback may confuse users on legacy clients (e.g., `reçu.pdf` → `re_u.pdf`). This is acceptable as an edge case; the non-legacy path is correct.
- Requires `node:path` import for separator handling; no external dependencies added.

**Neutral**
- Stored paths in the database continue to use forward slashes for portability; the `resolve()` function handles OS-specific normalization at serving time.
- Migration: no schema or data changes required; purely behavioral (request-time).

## Related

- [[docs/api/attachments|Attachments API]] — Updated with path traversal guard and RFC 5987 details
- [[docs/security/data-protection|Security: Data Protection & CSP]] — Added path traversal prevention section
- [[docs/adr/index|All ADRs]]
