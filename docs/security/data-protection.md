---
title: Security - Data Protection & CSP
type: security
status: active
date: 2026-04-19
updated: 2026-06-01
tags: [security, csp, cors, data-protection, privacy, content-security-policy, xss, dangerouslySetInnerHTML, path-traversal, rfc-5987, backup-encryption, passphrase, phase-7, phase-c, pre-restore-confirmation, concurrent-backup-guard, watchdog-pause, bug-hunt-2026-05-05, bug-hunt-2026-05-06, electron-hardening, window-open-handler, will-navigate, checksum-verification, backup-directory-restrictions, csv-filename-sanitization, safe-storage, keychain, lazy-safeStorage, csrf-guard, sec-fetch-site, admin-auth, token-or-open, zip-bomb, response-cap, content-length]
description: Content Security Policy, CORS, data protection, path traversal prevention, backup security, and privacy considerations for Vision. Phase 7 adds pre-restore confirmation dialog and concurrent-backup guard. May 2026 bug hunt hardens Electron with setWindowOpenHandler denial, will-navigate whitelist, mandatory installer checksum verification, and backup directory restrictions. safeStorage is now accessed lazily to avoid macOS Keychain prompts when no passphrase is configured. 2026-05-29: admin auth replaced with token-or-open + CSRF guard (ADR-063). June 2026: zip-bomb guard on restore, 5 MB Content-Length response cap on external fetches.
aliases: [CSP, data protection, privacy, content security policy, security headers, XSS prevention, path traversal]
related_code: ["apps/node-backend/src/main.js", "apps/frontend/src/lib/api.ts", "apps/node-backend/src/services/attachmentService.js", "apps/node-backend/src/middleware/adminAuth.js", "apps/node-backend/src/middleware/csrfGuard.js"]
---

# Security: Data Protection & CSP

## Overview

Vision is a desktop-first financial application handling sensitive financial data. This document covers data protection, Content Security Policy, and privacy considerations.

---

## Content Security Policy (CSP)

### Backend Configuration (Main App)

The Express server sets CSP headers in `main.js`:

```javascript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https:",
    "font-src 'self'",
    "connect-src 'self' http://localhost:*",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});
```

### Key Directives

| Directive | Value | Rationale |
|-----------|-------|-----------|
| `default-src` | `'self'` | Only load resources from same origin |
| `script-src` | `'self'` | No inline scripts, no external scripts |
| `style-src` | `'self' 'unsafe-inline'` | Tailwind requires inline styles (only in main app) |
| `img-src` | `'self' https:` | Allow remote HTTPS images (news thumbnails) |
| `connect-src` | `'self' http://localhost:*` | Only connect to local backend |
| `frame-ancestors` | `'none'` | Prevent clickjacking |

### News Image Exception

Market lookup news cards display remote HTTPS thumbnails. The CSP `img-src 'self' https:` allows this while restricting other resource types.

### Error Recovery Page CSP (Strict)

The error recovery page (`packaging/electron/assets/error.html`, 2026-05-07) uses **strict CSP without unsafe-inline**:

```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; style-src 'self'; script-src 'self'" />
<link rel="stylesheet" href="error.css" />
<script src="error.js"></script>
```

