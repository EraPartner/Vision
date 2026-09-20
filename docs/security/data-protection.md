---
title: Security - Data Protection & CSP
type: security
status: active
date: 2026-09-20
updated: 2026-09-20
tags: [security, csp, cors, data-protection, privacy, content-security-policy, xss, dangerouslySetInnerHTML, path-traversal, rfc-5987, backup-encryption, passphrase, phase-7, phase-c, pre-restore-confirmation, concurrent-backup-guard, watchdog-pause, bug-hunt-2026-05-05, bug-hunt-2026-05-06, electron-hardening, window-open-handler, will-navigate, checksum-verification, backup-directory-restrictions, csv-filename-sanitization, safe-storage, keychain, lazy-safeStorage, csrf-guard, sec-fetch-site, admin-auth, token-or-open, zip-bomb, response-cap, content-length]
description: Content Security Policy, CORS, data protection, path traversal prevention, backup security, and privacy considerations for Vision. Phase 7 adds pre-restore confirmation dialog and concurrent-backup guard. May 2026 bug hunt hardens Electron with setWindowOpenHandler denial, will-navigate whitelist, mandatory installer checksum verification, and backup directory restrictions. safeStorage is now accessed lazily to avoid macOS Keychain prompts when no passphrase is configured. 2026-05-29: admin auth replaced with token-or-open + CSRF guard (ADR-063). June 2026: zip-bomb guard on restore, 5 MB Content-Length response cap on external fetches.
aliases: [CSP, data protection, privacy, content security policy, security headers, XSS prevention, path traversal]
related_code: ["apps/node-backend/src/main.js", "apps/frontend/src/lib/api.ts", "apps/node-backend/src/services/attachmentService.js", "apps/node-backend/src/services/analysisExecutor.js", "apps/node-backend/src/database/analysisRoleBootstrap.js", "apps/node-backend/src/middleware/adminAuth.js", "apps/node-backend/src/middleware/csrfGuard.js"]
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
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https:",
      "font-src 'self'",
      "connect-src 'self' http://localhost:*",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  next();
});
```

### Key Directives

| Directive         | Value                       | Rationale                                          |
| ----------------- | --------------------------- | -------------------------------------------------- |
| `default-src`     | `'self'`                    | Only load resources from same origin               |
| `script-src`      | `'self'`                    | No inline scripts, no external scripts             |
| `style-src`       | `'self' 'unsafe-inline'`    | Tailwind requires inline styles (only in main app) |
| `img-src`         | `'self' https:`             | Allow remote HTTPS images (news thumbnails)        |
| `connect-src`     | `'self' http://localhost:*` | Only connect to local backend                      |
| `frame-ancestors` | `'none'`                    | Prevent clickjacking                               |

### News Image Exception

Market lookup news cards display remote HTTPS thumbnails. The CSP `img-src 'self' https:` allows this while restricting other resource types.

### Error Recovery Page CSP (Strict)

The error recovery page (`packaging/electron/assets/error.html`, 2026-05-07) uses **strict CSP without unsafe-inline**:

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; style-src 'self'; script-src 'self'"
/>
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

| Header                      | Value                             | Purpose                  |
| --------------------------- | --------------------------------- | ------------------------ |
| `X-Frame-Options`           | `DENY`                            | Prevent iframe embedding |
| `X-Content-Type-Options`    | `nosniff`                         | Prevent MIME sniffing    |
| `X-XSS-Protection`          | `1; mode=block`                   | XSS filter               |
| `Strict-Transport-Security` | `max-age=31536000`                | HSTS (production only)   |
| `Referrer-Policy`           | `strict-origin-when-cross-origin` | Limit referrer info      |

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
const isWildcard = allowed === "*";

const originAllowed = Array.isArray(allowed)
  ? allowed.includes(origin)
  : !isWildcard && allowed === origin;

