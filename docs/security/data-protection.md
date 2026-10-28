---
title: Security - Data Protection & CSP
type: security
status: active
date: 2026-10-28
updated: 2026-10-28
tags: [security, csp, same-origin, loopback, data-protection, privacy, content-security-policy, xss, dangerouslySetInnerHTML, path-traversal, rfc-5987, backup-encryption, passphrase, phase-7, phase-c, pre-restore-confirmation, concurrent-backup-guard, watchdog-pause, bug-hunt-2026-05-05, bug-hunt-2026-05-06, electron-hardening, window-open-handler, will-navigate, checksum-verification, backup-directory-restrictions, csv-filename-sanitization, safe-storage, keychain, lazy-safeStorage, csrf-guard, sec-fetch-site, host-guard, dns-rebinding, zip-bomb, response-cap, content-length]
description: Content Security Policy, the loopback-only network boundary, data protection, path traversal prevention, backup security, and privacy considerations for Vision. Phase 7 adds pre-restore confirmation dialog and concurrent-backup guard. May 2026 bug hunt hardens Electron with setWindowOpenHandler denial, will-navigate whitelist, mandatory installer checksum verification, and backup directory restrictions. safeStorage is now accessed lazily to avoid macOS Keychain prompts when no passphrase is configured. 2026-05-29: admin auth replaced with token-or-open + CSRF guard (ADR-063). 2026-10-20: CORS, the admin token and proxy support removed; the backend is loopback-only (ADR-233). June 2026: zip-bomb guard on restore, 5 MB Content-Length response cap on external fetches.
aliases: [CSP, data protection, privacy, content security policy, security headers, XSS prevention, path traversal]
related_code: ["apps/node-backend/src/main.ts", "apps/frontend/src/lib/api.ts", "apps/node-backend/src/services/attachmentService.ts", "apps/node-backend/src/services/analysisExecutor.ts", "apps/node-backend/src/database/analysisRoleBootstrap.ts", "apps/node-backend/src/middleware/hostGuard.ts", "apps/node-backend/src/middleware/csrfGuard.ts"]
---

# Security: Data Protection & CSP

## Overview

Vision is a desktop-first financial application handling sensitive financial data. This document covers data protection, Content Security Policy, and privacy considerations.

---

## Content Security Policy (CSP)

### Backend Configuration (Main App)

The Express server sets CSP headers in `main.ts`:

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

Set on every backend response in `apps/node-backend/src/main.ts`:

| Header                    | Value                                          | Purpose                     |
| ------------------------- | ---------------------------------------------- | --------------------------- |
| `X-Frame-Options`         | `DENY`                                         | Prevent iframe embedding    |
| `X-Content-Type-Options`  | `nosniff`                                      | Prevent MIME sniffing       |
| `X-XSS-Protection`        | `0`                                            | Deprecated; CSP is relied on |
| `Referrer-Policy`         | `strict-origin-when-cross-origin`              | Limit referrer info         |
| `Permissions-Policy`      | `camera=(), microphone=(), geolocation=()`     | Deny device APIs            |
| `Content-Security-Policy` | `default-src 'self'; … frame-ancestors 'none'` | See the CSP section above   |

There is no `Strict-Transport-Security` header: the backend speaks plain HTTP on loopback only, so
HSTS would have no effect ([[docs/adr/233-loopback-only-backend|ADR-233]]).

---

## Same-origin only (no CORS)

The backend sends no CORS headers and does not answer CORS preflights
([[docs/adr/233-loopback-only-backend|ADR-233]]). Every legitimate client is same-origin: the
packaged renderer loads the backend's own origin, and in development the Vite proxy forwards `/api`
from the dev server's origin. A page on any other origin therefore cannot read API responses. The
CSRF guard below still stops cross-site requests of every method from executing, because the
same-origin policy hides responses but does not block requests.

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