**Why strict CSP on error page:**
- Error recovery is a sensitive operation (showing database connection failures, offering restore options)
- No dynamic inline styles or scripts required
- Inline styles could be exploited for CSS exfiltration (background-image URLs to log CSS-injected values)
- Inline scripts could be exploited for script injection if path parameters were unsanitized (though they aren't)
- Error page assets are static, bundled with app, and trusted

**Files:** 
- `packaging/electron/assets/error.html` — Meta tag with strict CSP
- `packaging/electron/assets/error.css` — Extracted styles (no `<style>` tag)
- `packaging/electron/assets/error.js` — Extracted logic (no `<script>` tag)

---

## Security Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Frame-Options` | `DENY` | Prevent iframe embedding |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-XSS-Protection` | `1; mode=block` | XSS filter |
| `Strict-Transport-Security` | `max-age=31536000` | HSTS (production only) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer info |

---

## Cross-Origin Resource Sharing (CORS)

Vision implements CORS with strict origin validation to prevent credential leakage (2026-04-29 remediation per ADR-042):

### Policy

- **Explicit Allowlist**: Only origins in `settings.api.corsOrigins` receive `Access-Control-Allow-Origin` response header
- **Credentials Only with Allowlist**: `Access-Control-Allow-Credentials: true` is set **only** when origin is on the explicit allowlist — never combined with wildcard `*`
- **Wildcard Dev-Only**: Wildcard origin (`*`) permitted in development environments only, **without credentials** (browser enforces this requirement)
- **Production**: Wildcard origin is never used; only explicit origins are allowed

### Code Pattern

```javascript
const origin = req.headers.origin;
const allowed = settings.api.corsOrigins;
const isWildcard = allowed === '*';

const originAllowed = Array.isArray(allowed)
  ? allowed.includes(origin)
  : !isWildcard && allowed === origin;

if (originAllowed && origin) {
  // Credentials only with explicit origin allowlist
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
} else if (isWildcard && isDevelopment()) {
  // Wildcard dev-only, no credentials
  res.setHeader('Access-Control-Allow-Origin', '*');
}
```

### Rationale

Combining wildcard origin with `Allow-Credentials: true` allows any web page to read authenticated responses (browser rejects this, but it's a code-smell security anti-pattern). The fix ensures credentials are never sent with wildcard origins, even in development.

---

## Input Validation

### Frontend (Zod)

The financial forms — transactions (add + inline edit), portfolio transactions
(add/edit), accounts (create/edit), and the tax profile — validate on submit
with Zod schemas built from the shared field builders in
[[apps/frontend/src/lib/forms/schemas.ts]] (locale-aware money amounts,
YYYY-MM-DD dates, currency codes). Schema issue messages carry i18n *keys*,
translated at the form seam, so validation copy flows through each form's
existing presentation path (inline ARIA field errors via `useFieldErrors`, or
the form's single error toast). Per-form schemas live next to their forms:

- `apps/frontend/src/components/forms/addTransactionForm.ts` (`addTransactionSchema`)
- `apps/frontend/src/components/portfolio/portfolioTxnSchema.ts` (add/edit portfolio txns)
- `apps/frontend/src/features/accounts/accountFormSchema.ts`
- `apps/frontend/src/components/tax/taxProfileSchema.ts`

Non-financial forms may still use plain controlled-state checks; new forms
should compose the shared builders. Example (real schema):

```typescript
export const addTransactionSchema = z.object({
  transaction_date: ymdDateString('validation.required'),
  amount: moneyAmount({
    required: 'validation.required',
    invalid: 'addTxn.invalidAmount',
    zero: 'addTxn.zeroAmount',
  }),
  bank_account: requiredTrimmedString('portfolio.move.selectAccount'),
  recipient_id: requiredString('validation.required'),
  // category/memo/currency/comment pass through unvalidated
});
```

### Backend (Middleware)

Request validation middleware validates:
- ID parameters (positive integers)
- Date formats (ISO 8601)
- Amount ranges
- Required fields

**Location:** [[apps/node-backend/src/middleware/validation.js]]

---

## XSS Prevention

### dangerouslySetInnerHTML Removal (Phase 9)

All use of React's `dangerouslySetInnerHTML` has been removed from the frontend. Portfolio info cards (Crypto, Savings, Real Estate, Stocks) previously used `dangerouslySetInnerHTML={{ __html: t(...) }}` to render plain-text translation strings. This was unnecessarily risky.

**Resolution:** All portfolio cards now render translations as plain text: `{t(...)}` instead of `dangerouslySetInnerHTML`. Since translation strings are plain text (no embedded HTML), this eliminates XSS surface while maintaining identical output.

**Rule:** Never use `dangerouslySetInnerHTML` unless:
1. Content is explicitly sanitized via DOMPurify or similar
2. Content source is fully trusted and controlled
3. No reasonable alternative exists

---

## Path Traversal Prevention

The attachment service protects against directory traversal attacks via explicit path validation:

```javascript
// In attachmentService.js resolveAbsolutePath()
const root = getAttachmentsRoot();
const absolute = resolve(root, storedPath);
if (absolute !== root && !absolute.startsWith(root + sep)) {
  throw new Error('Invalid attachment path: outside attachments root');
}
return absolute;
```

Key protections:
- All file paths resolved relative to `ATTACHMENTS_DIR`
- Path separator (`sep`) imported from `node:path` for OS compatibility
- Rejection of paths escaping the root (e.g., `../../../etc/passwd`)
- See [[docs/api/attachments|Attachments API]] for details

---

## SQL Injection Prevention

All database queries use **parameterized queries**:

```javascript
// ✅ Safe
await query('SELECT * FROM transactions WHERE id = $1', [id]);

// ❌ Never do this
await query(`SELECT * FROM transactions WHERE id = ${id}`);
```

### Repository Convention

- Positional parameters (`$1`, `$2`, ...)
- Manual parameter index tracking
- No string concatenation in SQL

---

## Rate Limiting

### Global Rate Limiter

Applied to all routes as a baseline protection.

### Per-Route Limiters

| Endpoint | Limit | Reason |
|----------|-------|--------|
| `GET /api/transactions/export/csv` | 30 req/min | Expensive operation |
| `PATCH /api/transactions/:id` | 30 req/min | Prevent abuse |
| `GET /api/info/net-worth` | 30 req/min | Expensive computation |
| `GET /api/info/exchange-rates` | 30 req/min | External API calls |
| `POST /api/info/exchange-rates/refresh` | Admin only | Admin operation |

**Location:** [[apps/node-backend/src/middleware/rateLimiter.js]]

---

## Data Protection

### Local-First Architecture

By default, Vision stores all data locally:
- **Database:** Local PostgreSQL instance
- **Backend:** Local Node.js process
- **Frontend:** Local Chromium instance

No data is transmitted externally except:
- Price provider API calls (binance, yahoo, kinesis)
- Exchange rate fetching (ECB, open.er-api)
- Inflation data (Statbel, Eurostat)
- Market lookup data (Yahoo Finance)

### Environment Variables

Sensitive configuration via environment variables only:
- Database credentials
- API keys (Kinesis, etc.)
- CORS origins

Never stored in source code or committed to git.

### Error Information Disclosure

Production error responses suppress stack traces and internal details:

```javascript
// Production
{ "detail": "Internal server error" }

// Development
{ "detail": "Error message with stack trace" }
```

---

## Electron Security

### Context Isolation

```javascript
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

### IPC Communication

Limited IPC channel exposure through preload scripts. Only validated functions are exposed to the renderer.

### Renderer Process Capabilities Lockdown (2026-05-05 Bug Hunt, Enhanced 2026-05-07)

**Permission Request Denial**
- All permission requests from renderer process are denied at the session level
- Implementation: `session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false); })`
- Denied permissions: `camera`, `microphone`, `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, custom IPC permissions
- Impact: Renderer cannot escalate to system resources; even if compromised (XSS), attacker cannot access camera, location, or clipboard without explicit main-process IPC bridge
- **Future Features:** If a feature requires a system permission, implement via explicit `ipcMain.on()` handler with user confirmation dialog in main process (native OS dialog, not web)