if (originAllowed && origin) {
  // Credentials only with explicit origin allowlist
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
} else if (isWildcard && isDevelopment()) {
  // Wildcard dev-only, no credentials
  res.setHeader("Access-Control-Allow-Origin", "*");
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
YYYY-MM-DD dates, currency codes). Schema issue messages carry i18n _keys_,
translated at the form seam, so validation copy flows through each form's
existing presentation path (inline ARIA field errors via `useFieldErrors`, or
the form's single error toast). Per-form schemas live next to their forms:

- `apps/frontend/src/features/transactions/addTransactionForm.ts` (`addTransactionSchema`)
- `apps/frontend/src/features/portfolio/portfolioTxnSchema.ts` (add/edit portfolio txns)
- `apps/frontend/src/features/accounts/accountFormSchema.ts`
- `apps/frontend/src/features/tax/taxProfileSchema.ts`

Non-financial forms may still use plain controlled-state checks; new forms
should compose the shared builders. Example (real schema):

```typescript
export const addTransactionSchema = z.object({
  transaction_date: ymdDateString("validation.required"),
  amount: moneyAmount({
    required: "validation.required",
    invalid: "addTxn.invalidAmount",
    zero: "addTxn.zeroAmount",
  }),
  bank_account: requiredTrimmedString("portfolio.move.selectAccount"),
  recipient_id: requiredString("validation.required"),
  // category/memo/currency/comment pass through unvalidated
});
```

### Backend validation

The pure validation library defines:

- ID parameters (positive integers)
- Date formats (ISO 8601)
- Amount ranges
- Required fields

**Locations:** [[apps/node-backend/src/lib/validation.js|lib/validation.js]] owns the value rules;
[[apps/node-backend/src/middleware/validation.js|middleware/validation.js]] contains the Express
path-parameter adapters and route-compatible re-exports.

### Manual analysis SQL isolation

The manual analysis workspace never executes SQL with the application database role. Startup
maintains a dedicated `vision_analysis_executor` login that cannot create databases or roles,
inherit privileges, replicate, or bypass row-level security. The role receives schema usage and
`SELECT` only on the four approved `vision_analysis.*_v1` views. The executor also requires a
declared dataset set, opens a read-only transaction, applies statement, lock, idle, row and byte
limits, and rejects write, catalog, file, extension, and multi-statement SQL before PostgreSQL sees
it. Cancellation uses a reserved connection under that same restricted role.

This boundary protects against accidental and adversarial editor input. It does not turn database
results into public data: the analysis routes remain inside Vision's existing local-user boundary.
See [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]].

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
  throw new Error("Invalid attachment path: outside attachments root");
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
await query("SELECT * FROM transactions WHERE id = $1", [id]);

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

| Endpoint                                | Limit      | Reason                |
| --------------------------------------- | ---------- | --------------------- |
| `GET /api/transactions/export/csv`      | 30 req/min | Expensive operation   |
| `PATCH /api/transactions/:id`           | 30 req/min | Prevent abuse         |
| `GET /api/info/net-worth`               | 30 req/min | Expensive computation |
| `GET /api/info/exchange-rates`          | 30 req/min | External API calls    |
| `POST /api/info/exchange-rates/refresh` | Admin only | Admin operation       |

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

### Provider API Keys Are Stored in Plaintext (Accepted Risk)

`provider_api_keys.api_key` (migration 0043) is a plain `TEXT` column, even
though the `pgcrypto` extension has been available since the baseline migration
(`0001`). The table is in `BACKUP_COVERED_TABLES`, so Settings-managed research
provider keys appear in the clear in every database dump and in every
**unencrypted** backup bundle.

**Why this is accepted rather than fixed:**

- The same class of secret already lives in plaintext in `.env` — provider keys
  set by environment variable, `DATABASE_URL` with the database password, and
  `ADMIN_AUTH_TOKEN`. `pgp_sym_encrypt` would need its key from that same file,
  so anyone who can read the ciphertext can almost always read the key too. It
  moves the secret, it does not protect it.
- The threat it would actually address — an attacker who reads the database or a
  dump but _not_ the host filesystem — is narrow for a single-user, local-first
  deployment where the database and `.env` sit on the same machine.