**Locations:** [[apps/node-backend/src/lib/validation.ts|lib/validation.ts]] owns the value rules;
[[apps/node-backend/src/middleware/validation.ts|middleware/validation.ts]] contains the Express
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
// In attachmentService.ts resolveAbsolutePath()
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

All database queries bind their values as parameters
([[docs/adr/226-kysely-query-builder|ADR-226]]):

```typescript
// ✅ Safe: Kysely query builder (apps/node-backend/src/database/db.ts)
await db.selectFrom("transactions").selectAll().where("id", "=", id).execute();

// ✅ Safe: Kysely sql tag, interpolations become bound parameters
await sql`SELECT * FROM transactions WHERE id = ${id}`.execute(db);

// ❌ Never do this
await sql.raw(`SELECT * FROM transactions WHERE id = ${id}`).execute(db);
```

### Repository Convention

- Plain reads and writes use the Kysely query builder over the generated schema types
- Analytical SQL uses Kysely's `sql` template tag; its interpolations are bound, not concatenated
- No string concatenation of values into SQL; `sql.raw` is reserved for trusted static
  SQL text (migration files, module constants) and validated identifiers

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

**Location:** [[apps/node-backend/src/middleware/rateLimiter.ts]]

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

Never stored in source code or committed to git.

### Provider API Keys Are Stored in Plaintext (Accepted Risk)

`provider_api_keys.api_key` (migration 0043) is a plain `TEXT` column, even
though the `pgcrypto` extension has been available since the baseline migration
(`0001`). The table is in the whole-database backup dump, so Settings-managed research
provider keys appear in the clear in every database dump and in every
**unencrypted** backup bundle.

**Why this is accepted rather than fixed:**

- The same class of secret already lives in plaintext in `.env` — provider keys
  set by environment variable and `DATABASE_URL` with the database password. `pgp_sym_encrypt` would need its key from that same file,
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