**setWindowOpenHandler Denial**
- Prevents renderer-initiated `window.open()` from spawning new windows
- Implementation: `mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`
- Impact: Blocks JavaScript `window.open()` calls and link targets `target="_blank"`; users must explicitly select & open links via right-click → "Open in Browser"

**will-navigate Whitelist**
- Only allows navigation to explicitly whitelisted protocols and origins:
  - `file:` protocol (local resources within the app bundle)
  - `localhost` and `127.0.0.1` (local backend)
  - Denies all external URLs, preventing accidental leaks of user data to remote sites
- Implementation: `mainWindow.webContents.on('will-navigate', (event, url) => { /* whitelist check */ })`
- Impact: Stops renderer JavaScript from navigating to external domains; news links remain visible but require explicit user action to open

### Installer Checksum Enforcement (2026-05-05 Bug Hunt)

**Mandatory Checksum Verification**
- Release update flow now requires cryptographic verification of downloaded installer
- When checking for updates via `GET /api/admin/updates/latest`, the response includes asset checksums
- The update installer (`.dmg` on macOS) must have a corresponding `.sha256` file on the GitHub release
- Missing checksum asset throws error: `"No checksum asset found for this release — aborting update to prevent running an unverified installer"`
- Impact: Prevents silent replacement of installer with trojanized variant; users cannot bypass this check

### Backup Directory Restrictions (2026-05-05 Bug Hunt)