- Encrypting the column adds a real failure mode: a backup restored onto a fresh
  install without the original key would silently produce unusable provider keys,
  with no signal until an API call fails.
- Anything in the database that an attacker would want is already there in the
  clear — the transaction ledger is the sensitive asset, not the vendor keys.

**Compensating controls:**

- Backup bundles support AES-256-GCM encryption (see _Backup Encryption_ below);
  use it if backups leave the machine.
- Provider keys are per-vendor, revocable at the vendor, and grant no access to
  Vision's own data.
- The database role the runtime pool uses can be a non-superuser (`ftm_app`); see
  `.env.example`.

**What would change this decision:** multi-user support, a hosted/shared
deployment, or storing a secret whose compromise is not independently revocable.
At that point the fix is a new migration adding an encrypted column, a backfill,
and a drop of the old one — with a documented key-recovery story for restores,
which is the part that must be designed first.

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

| Guard                     | Limit              | Description                                                       |
| ------------------------- | ------------------ | ----------------------------------------------------------------- |
| `MAX_RESTORE_BYTES`       | 10 GiB             | Total bytes written across all extracted files; abort if exceeded |
| `MAX_RESTORE_ENTRIES`     | 100,000            | Maximum number of files in the archive                            |
| Implausible declared size | > 10 GiB per entry | Reject before extraction begins                                   |

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
- When `ADMIN_AUTH_TOKEN` is unset: the middleware calls `next()` immediately. No IP check is
  performed. Native Electron's loopback binding supplies the network boundary and the CSRF guard
  below supplies the browser-origin boundary.
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

## Audit chain foundation and backup boundary (2026-09-20)

Migration 0117 starts a versioned hash chain after the existing DB-editor, split, and portfolio-retag audit rows. Its head records the highest legacy ID for each older table. New chain entries and checkpoint metadata are stored with the head in PostgreSQL and included in normal Vision backups. Application appends lock the head; the entry and domain change must share one database transaction. Database triggers reject ordinary rewrites of entries and checkpoint rows.

The native Electron main process now keeps a versioned HMAC-signed receipt and its `safeStorage`-encrypted key under its local application-data `audit-anchor/` directory. The receipt binds the chain sequence, hash, and migration 0117 legacy high-water IDs. Version 3 also requires a matching checkpoint in a separate macOS Keychain generic-password item. The packaged helper uses the Security framework and receives checkpoint data on standard input. Rolling back PostgreSQL and application data alone leaves a detectable mismatch if the Keychain item survives. Version 2 receipts are not silently enrolled. An unsigned build may prompt for the Keychain password. The main process sends the authenticated receipt through a private loopback bridge protected by a random per-launch Bearer token (`VISION_AUDIT_BRIDGE_TOKEN` in the backend child). The backend scans the complete chain and post-cutover domain links; pre-cutover audit rows remain unverified. The renderer and ordinary admin token cannot access the bridge.

The generic Admin data editor has no access to this authenticated receipt. Its schema, row, and mutation endpoints return `403` for `audit_chain_head`, `audit_chain_entries`, `audit_chain_checkpoints`, `db_editor_audit`, `split_audit`, and `portfolio_retag_audit`. Table-health statistics may still show these tables. A database backup preserves their bytes for recovery, but a copy of those bytes alone does not establish verified audit evidence.

The native Admin audit view reads through Electron main, which authenticates the local receipt and Keychain checkpoint before requesting a bounded page. The backend verifies the complete chain and reads that page in one repeatable-read snapshot. Each entry is labeled as either within the anchored prefix or pending a newer receipt. A failed or unavailable check returns no entries. Native export writes a complete snapshot only when the chain fits within 500 entries and 2 MB, and the file states it is not a signed report or remote attestation. Browser deployments without the native bridge cannot display this verified view.