- All permission requests from renderer process are denied at the session level, in every profile including Vision Development (since 2026-10-19; previously packaged builds only). Only the CSP and security response headers remain packaged-only
- The permission check handler allows only app-origin `clipboard-sanitized-write`, `loopback-network` and `local-network-access` (`packaging/electron/runtime/renderer-security.ts`)
- `app.enableSandbox()` sandboxes every renderer and a `web-contents-created` hook cancels `will-attach-webview`; packaged builds also disable the `NODE_OPTIONS` and `--inspect` fuses and enforce embedded asar integrity and asar-only loading. See [[docs/architecture/electron#Electron Fuses (ADR-219)|Electron fuses]] and [[docs/adr/219-minimal-electron-shell-hardening|ADR-219]]
- Implementation: `session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false); })`
- Denied permissions: `camera`, `microphone`, `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, custom IPC permissions
- Impact: Renderer cannot escalate to system resources; even if compromised (XSS), attacker cannot access camera, location, or clipboard without explicit main-process IPC bridge
- **Future Features:** If a feature requires a system permission, implement via explicit `ipcMain.on()` handler with user confirmation dialog in main process (native OS dialog, not web)

**setWindowOpenHandler Denial**

- Prevents renderer-initiated `window.open()` from spawning new windows
- Implementation: the handler always returns `{ action: 'deny' }`. It hands the URL to
  `shell.openExternal` only when `externalBrowserUrl` in
  `packaging/electron/runtime/renderer-security.ts` accepts it: a parsed absolute `http:`/`https:`
  URL with no credentials that is neither the app's own origin nor a loopback or unspecified host
  (`localhost`, 127.0.0.0/8, 0.0.0.0/8, `::1`, `::`, or such an IPv4 address embedded in IPv6, as
  in `::ffff:127.0.0.1`)
- Impact: `target="_blank"` links to public web pages open in the OS browser; `file:`,
  `javascript:`, `data:` and custom schemes, and links back to the local backend, are dropped.
  Attachments are fetched and saved in the renderer instead of opened in a window

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

Code: [[packaging/electron/backup/bundle.ts]]

### Content-Length Response Cap on External Fetches (June 2026)

The backend's `_assertResponseWithinCap()` helper enforces a **5 MB** per-response limit on external HTTP calls. This prevents a misbehaving or compromised price provider from streaming arbitrarily large payloads into memory.

**Coverage:**

- Binance price/history fetches — explicitly capped
- Kinesis trendline fetches — explicitly capped
- Yahoo Finance — uses `yahoo-finance2` npm library; the library controls response handling, so no `Response` object is available for direct capping. Rate-limiting still applies.

> [!info] External currency/inflation endpoints (ECB, open.er-api, Statbel, Eurostat) have their own timeout guards and are separate from the price-provider fetch path.

Code: [[apps/node-backend/src/services/prices/priceProviderRegistry.ts]]

---

### Loopback-only boundary: bind gate, Host guard and CSRF guard (2026-10-20)

The API has no per-request authentication. Its boundary is the machine, enforced by three checks
([[docs/adr/233-loopback-only-backend|ADR-233]], superseding the admin token of
[[docs/adr/063-admin-auth-csrf-guard|ADR-063]]):

**Bind gate (`main.ts` `start()`)** — the backend exits before listening when `SERVER_HOST` is not
loopback (`127.0.0.0/8`, `::1`, `localhost`; `isLoopbackHost()` in `hostGuard.ts`). There is no
override. The packaged and development runtimes bind `127.0.0.1`.

**[[apps/node-backend/src/middleware/hostGuard.ts|Host guard]]** — mounted directly after the
request id, before body parsing, health checks, static files and routes. The `Host` header must
name `localhost`, `127.0.0.1` or `::1` (or the loopback bind address when spelled differently)
with the backend's own port. IP spellings are canonicalized first (`127.1`, `0x7f000001` and
`[0:0:0:0:0:0:0:1]` match). Missing, malformed or foreign Host values, including a DNS-rebinding
hostname, receive 403. `X-Forwarded-Host`, Origin and fetch metadata cannot bypass it.

**`csrfGuard.ts` — `createCsrfGuard`** — blocks cross-site browser requests of every method across
`/api` ([[docs/adr/237-cross-site-guard-for-every-method|ADR-237]]). `/health` and SPA navigations
are outside it. Strategy (zero-config, no tokens/cookies):

- `Sec-Fetch-Site` header (sent by Chrome 76+, Firefox 90+, Safari 16.4+) is authoritative:
  - `same-origin` or `none` (typed URL, curl, Electron IPC): allow.
  - `same-site` or `cross-site`: reject with 403.
- Fallback when `Sec-Fetch-Site` is absent: a present `Origin` must be one of the backend's own
  loopback origins (`http://localhost:PORT`, `http://127.0.0.1:PORT`, `http://[::1]:PORT`), plus
  the Vite dev server's loopback origins on port 8080 outside production (`loopbackOrigins()`).
  An absent `Origin` is treated as a non-browser client and allowed.

Mount order in `main.ts`:

```
app.use(createHostGuard({ bindHost, port }));   // first, after requestId
app.use("/api", globalRateLimiter);
app.use("/api", csrfGuard);
mountRouter(app, '/api/admin', adminRateLimiter, adminCsrfGuard, adminRouter);
```

> [!note] Cross-site GET requests
> Since ADR-237 the guard also blocks cross-site `GET`, `HEAD` and `OPTIONS`, so a cross-site page
> can no longer run aggregations, provider calls or timing probes through the API.

Code links: [[apps/node-backend/src/middleware/hostGuard.ts]], [[apps/node-backend/src/middleware/csrfGuard.ts]]

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

## No tamper-evident change history (2026-10-20)

Vision does not record a tamper-evident change history and makes no tamper-detection claim.
[[docs/adr/231-remove-audit-history|ADR-231]] removed the September 2026 audit-history feature:
the PostgreSQL hash chain, the Electron HMAC receipt under `audit-anchor/`, the macOS Keychain
witness and its helper, the private loopback bridge (`/api/internal/audit/*` with
`VISION_AUDIT_BRIDGE_TOKEN`), enrollment, device transfer, key rotation, one-year retention and the
Admin audit view. The owner judged that protection unrealistic on a single-user Mac: a person who
can rewrite the database and application data there can usually also change the Keychain item or
the application code.

Migration 0004 drops the chain tables and the plain change tables `db_editor_audit`, `split_audit`
and `portfolio_retag_audit`; their rows survive only in backups taken before the update. The
database editor writes one structured log line per committed change (table, operation and primary
key, not row contents) and no longer refuses any table with `403`. Split routes ignore `x-actor`.
Restore no longer compares a receipt or warns about audit continuity, and updates are no longer
recorded or gated by a bridge; the update checksum check remains.

On launch, once the database records migration `0004_remove_audit_history`
([[docs/adr/242-backup-before-boot-migrations|ADR-242]]),
`packaging/electron/legacy-audit-cleanup.ts` deletes the leftover `audit-anchor/`
folder (receipt, `safeStorage`-encrypted HMAC key and any transfer journal) and the Keychain item
(service `com.vaultvoyager.vision.audit-witness` or `com.vaultvoyager.vision-demo.audit-witness`,
account `latest-checkpoint`). The folder path is resolved strictly inside `userData`; a symbolic
link is unlinked without following it. The Keychain delete runs `/usr/bin/security` with an
argument array and no shell, and is attempted once; a refused macOS prompt leaves a harmless item
the user can delete in Keychain Access. A `.vat` transfer file saved elsewhere still contains the
old audit key together with its password protection; it protects nothing now and can be deleted.

## Backup Encryption (Phase 2 + v2 Upgrade 2026-04-28)

Encrypted backup restore (`.visionbak.enc`) is fully implemented with passphrase-modal UX and upgraded v2 AEAD encryption:

### Format v1 (Retired, AES-256-CBC)

- **Encryption**: AES-256-CBC with a static salt (hardcoded, same across all v1 backups)
- **KDF**: Scrypt(N=2^14, r=8, p=1) from user passphrase
- **Confidentiality**: ✅ Provided | **Authenticity**: ❌ Not provided
- **Status**: Retired on 2026-10-19 by [[docs/adr/219-minimal-electron-shell-hardening|ADR-219]].
  Not written since 2026-04-28 and no longer restored: a file starting with `VISIONENC1` or
  `VISIONBAK1` is refused with "This backup uses the retired v1 encryption format, which Vision no
  longer restores." before any decryption, and no plaintext is written. To recover such a file,
  restore it with an older Vision release and create a new backup.

### Format v2 (Current, AES-256-GCM with Per-Backup Salt)

- **Encryption**: AES-256-GCM (AEAD — Authenticated Encryption with Associated Data)
- **Salt**: Random 16 bytes per backup (generated at encryption time)
- **IV**: Random 12 bytes per backup (GCM standard)
- **KDF**: Scrypt(N=2^15, r=8, p=1) — doubled iteration count for stronger brute-force resistance
- **Auth Tag**: 16 bytes appended; tampering detected immediately on decryption
- **Confidentiality**: ✅ Provided | **Authenticity**: ✅ Provided | **Per-backup Entropy**: ✅ Yes
- **Status**: Default for new backups as of 2026-04-28; see [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]] for full rationale

### Lazy safeStorage Access (May 2026)

For backup passphrase handling, `safeStorage` is accessed only when a passphrase blob is present in `settings.json`. Backup passphrase handling is the only `safeStorage` user since the audit anchor was removed (ADR-231):

- **`getBackupPassphrase()`** — reads the stored `backupPassphraseEncrypted` blob first. If absent (and `VISION_BACKUP_PASSPHRASE` env var is not set), returns without calling any `safeStorage` API. This avoids backup-passphrase Keychain prompts for users who have not configured backup encryption.
- **`getBackupPassphraseStatus()`** — reports `secureStorageAvailable` from the API object's presence alone (no keychain probe) when no passphrase is stored. The actual availability check is deferred to `setBackupPassphrase()` at opt-in time.

Users who do store a passphrase may still see macOS Keychain prompts on unsigned builds (macOS re-challenges an unstable code identity). The `VISION_BACKUP_PASSPHRASE` environment variable bypasses `safeStorage` entirely as an escape hatch.

### Restore Process

- **Passphrase modal**: When restoring an encrypted backup, users are prompted via modal to enter the passphrase before decryption attempts
- **Magic header detection**: Backup encryption is detected via file magic header (`VISIONENC2`/`VISIONBAK2`, or the retired `VISIONENC1`/`VISIONBAK1`) without decryption
- **v2 only**: Restore decrypts only v2; a retired v1 file is recognised as encrypted, so the passphrase prompt still appears, and is then refused by name
- **Fallback sources**: Restore respects `VISION_BACKUP_PASSPHRASE` env var and OS keychain (Electron safeStorage) as fallback if no modal input provided
- **Error recovery**: Wrong passphrase shows clear error message and allows retry (up to 3 attempts typical)
- **Path validation**: File path must have been returned by prior `backup:select-file` dialog; prevents XSS-in-renderer from passing arbitrary paths
- **No breaking changes**: Unencrypted backups (`.visionbak`) restore without prompting; v2 backups decrypt with their passphrases unchanged. Retired v1 encrypted backups are refused (ADR-219)

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
migration-package versions are unavailable. Locked Bun dependencies, PostgreSQL 18.6
validation, payload hashing, and post-build code-signature checks protect the generated
application resources. Report PDFs print with Electron's own Chromium; no separate browser is
bundled (ADR-234).

The installed application starts only its private loopback PostgreSQL cluster.

---

## Future Security Roadmap

| Feature            | Status  | Description                                                                                                                         |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | Planned | Multi-user support with auth                                                                                                        |
| Encryption at rest | Planned | Database encryption (would subsume the plaintext `provider_api_keys` risk accepted above)                                           |
| API authentication | Planned | Token-based API auth                                                                                                                |
| Audit logging      | Removed | The tamper-evident audit chain and change tables were removed by ADR-231 (migration 0004); database-editor changes are logged only. |

---

## Related

- [[docs/adr/063-admin-auth-csrf-guard|ADR-063: Admin Auth Token-or-Open + CSRF Guard]] — Current admin auth model (supersedes ADR-037)
- [[docs/adr/037-admin-auth-localhost-fallback|ADR-037: Admin Auth Localhost Fallback]] — Superseded RFC1918 IP-allowlist model
- [[docs/adr/050-ci-supply-chain-security-tooling|ADR-050: CI Supply Chain Security Tooling]] — Historical decision; current filesystem scanning is described in the CI/CD guide
- [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049: Phase 6.1–7 Bug Hunt Recovery Hardening]] — Database schema fixes, Electron backup/restore safety
- [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040: Backup Format v2 AEAD Encryption]] — Backup encryption scheme (v1 legacy, v2 current)
- [[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042: CodeQL + Dependabot Remediation]] — CORS fix, rate limiters, input validation improvements
- [[docs/adr/233-loopback-only-backend|ADR-233: Loopback-only backend]] — bind gate, fixed Host allowlist, no CORS, no admin token
- [[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]] — Security job documentation and setup
- [[docs/security/index]] — Security documentation index
- [[docs/security/input-validation]] — Input validation details
- [[docs/security/rate-limiting]] — Rate limiting details
- [[docs/architecture/electron]] — Electron architecture with Phase 7 restore hardening