**BLOCKED_BACKUP_PREFIXES Validation**
- Backup restore operation validates destination paths to prevent writing to system directories
- Blocked prefixes include: `/bin`, `/boot`, `/dev`, `/etc`, `/lib`, `/opt`, `/proc`, `/root`, `/sbin`, `/sys`, `/usr`, `/var` (and subdirectories)
- Implementation: `BLOCKED_BACKUP_PREFIXES.some(p => resolvedDest === p || resolvedDest.startsWith(p + '/'))`
- Impact: Prevents accidental (or malicious) restore to system directories that could break macOS, corrupt system libraries, or escalate privileges

### Zip-Bomb Guard on Backup Restore (June 2026)

The backup restore `extractZip()` function now enforces hard limits to prevent decompression-bomb attacks:

| Guard | Limit | Description |
|-------|-------|-------------|
| `MAX_RESTORE_BYTES` | 10 GiB | Total bytes written across all extracted files; abort if exceeded |
| `MAX_RESTORE_ENTRIES` | 100,000 | Maximum number of files in the archive |
| Implausible declared size | > 10 GiB per entry | Reject before extraction begins |

Bytes are tracked against **actual written bytes** (not the declared uncompressed size in the zip metadata, which an attacker can set to any value). On violation the extraction is aborted and the partial output directory is cleaned up.

Code: [[packaging/electron/backup/bundle.js]]

### Content-Length Response Cap on External Fetches (June 2026)

The backend's `_assertResponseWithinCap()` helper enforces a **5 MB** per-response limit on external HTTP calls. This prevents a misbehaving or compromised price provider from streaming arbitrarily large payloads into memory.

**Coverage:**
- Binance price/history fetches — explicitly capped
- Kinesis trendline fetches — explicitly capped
- Yahoo Finance — uses `yahoo-finance2` npm library; the library controls response handling, so no `Response` object is available for direct capping. Rate-limiting still applies.

> [!info] External currency/inflation endpoints (ECB, open.er-api, Statbel, Eurostat) have their own timeout guards and are separate from the price-provider fetch path.

Code: [[apps/node-backend/src/services/prices/priceProviderRegistry.js]]

---

### Admin Auth: Token-or-Open + CSRF Guard (2026-05-29)

Admin endpoints (`/api/admin/*`) are protected by two co-operating guards. See [[docs/adr/063-admin-auth-csrf-guard|ADR-063]] for the full decision record.

**`adminAuth.js` — Token-or-Open**

- When `ADMIN_AUTH_TOKEN` is set: every admin request must carry `Authorization: Bearer <token>`. Comparison uses `crypto.timingSafeEqual()` on equal-length buffers to prevent timing side-channels.
- When `ADMIN_AUTH_TOKEN` is unset: the middleware calls `next()` immediately. No IP check is performed. Protection is then provided entirely by (a) the docker-compose loopback binding (`127.0.0.1:PORT`) and (b) the CSRF guard below.
- A startup warning is logged when the token is absent, instructing operators to set it if the port is published on `0.0.0.0`.

> [!warning] This supersedes the RFC1918 IP-allowlist fallback from ADR-037. The middleware no longer trusts the entire private address space — `10.x`, `172.16.x`, `192.168.x`, IPv6 ULA are no longer implicitly trusted.

**`csrfGuard.js` — `createCsrfGuard` (mounted before `adminAuthMiddleware`)**

Blocks cross-site state-changing browser requests. Strategy (zero-config, no tokens/cookies):

- `GET`/`HEAD`/`OPTIONS` are always allowed.
- `Sec-Fetch-Site` header (sent by Chrome 76+, Firefox 90+, Safari 16.4+) is authoritative:
  - `same-origin` or `none` (typed URL, curl, Electron IPC): allow.
  - `same-site` or `cross-site`: reject with 403.
- Fallback when `Sec-Fetch-Site` absent: if `Origin` is present it must be in `settings.api.corsOrigins`; if `Origin` is absent the request is treated as a non-browser client and allowed.

CORS alone does not stop cross-site requests from executing — it only hides the response. The CSRF guard prevents the request body from reaching the route handler.

Mount order in `main.js`:
```
mountRouter(app, '/api/admin', adminRateLimiter, adminCsrfGuard, adminAuthMiddleware, adminRouter);
```