For an existing native installation with no trusted receipt, the Admin view offers a deliberate enrollment action with a default-Cancel native warning. The backend first checks the whole current chain and linked domain rows. Electron signs the observed head, creates the separate Keychain witness, and stores an immutable enrollment sequence in the receipt. Entries at or before that sequence are shown as **Accepted at enrollment**; neither the view nor export claims to prove their authenticity before enrollment. An existing, damaged, or mismatched receipt or witness blocks this action. It is never run automatically during startup or restore.

If the Keychain witness and receipt were written but the backend checkpoint acknowledgement failed, a later trusted startup repeats the exact checkpoint metadata write. The backend accepts a byte-identical repeated receipt and rejects an identity conflict. This repairs database metadata only; it never creates a new external anchor or changes the enrollment baseline.

For a new Mac, the operator may export an independently verified receipt and audit key in a password-protected transfer file. The password is never stored; the file contains no transactions and is encrypted with scrypt and AES-256-GCM. The recipient imports it only during its first native launch, before restoring the matching encrypted database backup. Import replaces the new cluster's fresh witness but cannot authenticate database rows; the restore gate must compare the complete restored chain with the imported checkpoint. A copied transfer file and its password together expose the audit key, so they should be kept separate and discarded after a successful move. See [[docs/adr/161-password-protected-audit-device-transfer|ADR-161]].

An interrupted transfer leaves a private copy of the original fresh key and receipt. At the next load, Electron retains the current pair if it matches the Keychain witness, or restores the original pair only if that pair matches. An unmatched witness blocks verification. Recovery does not permit another import into an established installation; restart with a fresh empty target before retrying a failed device move. See [[docs/adr/163-audit-transfer-recovery-journal|ADR-163]].

Admin can explicitly rotate the local audit key after the whole chain verifies. The receipt remains at the same head under a new key and Keychain witness; a failed write does not silently accept an old checkpoint. Keep a matching protected transfer and backup before rotating, because a crash between file writes and Keychain replacement can leave an unavailable witness.

One-year audit retention signs the last eligible old entry hash and linked-domain high-water IDs into the external receipt and Keychain witness before migration 0118 removes a complete prefix. The database function rechecks age and continuity under the chain-head lock. The retained suffix remains verifiable against the signed predecessor; older chain payloads are no longer available in the live database. Audit domain rows and backup copies follow their own retention rules. An interrupted prune is retried using the same signed boundary. See [[docs/adr/162-one-year-audit-retention|ADR-162]].

On one disposable PostgreSQL 18 run on this Mac, 100 synthetic `appendAuditEvent` calls inside one transaction measured 0.536 ms median, 0.768 ms p95, and 1.115 ms maximum per append. This samples the chain writer only; it is not an end-to-end DB-editor, split, or broker-retag latency guarantee. The opt-in probe is in `auditAdversarial.db.test.js` and can be rerun with `VISION_RUN_AUDIT_PERFORMANCE=1 bun run test:db tests/auditAdversarial.db.test.js --reporter=verbose`.

Native startup checks before first navigation and after backend recovery. An exact verified head enables a trusted live session; every 30 seconds while healthy, Electron re-verifies the chain and signed cutover, then advances its local receipt to a valid new tail and mirrors checkpoint metadata. Failed or unavailable checks end that session and raise an operating-system notification, while leaving the app accessible. Backend loss ends the session. Native updater decisions are appended through the private bridge. If an external receipt exists or a trusted session was established this launch, each decision must be synchronously checkpointed; failure blocks install. An existing installation with no receipt and no trusted session may still install after the event is recorded, with audit protection reported unavailable. The event records the local checksum or install decision, not publisher or signed-release provenance. Source development updates may have no native bridge event.

Restore pauses live closure, compares before database-switch finalization, and initially rolls back unless the result is exactly `verified`. A chain with valid entries beyond the last receipt is `partially_verified`; a tail already present at startup is not promoted. After a successful rollback, the user can accept a separate default-Cancel warning to retry the selected authenticated backup once. This recovery still checks the full internal chain, preserves the external receipt, and leaves continuity unverified; a later check may report rollback. No recovery retry is offered when the first rollback fails. Existing installations are not automatically enrolled. Missing, partial, or corrupt receipt files are not silently replaced.