Code links: [[apps/node-backend/src/middleware/adminAuth.js]], [[apps/node-backend/src/middleware/csrfGuard.js]]

### CSV Download Filename Sanitization (Phase C)

**Problem:** User-provided data (recipient names) used directly in HTTP `Content-Disposition` filename could contain path traversal characters (`..`, `/`), special characters breaking headers, or null bytes.

**Example Attack:**
```
Recipient: "../../../etc/passwd"
Filename: transactions_../../../etc/passwd.csv
Result: File written outside intended directory (on some systems)
```

**Solution:** Sanitize recipient name before embedding in filename

```javascript
// In OwesPage.tsx (CSV export)
function sanitizeFilename(input: string): string {
  // Remove path traversal sequences
  let sanitized = input.replace(/\.\./g, '').replace(/\//g, '-');
  // Remove control characters and null bytes
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');
  // Limit length to 50 chars
  sanitized = sanitized.substring(0, 50);
  // Fallback if completely empty
  return sanitized || 'export';
}

const filename = `${sanitizeFilename(recipientName)}_owes.csv`;
res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
```

**Impact (Phase C):** Prevents path traversal injection in downloaded CSV filenames from user-provided recipient names; filename safe for all filesystems.

---

## Backup Encryption (Phase 2 + v2 Upgrade 2026-04-28)

Encrypted backup restore (`.visionbak.enc`) is fully implemented with passphrase-modal UX and upgraded v2 AEAD encryption:

### Format v1 (Legacy, AES-256-CBC)
- **Encryption**: AES-256-CBC with static 12-byte salt (hardcoded, same across all v1 backups)
- **KDF**: Scrypt(N=2^14, r=8, p=1) from user passphrase
- **Confidentiality**: ✅ Provided | **Authenticity**: ❌ Not provided
- **Status**: Still readable; no longer written (v2 used for new backups as of 2026-04-28)

### Format v2 (Current, AES-256-GCM with Per-Backup Salt)
- **Encryption**: AES-256-GCM (AEAD — Authenticated Encryption with Associated Data)
- **Salt**: Random 16 bytes per backup (generated at encryption time)
- **IV**: Random 12 bytes per backup (GCM standard)
- **KDF**: Scrypt(N=2^15, r=8, p=1) — doubled iteration count for stronger brute-force resistance
- **Auth Tag**: 16 bytes appended; tampering detected immediately on decryption
- **Confidentiality**: ✅ Provided | **Authenticity**: ✅ Provided | **Per-backup Entropy**: ✅ Yes
- **Status**: Default for new backups as of 2026-04-28; see [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]] for full rationale

### Lazy safeStorage Access (May 2026)

`safeStorage` is now only accessed when a passphrase blob is actually present in `settings.json`:

- **`getBackupPassphrase()`** — reads the stored `backupPassphraseEncrypted` blob first. If absent (and `VISION_BACKUP_PASSPHRASE` env var is not set), returns without calling any `safeStorage` API. This eliminates macOS Keychain prompts for users who have not configured backup encryption.
- **`getBackupPassphraseStatus()`** — reports `secureStorageAvailable` from the API object's presence alone (no keychain probe) when no passphrase is stored. The actual availability check is deferred to `setBackupPassphrase()` at opt-in time.

Users who do store a passphrase may still see macOS Keychain prompts on unsigned builds (macOS re-challenges an unstable code identity). The `VISION_BACKUP_PASSPHRASE` environment variable bypasses `safeStorage` entirely as an escape hatch.

### Restore Process
- **Passphrase modal**: When restoring an encrypted backup, users are prompted via modal to enter the passphrase before decryption attempts
- **Magic header detection**: Backup encryption is detected via file magic header (`VISIONENC1` or `VISIONENC2`) without decryption
- **Auto-dispatch**: Restore process automatically detects v1 vs v2 format and invokes correct decoder
- **Fallback sources**: Restore respects `VISION_BACKUP_PASSPHRASE` env var and OS keychain (Electron safeStorage) as fallback if no modal input provided
- **Error recovery**: Wrong passphrase shows clear error message and allows retry (up to 3 attempts typical)
- **Path validation**: File path must have been returned by prior `backup:select-file` dialog; prevents XSS-in-renderer from passing arbitrary paths
- **No breaking changes**: Unencrypted backups (`.visionbak`) restore without prompting; v1 backups decrypt correctly with old passphrases unchanged