This is installation-local evidence, not a complete tamper-evidence guarantee. A privileged actor with control of the Keychain item or application code can rewrite this local witness. Changes within the live 30-second interval can also be incorporated into the next receipt. Moving only a backup to a new machine lacks the original witness. Checkpoint metadata in PostgreSQL cannot prove that an external receipt exists. Interrupted-transfer recovery passed synthetic and disposable-Keychain checks; a physical two-Mac move remains untested. Migration 0117 permits downgrade only with its sole matching upgrade event and no checkpoint; any later event or checkpoint blocks it. See [[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]], [[docs/adr/157-electron-local-audit-receipt|ADR-157]], [[docs/adr/158-macos-keychain-audit-witness|ADR-158]], [[docs/adr/160-explicit-audit-enrollment-baseline|ADR-160]], [[docs/adr/161-password-protected-audit-device-transfer|ADR-161]], [[docs/adr/163-audit-transfer-recovery-journal|ADR-163]], [[docs/api/internal-audit|Private Audit Bridge]], [[docs/reference/data-model|Data Model Reference]], and [[docs/features/backup-coverage-audit|Backup Coverage Audit]].

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

For backup passphrase handling, `safeStorage` is accessed only when a passphrase blob is present in `settings.json`. The separate native audit anchor also uses `safeStorage` when enrolled:

- **`getBackupPassphrase()`** — reads the stored `backupPassphraseEncrypted` blob first. If absent (and `VISION_BACKUP_PASSPHRASE` env var is not set), returns without calling any `safeStorage` API. This avoids backup-passphrase Keychain prompts for users who have not configured backup encryption.
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

## Source-build Installer Security

The repository's `install.sh` builds the native macOS application from a local
checkout. It does not download or install host package managers or build toolchains. It fails
closed when the required build tools or exact
migration-package versions are unavailable. Locked Bun dependencies, the pinned
Chrome Headless Shell version, PostgreSQL 18.6 validation, payload hashing, and
post-build code-signature checks protect the generated application resources.

The installed application starts only its private loopback PostgreSQL cluster.

---

## Future Security Roadmap

| Feature            | Status  | Description                                                                                                                                                                                                                                                     |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | Planned | Multi-user support with auth                                                                                                                                                                                                                                    |
| Encryption at rest | Planned | Database encryption (would subsume the plaintext `provider_api_keys` risk accepted above)                                                                                                                                                                       |
| API authentication | Planned | Token-based API auth                                                                                                                                                                                                                                            |
| Audit logging      | Partial | Migrations 0117–0118 add a hash chain and guarded one-year prefix pruning; Electron keeps a Keychain-backed receipt, checks startup/restore, supports enrollment, rotation, and protected device transfer. Live device-move and recovery acceptance remain open |

---

## Related

- [[docs/adr/063-admin-auth-csrf-guard|ADR-063: Admin Auth Token-or-Open + CSRF Guard]] — Current admin auth model (supersedes ADR-037)
- [[docs/adr/037-admin-auth-localhost-fallback|ADR-037: Admin Auth Localhost Fallback]] — Superseded RFC1918 IP-allowlist model
- [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI Supply Chain Security Tooling]] — Historical decision; current filesystem scanning is described in the CI/CD guide
- [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049: Phase 6.1–7 Bug Hunt Recovery Hardening]] — Database schema fixes, Electron backup/restore safety
- [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040: Backup Format v2 AEAD Encryption]] — Backup encryption scheme (v1 legacy, v2 current)
- [[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042: CodeQL + Dependabot Remediation]] — CORS fix, rate limiters, input validation improvements
- [[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]] — Security job documentation and setup
- [[docs/security/index]] — Security documentation index
- [[docs/security/input-validation]] — Input validation details
- [[docs/security/rate-limiting]] — Rate limiting details
- [[docs/architecture/electron]] — Electron architecture with Phase 7 restore hardening