See [[docs/features/backup-coverage-audit|Backup Coverage Audit]], [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]], and [[docs/features/settings|Settings Feature]] for full details.

### Phase 7 Restore Safety Hardening (May 2026)

Three defensive measures protect the restore operation from data loss and system instability:

**1. Pre-Restore Confirmation Dialog**
- **Problem:** `backup:restore` silently overwrote live database without user confirmation, risking accidental restore from stale backups
- **Solution:** User sees warning dialog before restore:
  ```
  Title: "Restore Backup"
  Message: "This will permanently replace all current data and cannot be undone."
  Detail: "Restore from: my-backup-2025.visionbak"
  Buttons: [Restore] [Cancel]
  Default: Cancel (index 1) — prevents Enter-key accidents
  ```
- **Impact:** User must explicitly confirm they're about to lose all current data

**2. Concurrent Backup Guard**
- **Problem:** UI rapid-clicking or renderer bug could spawn multiple `pg_dump` processes simultaneously, causing system overload or corrupted bundle output
- **Solution:** Module-scope `let backupInFlight = false;` flag in `backup:run` IPC handler
  - First backup: sets flag
  - Subsequent calls: rejected with `"A backup is already in progress"` message
  - Completion: flag reset in `finally` block (even on error)
- **Impact:** Prevents data corruption, system overload, UI confusion

**3. Health Watchdog Pause During Restore**
- **Problem:** During restore, the database is stopped, dropped, and recreated. The 10-second health watchdog continued polling `GET /health`, detected backend-offline, and could emit spurious `backend:lost` events while restore was still in progress
- **Solution:** Restore sequence:
  1. Call `stopHealthWatchdog()` before restore attempt
  2. Execute restore (drop DB, load SQL, swap attachments)
  3. Guarantee `startHealthWatchdog()` in `finally` block
- **Impact:** No spurious recovery alerts mid-restore; clean separation between restore cleanup and watchdog recovery logic

See [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049]] for full context and consequences.

## Installer Security (install.sh, 2026-04-28)

Homebrew installation script now prevents pipe-to-bash vulnerabilities:

- **Default Behavior**: Does NOT pipe curl output directly to bash (unsafe for MITM attacks)
- **Safer Default**: Downloads installer to a temporary file first, prints SHA-256 digest, requires user confirmation
- **Opt-in Pipe Mode**: Users can opt-in to legacy pipe-to-bash via `VISION_ALLOW_BREW_PIPE=1` environment variable (for CI/automation that can't pause for user interaction)
- **Checksum Verification**: When opted in, supports optional `VISION_BREW_INSTALL_SHA256` env var to validate downloaded installer against expected SHA-256 (early warning of supply-chain tampering)
- **Rationale**: Prevents MITM attacker from modifying installer during download by requiring user to visually inspect hash or configure it in automation

---

## Future Security Roadmap

| Feature | Status | Description |
|---------|--------|-------------|
| Authentication | Planned | Multi-user support with auth |
| Encryption at rest | Planned | Database encryption |
| API authentication | Planned | Token-based API auth |
| Audit logging | Planned | Track all data modifications |

---

## Related

- [[docs/adr/063-admin-auth-csrf-guard|ADR-063: Admin Auth Token-or-Open + CSRF Guard]] — Current admin auth model (supersedes ADR-037)
- [[docs/adr/037-admin-auth-localhost-fallback|ADR-037: Admin Auth Localhost Fallback]] — Superseded RFC1918 IP-allowlist model
- [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI Supply Chain Security Tooling]] — Secrets scanning, dependency audit, container image scanning, Electron permission handler, error-page strict CSP
- [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049: Phase 6.1–7 Bug Hunt Recovery Hardening]] — Database schema fixes, Electron backup/restore safety
- [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040: Backup Format v2 AEAD Encryption]] — Backup encryption scheme (v1 legacy, v2 current)
- [[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042: CodeQL + Dependabot Remediation]] — CORS fix, rate limiters, input validation improvements
- [[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]] — Security job documentation and setup
- [[docs/security/index]] — Security documentation index
- [[docs/security/input-validation]] — Input validation details
- [[docs/security/rate-limiting]] — Rate limiting details
- [[docs/architecture/electron]] — Electron architecture with Phase 7 restore hardening
