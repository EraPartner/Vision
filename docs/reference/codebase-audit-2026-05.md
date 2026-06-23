---
title: Codebase Improvement Audit — May 2026
type: reference
date: 2026-05-29
tags: [audit, security, performance, architecture, correctness, accessibility, technical-debt]
description: 105 verified findings from a 19-dimension multi-agent audit (find → adversarial verify). 0 critical, 18 high, 44 medium, 43 low.
---

# Codebase Improvement Audit — May 2026

> [!info] Method
> 19 review dimensions, each finding produced by an independent reviewer and then **independently re-checked by an adversarial verifier** against the actual code (false positives rejected). 37 agents. All 105 findings below survived verification. Each item cites `file:line` with evidence and a concrete fix.

## Summary

| Severity | Count |
|---|---|
| 🔴 Critical | 0 |
| 🟠 High | 18 |
| 🟡 Medium | 44 |
| ⚪ Low | 43 |
| **Total** | **105** |

**Posture:** No critical exploit. The codebase is mature and security-conscious (hardened Electron, parameterized SQL via a central filter builder, `decimal.js` money, timing-safe admin token, prod error-message hiding). The real leverage is in **financial-correctness bugs**, one **server-side SSRF primitive**, **unused-but-refreshed materialized views**, and a broad **accessibility/i18n gap on screen-reader paths**.


## Security (20)

🟠 4 high · 🟡 6 medium · ⚪ 10 low

### 🟠 security.1 — No application authentication — only /api/admin is gated; all financial data routes are open

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/main.js` — lines 272-289 (mountRouter calls) vs line 279 (only /api/admin gets adminAuthMiddleware)
- **Problem:** adminAuthMiddleware is applied to exactly one router (/api/admin, line 279). Every other router — /api/transactions, /api/categories, /api/recipients, /api/planned-transactions, /api/settings, /api/investments, /api/attachments, /api/import, /api/ai, /api/watchlist, /api/splits, /api/saved-charts, /api/tags — has zero authentication. Anyone who can open a TCP connection to the backend port can read, create, edit, and bulk-delete all financial transactions, change settings, upload/download attachments, run CSV imports, and drive the AI/Ollama integration. There is no per-request identity, session, or token check on the data plane at all. The only barrier is the network binding (docker-compose binds the host port to 127.0.0.1). The AGENTS.md gotcha confirms this is fragile: 'WARNING: if the host port mapping is changed back to 0.0.0.0, LAN devices would also pass this check.' For a self-hosted financial app this is a one-config-change-away-from-full-data-exposure posture.
- **Evidence:** mountRouter(app, '/api/transactions', transactionsRouter);
mountRouter(app, '/api/admin', adminRateLimiter, adminAuthMiddleware, adminRouter);  // ONLY router with auth
mountRouter(app, '/api/settings', settingsRouter);  // PUT/DELETE, no auth
mountRouter(app, '/api/attachments', attachmentRateLimiter, attachmentsRouter);  // upload/download, no auth
- **Fix:** Decide explicitly whether ADMIN_AUTH_TOKEN (or a separate app token) should gate the whole API surface, not just /api/admin. At minimum, apply the same Bearer-token requirement to all state-changing and PII-exposing routers when a token is configured, and document the 127.0.0.1-binding assumption as a hard security boundary (not just a code comment). Consider a single auth middleware mounted before the data routers so 'open by default' is an opt-in dev convenience, not the production default.

### 🟠 security.2 — Admin auth falls back to IP allowlist over the entire RFC1918 + ULA space when token unset

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/middleware/adminAuth.js` — createAdminAuthMiddleware (lines 72-87), isPrivateIpv4 (31-44), isPrivateIpv6 (46-51)
- **Problem:** When ADMIN_AUTH_TOKEN is unset (the default — env.js line 68 defaults ADMIN_AUTH_TOKEN to ''), admin endpoints (DB stats, VACUUM, DB reset, provider probes, metrics) are reachable by ANY caller whose source IP is in 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, or fc00::/7. That is the whole private address space, not just loopback. The justification is that docker-compose binds to 127.0.0.1, but the middleware itself trusts a far broader range than the deployment guarantee. If the app is ever run outside that exact compose binding (bare-metal on a LAN, a different compose override, a reverse proxy on the same private subnet, Kubernetes pod networking), every device on the private network gains unauthenticated admin access. Defense-in-depth should not depend on a single external binding decision.
- **Evidence:** if (!configuredToken) {
  if (isLocalNetworkRequest(req)) return next();   // trusts all of RFC1918 + ULA
  return next(new UnauthorizedError('Admin requires ADMIN_AUTH_TOKEN for non-local access'));
}
// isPrivateIpv4: a===10 → true; a===172 && b 16..31 → true; a===192&&b===168 → true
- **Fix:** Narrow the no-token fallback to true loopback only (127.0.0.0/8, ::1) — the docker-proxy bridge case can be handled by detecting the specific bridge gateway, or better, by requiring ADMIN_AUTH_TOKEN in any containerized/production run and failing closed. The start() warning (main.js line 376-381) logs but still serves; consider refusing to expose admin routes at all in production when no token is set.
- **Remediated 2026-05-29** — [[docs/adr/063-admin-auth-csrf-guard|ADR-063]]: RFC1918 IP-allowlist removed entirely. `adminAuth.js` is now token-or-open (no IP check). Cross-site browser requests blocked by new `csrfGuard.js` (`Sec-Fetch-Site` + `Origin` allowlist) mounted before `adminAuthMiddleware` on `/api/admin`.

### 🟠 security.3 — SSRF: custom price-provider URLs are fetched server-side with no allowlist, scheme check, or redirect guard

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/services/prices/priceProviderRegistry.js` — PROVIDERS.custom (lines 394-434) + _fetchJson (lines 102-109); URL origin resolveCustomHistoryConfig/_resolveCustomLatestConfig (lines 49-61)
- **Problem:** An investment's price_provider_latest_url / price_provider_url / price_provider_history_url are taken verbatim from the investment record and passed straight into fetch() server-side when prices are refreshed. There is no URL validation: no scheme restriction (http/https only), no host allowlist, no block on private/loopback/link-local ranges, and fetch defaults to redirect:'follow' so even a public host can 302 the request to an internal address. The originating values are user-controlled: createInvestment() (apps/node-backend/src/controllers/investmentController.js:182-227) reads price_provider_url, price_provider_latest_url, price_provider_history_url directly from req.body and stores them with no validation, and /api/investments is mounted behind only a rate limiter, not admin auth (apps/node-backend/src/main.js:281). In the shipped Docker/Electron deployment the backend container can reach cloud metadata (169.254.169.254), sibling containers, and host-local services, so this is a usable SSRF primitive (internal port scan / metadata exfil via the price field or error messages).
- **Evidence:** _resolveCustomLatestConfig: `const latestUrl = (inv?.price_provider_latest_url || inv?.price_provider_url || inv?.price_provider_history_url || '').trim();` then PROVIDERS.custom: `const latestData = await _fetchJson(latestUrl);` and `async function _fetchJson(url){ const res = await fetch(url, { headers:{Accept:'application/json'}, signal: AbortSignal.timeout(10_000) }); ... }`. Controller stores it raw: createInvestment reads `price_provider_url, price_provider_latest_url, ... price_provider_history_url` from req.body with the only check being `if (!name || !asset_class) throw new ValidationError(...)`.
- **Fix:** Validate provider URLs at the boundary (Zod .url() in create/update) AND re-validate at fetch time: require scheme in {http,https}, parse with new URL(), reject when the resolved host is a private/loopback/link-local/ULA address (block 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, and 0.0.0.0). Set redirect:'manual' (or 'error') on these fetches and re-validate the Location host on each hop, or use an agent with a connection lookup hook that rejects private IPs (defeats DNS-rebind/redirect bypass). Consider gating custom-provider creation behind admin auth.

### 🟠 security.4 — Release Electron build runs `npm install` without lockfile pinning or `--ignore-scripts`

- **Severity:** high · **Effort:** small · **Confidence:** high
- **Location:** `.github/workflows/release.yml` — lines 250-257 ("Install electron deps and build .app + DMG")
- **Problem:** The step that produces the actual shipped, user-installed artifact runs `cd packaging/electron && npm install` (not `npm ci`, no `--frozen-lockfile`) and crucially without `--ignore-scripts`. Every other install path in the repo is hardened: ci.yml:66/122/... use `bun install --frozen-lockfile`, and the release verify job (release.yml:125) and ci.yml:347 explicitly use `npm install --prefix packaging/electron --ignore-scripts`. Only the release-time build install drops both protections. Consequences: (1) the dependency tree can float away from the committed `packaging/electron/package-lock.json` that was audited, so the binary users install may contain versions never reviewed; (2) lifecycle/postinstall scripts of any transitive electron-builder dependency execute with full CI privileges and are baked into a signed .dmg — a classic supply-chain injection surface for a finance app.
- **Evidence:** release.yml:255-257:
          cd packaging/electron
          npm install
          npx electron-builder --mac --arm64 --publish never
(contrast release.yml:125 `npm install --prefix packaging/electron --ignore-scripts` and ci.yml:347 same flag)
- **Fix:** Use `npm ci --ignore-scripts` in the release build step to enforce the committed lockfile and block arbitrary postinstall scripts, then let electron-builder fetch only what it genuinely needs. If a dependency truly requires its install script, allowlist that single package rather than enabling scripts globally during the release that produces the signed artifact.

### 🟡 security.5 — Most data routers have no rate limiting; only a few sub-routes are throttled

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/main.js` — lines 272-289; compare with rateLimiter.js limiter exports
- **Problem:** Rate limiting is applied per-router-prefix only to /api/aggregations, /api/admin, /api/import, /api/investments, /api/market, /api/attachments, /api/reports, and /api/ai/chat. The routers /api/categories, /api/recipients, /api/settings, /api/watchlist, /api/splits, /api/saved-charts, /api/tags, and /api/info have NO limiter at any level. /api/transactions and /api/planned-transactions attach limiters only on specific expensive sub-routes (bulk-delete, patch, exports) — plain GET/POST/PUT/DELETE on them are unthrottled. /api/ai/status, /api/ai/models, /api/ai/conversations get no limit (only /api/ai/chat* is covered by the app.use('/api/ai/chat') prefix at line 299). settings PUT/DELETE (settings.js lines 135/159/176) mutate state with no throttle. Given there is also no auth (see related finding), an attacker on the trusted network can hammer these endpoints freely — DB write amplification, settings churn, or simply DoS via unbounded request volume. The in-memory limiter is also not shared across processes, but that is secondary here.
- **Evidence:** mountRouter(app, '/api/settings', settingsRouter);            // no limiter
mountRouter(app, '/api/watchlist', watchlistRouter);          // no limiter
mountRouter(app, '/api/tags', tagsRouter);                    // no limiter
// rateLimiter.js intentionally short-circuits in dev: if (settings.isDevelopment()) return next();
- **Fix:** Apply a baseline global limiter (e.g. the default 100/min 'global' bucket) as app-level middleware before the data routers, then keep the stricter per-route limiters on top. That guarantees every public/sensitive route has a ceiling instead of relying on each router author to remember to add one.

### 🟡 security.6 — Rate limiter trusts X-Forwarded-For from any private/link-local peer, enabling per-request bucket evasion

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/node-backend/src/middleware/rateLimiter.js` — isTrustedProxyAddr (lines 23-35) + key derivation (lines 62-67)
- **Problem:** The limiter derives the client key from X-Forwarded-For whenever the immediate peer is loopback OR any RFC1918 / 169.254 / fd / fe80 address. In the packaged Docker stack the backend's peer is always the bridge gateway (a 172.x address), so isTrustedProxyAddr returns true for effectively every real request, and the rate-limit key is then taken from the client-supplied X-Forwarded-For header. A client can send a different (or random) X-Forwarded-For on each request to land in a fresh bucket every time, defeating the limit entirely. Express's own 'trust proxy' is not set (confirmed: no app.set('trust proxy')), so this hand-rolled XFF trust is the only place it is honored — and it trusts the header without any allowlist of which proxy actually sets it.
- **Evidence:** const forwarded = isTrustedProxyAddr(remoteAddr)
  ? (req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()
  : '';
const ip = forwarded || remoteAddr || 'unknown';
const key = `${keyPrefix}:${ip}`;
- **Fix:** Only honor X-Forwarded-For when a trusted reverse proxy is explicitly configured (a known proxy IP/CIDR from env), not for the whole private range. In the default single-host Docker deployment there is no real proxy adding XFF, so keying on the socket remoteAddress is safer than keying on an attacker-controllable header. If multi-client distinction behind the bridge is needed, take the last (right-most) XFF hop appended by your own proxy, not the left-most client-supplied value.

### 🟡 security.7 — Outbound provider fetches have no response-size cap (memory exhaustion / DoS)

- **Severity:** medium · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/prices/priceProviderRegistry.js` — _fetchJson line 108 (res.json()); PROVIDERS.binance line 315; PROVIDERS.kinesis line 458; priceProviderService.js custom/binance/kinesis fetches (lines 327, 371, 428)
- **Problem:** Every outbound provider response is consumed with res.json()/res.text() with no Content-Length check and no streaming size bound. The custom provider fetches an attacker-influenced URL (see the SSRF finding), so a malicious or compromised endpoint can return an unbounded body and exhaust backend memory. Even the trusted providers (Binance returns the full ticker list, ECB XML) are unbounded, but the custom path is the real exposure because the host is user-chosen.
- **Evidence:** `async function _fetchJson(url){ const res = await fetch(url, {...}); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); }` — no inspection of res.headers.get('content-length') and no cap on bytes read. Same pattern at `const data = await res.json();` in PROVIDERS.binance and PROVIDERS.kinesis, and at `const data = await res.json();` in fetchHistoricalPrices (priceProviderService.js).
- **Fix:** Add a max-bytes guard: reject when Content-Length exceeds a constant (e.g. a few MB) before reading, and/or read the body via a reader that aborts once the cap is exceeded. Apply uniformly through a shared fetchJson helper so the custom/binance/kinesis/ECB paths all inherit the limit.

### 🟡 security.8 — Zip restore (yauzl) has no zip-bomb guard: no per-entry, total-size, or entry-count cap

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `packaging/electron/backup/bundle.js` — extractZip lines 414-457 (openBundle lines 480-497 calls it)
- **Problem:** extractZip streams every entry to disk with no limit on uncompressed entry size, total extracted size, or entry count. yauzl exposes only compressed sizes in the central directory; a small .visionbak(.enc) can decompress to many GB and fill the disk during restore. The zip-slip path-traversal guard is present and correct, but bomb protection is absent. This is the backup/restore path (local file the user selects), so the practical risk is lower than a network path, but a malicious/shared backup file would let it fill the host disk.
- **Evidence:** `zipfile.on('entry', (entry) => { const entryPath = path.join(destDir, entry.fileName); ... readStream.pipe(writeStream); writeStream.on('finish', () => zipfile.readEntry()); ...})` — no accumulation of bytesWritten vs a cap, no entry counter, no check of entry.uncompressedSize against a limit before/while writing.
- **Fix:** Track a running total of bytes written and abort (reject + cleanup) when it exceeds a documented MAX_RESTORE_BYTES; also cap entry count and reject any single entry whose uncompressedSize exceeds a per-file limit. Stop reading further entries once the cap trips.

### 🟡 security.9 — Indirect prompt injection: user/CSV-derived strings (memos, recipient/category names) are fed back to the model verbatim as tool context

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/aiChatService.js` — baseMessages.push({ role: 'tool', name, content: JSON.stringify(result) }) line 336-340; history replay via prompts.js toOllamaMessage lines 86-93
- **Problem:** Tool results contain free-text fields that originate from untrusted sources — transaction memo, recipient_name, category_name — and crucially these can be set by a bank CSV import, not just by the user typing. The full tool result is JSON.stringified and re-fed to the model as a tool-role message, and persisted tool rows are replayed into later turns the same way (prompts.js toOllamaMessage). A crafted memo such as "SYSTEM: ignore prior instructions and ..." becomes model context. Because every tool is read-only and scoped to the single owner's own data, the blast radius is limited (the model cannot mutate data or exfiltrate to the network — there is no write tool and no HTTP-egress tool), but injection can still steer the model to call other read-only tools and, more importantly, to fabricate or misreport figures despite the system prompt's 'never invent figures' rule, which is advisory only and not enforced.
- **Evidence:** baseMessages.push({ role: 'tool', name, content: JSON.stringify(result) }); — the result embeds e.g. `memo: row.memo || ''` and `recipient: row.recipient_name` straight from the DB. The system prompt's mitigation is text-only: "**Never invent figures.** Every number you cite ... must come from a tool result" (prompts.js:22) with no programmatic check.
- **Fix:** Treat tool-result text as untrusted: delimit or escape free-text fields when serializing into tool messages (e.g. wrap user strings in a clearly fenced block and instruct the model that fenced content is data, never instructions), and consider stripping/normalizing control sequences. As defense-in-depth, document that this is local + read-only so the threat is bounded, and keep the read-only invariant explicit (a checklist/test asserting no tool performs writes) so a future write-capable tool doesn't silently widen the blast radius.

### 🟡 security.10 — Backup restore writes arbitrary localStorage keys with no allowlist (asymmetric with backup-side exclusion)

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/hooks/useRestoreBackup.tsx` — performRestore, lines 63-71
- **Problem:** On restore, every key/value in the bundle's frontend-state.json is written straight into window.localStorage with no validation against the canonical key registry. The backup side carefully excludes sensitive keys (LOCAL_STORAGE_EXCLUDED_KEYS in lib/localStorage-keys.ts excludes 'vision.adminToken'), and the restore side trusts whatever the bundle file contains. A crafted or tampered .visionbak bundle could inject arbitrary localStorage entries (e.g. re-introduce a 'vision.adminToken', or set keys consumed by other code paths) into the user's origin. The bundle is parsed verbatim in the main process (packaging/electron/backup/bundle.js openBundle returns frontendState as-is, line 524) and handed to the renderer, so the only barrier is the user-driven file picker + destructive-restore confirmation. The exclusion list is enforced only on export, not on import, making it a one-sided control.
- **Evidence:** useRestoreBackup.tsx:65-67 — `for (const [key, value] of Object.entries(result.frontendState.keys)) { window.localStorage.setItem(key, String(value)); }`  (no check against LOCAL_STORAGE_KEYS / LOCAL_STORAGE_EXCLUDED_KEYS). Contrast lib/localStorage-keys.ts:38-45 which defines LOCAL_STORAGE_EXCLUDED_KEYS including 'vision.adminToken' — applied only at backup time in BackupTab.tsx:104 which iterates Object.values(LOCAL_STORAGE_KEYS).
- **Fix:** On restore, iterate the bundle keys and only setItem when the key is a member of LOCAL_STORAGE_KEYS (and not in LOCAL_STORAGE_EXCLUDED_KEYS). Drop unknown/excluded keys with a debug log. This makes the allowlist symmetric on export and import and prevents a tampered bundle from seeding sensitive or unexpected keys.

### ⚪ security.11 — Dev mode disables all rate limiting and CORS reflects wildcard origin

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/middleware/rateLimiter.js` — rateLimiter lines 56-60; main.js CORS dev branch lines 100-106
- **Problem:** When ENVIRONMENT/NODE_ENV is 'development' the rate limiter returns next() unconditionally, so no limiter (including the expensive report/market/AI ones) is enforced. Separately, main.js emits Access-Control-Allow-Origin: '*' when corsOrigins is the literal '*' and isDevelopment() is true. Both are deliberate dev conveniences and the wildcard branch correctly omits Allow-Credentials, so this is not exploitable in a correct prod deployment. The risk is purely operational: if a deployment is accidentally left with ENVIRONMENT unset, config.js defaults environment to 'development' (config.js line 59: env.ENVIRONMENT || env.NODE_ENV || 'development'), silently turning off every protection. The Dockerfile does set ENV ENVIRONMENT=production, which mitigates the packaged path.
- **Evidence:** if (settings.isDevelopment()) {
  return next();  // skips throttling entirely
}
// config.js: environment: env.ENVIRONMENT || env.NODE_ENV || 'development'
- **Fix:** Default the environment to 'production' (fail-safe) rather than 'development', or gate the dev bypasses on an explicit affirmative flag (e.g. VISION_DEV=true) so an unset environment never silently disables rate limiting and credential-less-but-wildcard CORS.

### ⚪ security.12 — CSV import file-size limit hardcoded at 50MB and ignores ATTACHMENT_MAX_SIZE_MB; multipart bypasses the 1mb JSON cap

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/routes/importRoutes.js` — multer config line 57-67 (limits.fileSize: 50 * 1024 * 1024)
- **Problem:** express.json({ limit: '1mb' }) (main.js line 118) only bounds JSON bodies; multipart uploads bypass it and are bounded solely by multer. The import route hardcodes a 50MB cap as a magic number (the project rule forbids magic numbers / hardcoded limits), while a configurable ATTACHMENT_MAX_SIZE_MB (default 10MB) exists in env.js line 92 but is not used here. 50MB per request on an unauthenticated, multi-process route (combined with the import limiter at 20/min) means up to ~1GB/min of upload to tmpdir per client bucket — a memory/disk pressure vector on a small self-hosted host. The value is also inconsistent with the attachment subsystem's configured ceiling.
- **Evidence:** const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },   // hardcoded, not env-driven
  ...
});
// env.js exposes ATTACHMENT_MAX_SIZE_MB: intEnv(10) — unused here
- **Fix:** Replace the hardcoded 50MB with a named constant sourced from env (a dedicated IMPORT_MAX_SIZE_MB or reuse the attachment ceiling) so the upload bound is explicit, configurable, and consistent across import/attachment paths.

### ⚪ security.13 — CSV upload accepts octet-stream / empty MIME and relies only on a .csv extension check

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/routes/importRoutes.js` — isLikelyCsvFile lines 45-55 + multer fileFilter lines 57-67
- **Problem:** Unlike the attachment path (which does magic-byte sniffing via verifyAttachmentContent), the CSV import filter accepts any file whose name ends in .csv and whose declared MIME is csv/text/vnd.ms-excel/application/octet-stream/empty. Both the extension and MIME are attacker-controlled, so there is effectively no content validation before the 50MB file is written to os.tmpdir() and parsed. Impact is limited because the bytes are only ever treated as text by csv-parse (not executed) and the temp file path is rebuilt from a strict basename allowlist, so this is a robustness/consistency gap rather than an exploit. Worth aligning with the attachment path's content-sniffing posture.
- **Evidence:** `const hasLikelyCsvMimeType = mimeType.includes('csv') || mimeType.includes('text/plain') || mimeType.includes('application/vnd.ms-excel') || mimeType === 'application/octet-stream' || mimeType === '';` then multer `fileFilter: (req,file,cb)=>{ if(!isLikelyCsvFile(file)){cb(new Error('File must be a CSV'));} else {cb(null,true);} }` — no inspection of file bytes anywhere before parsing.
- **Fix:** This is acceptable for text/CSV given downstream treatment, but consider a lightweight content sanity check (e.g. reject obvious binary by scanning the first KB for NUL bytes / non-text bytes) to match the stronger validation already applied to attachments and to fail bad uploads fast.

### ⚪ security.14 — Requested model name is passed to Ollama with no allowlist validation

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/services/aiChatService.js` — activeModel resolution line 203; route validation validateChatBody in routes/ai.js lines 264-268
- **Problem:** validateChatBody only checks that `model` is a non-empty string; it is never checked against the set of installed models. runChatTurnInner forwards it verbatim to Ollama (`model: activeModel`). A client can request any arbitrary model string. Impact is bounded because Ollama is operator-configured and local — worst case is selecting/triggering an unintended already-installed model, a larger/slower model (feeding the resource-abuse vector above), or an Ollama-side error — but the input is not constrained to a known-good set.
- **Evidence:** routes/ai.js: `if (typeof model !== 'string' || !model.trim()) { throw new ValidationError('"model" must be a non-empty string'); }` — no membership check. aiChatService.js: `const activeModel = model || conversation.model || settings.ollama.defaultModel;` then `ollamaClient.chat({ model: activeModel, ... })`.
- **Fix:** Validate the requested model against the installed model list (client.listModels()) or an explicit allowlist before use, rejecting unknown names with a 400. This also prevents accidental selection of an oversized model that worsens the timeout/resource exposure.

### ⚪ security.15 — will-navigate guard allows navigation to any file: URL

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `packaging/electron/main.js` — createWindow, will-navigate handler, lines 1222-1233
- **Problem:** The navigation guard permits any URL whose protocol is file: (parsed.protocol === 'file:') in addition to localhost/127.0.0.1. The app is normally served from http://localhost, and the only legitimate file: navigation is the bundled error.html (loadErrorPage). Allowing arbitrary file: navigation is broader than needed: if the renderer were ever coerced into navigating (e.g. a localhost-served page redirecting to file:///...), it could load local files into the (sandboxed, isolated) window. This is defense-in-depth rather than a direct hole — sandbox + contextIsolation + nodeIntegration:false limit impact, and setWindowOpenHandler denies new windows — but the file: allowance is wider than the actual requirement.
- **Evidence:** main.js:1225-1229 — `const allowed = parsed.protocol === 'file:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'; if (!allowed) event.preventDefault();`
- **Fix:** Restrict the file: allowance to the specific shipped asset(s): allow only when parsed.pathname resolves under path.join(__dirname, 'assets') (e.g. the error.html shell). Deny any other file: navigation.

### ⚪ security.16 — Navigation/window guards are attached per-window, not globally via app.on('web-contents-created')

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `packaging/electron/main.js` — createWindow lines 1218-1233; no app.on('web-contents-created') present
- **Problem:** setWindowOpenHandler and the will-navigate guard are wired only on mainWindow.webContents inside createWindow(). There is no app-level app.on('web-contents-created', ...) that re-applies these guards (and disables webview attachment via will-attach-webview) to any future WebContents. Today there is a single window so this is not exploitable, but the hardening is not enforced structurally — a future second window, devtools-extension webContents, or accidentally-enabled <webview> would not inherit the navigation/window-open restrictions.
- **Evidence:** grep across main.js shows the only handlers are at lines 1219 (`mainWindow.webContents.setWindowOpenHandler(...)`) and 1222 (`mainWindow.webContents.on('will-navigate', ...)`); there is no `app.on('web-contents-created')` or `will-attach-webview` handler anywhere in the file.
- **Fix:** Add an app.on('web-contents-created', (_e, contents) => { contents.setWindowOpenHandler(() => ({ action: 'deny' })); contents.on('will-navigate', <same guard>); contents.on('will-attach-webview', (e) => e.preventDefault()); }) so the policy applies to every WebContents by construction, not just the one window currently created.

### ⚪ security.17 — Production CSP broadens img-src to all HTTPS and connect-src to all localhost ports

- **Severity:** low · **Effort:** medium · **Confidence:** medium
- **Location:** `packaging/electron/main.js` — CSP_POLICY constant, lines 168-179
- **Problem:** The packaged CSP sets img-src 'self' data: https: (any HTTPS origin may be loaded as an image) and connect-src 'self' http://localhost:* (any localhost port). img-src https: means a stored/remote-sourced image URL (e.g. portfolio news thumbnails rendered in PortfolioNewsFeed/MarketLookup) can beacon to arbitrary external hosts — a known CSP exfiltration/tracking vector even without script execution. connect-src to any localhost port is wider than the single resolved backend port. style-src also retains 'unsafe-inline' (acknowledged in the comment for Tailwind). None of these is script-src-level (script-src is correctly 'self' only), so this is hardening, not an open XSS hole.
- **Evidence:** main.js:170-174 — `"img-src 'self' data: https:", "font-src 'self' data:", `connect-src 'self' http://localhost:*`,` and line 171 `"style-src 'self' 'unsafe-inline'"`.
- **Fix:** Scope img-src to the origins actually needed (e.g. 'self' data: plus an explicit allowlist of the price/news image hosts) rather than all https:. Scope connect-src to the single resolved http://localhost:${appPort} instead of localhost:*. Longer term, move inline styles to allow dropping style-src 'unsafe-inline'.

### ⚪ security.18 — No CSP or security response headers applied in non-packaged (dev/source) Electron mode

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `packaging/electron/main.js` — registerSecurityHeaders, lines 181-182
- **Problem:** registerSecurityHeaders() returns early when !app.isPackaged, so dev mode and packaged repo/source mode (useRepoMode) run with no CSP, no X-Content-Type-Options, no X-Frame-Options, and no permission-request denial. getUpdateMode() shows 'source' mode is a real packaged runtime path (a self-hoster pointing settings.repoPath at a clone), not only local development — yet it inherits the same isPackaged gate and therefore ships without these headers. The window still has sandbox/contextIsolation/nodeIntegration protections, but the network-layer hardening is absent in a mode end users can actually run.
- **Evidence:** main.js:182 — `if (!app.isPackaged) return;` inside registerSecurityHeaders(); and getUpdateMode() (lines 1298-1302) returns 'source' for `app.isPackaged && useRepoMode`, confirming source mode is a packaged end-user runtime that still has app.isPackaged true — but dev mode (`!app.isPackaged`) ships with zero CSP.
- **Fix:** Apply the CSP/security headers and permission-deny handler in all modes (or at minimum gate only the strictest dev-HMR-incompatible directives behind a dev check, while still emitting X-Content-Type-Options/X-Frame-Options/permission-deny everywhere). Keeping dev permanently header-free trains the app to work without them and leaves source-mode users less protected.

### ⚪ security.19 — CI and release `bun audit` ignore lists are inconsistent

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `.github/workflows/ci.yml` — ci.yml:75 vs release.yml:99
- **Problem:** ci.yml suppresses two HIGH advisories on every PR/push (`bun audit --audit-level=high --ignore=GHSA-v39h-62p7-jpjc --ignore=GHSA-q3j6-qgpj-74h6`, the fast-uri dev-only CVEs), but release.yml runs `bun audit --audit-level=high` with NO ignores. The justification comment (ci.yml:69-74) is sound — fast-uri is dev-only and not bundled — but the divergence means a release can be blocked by advisories that day-to-day CI deliberately accepts, or (if the audit DBs differ) a release can pass checks PR-CI never enforced. The accept-or-reject policy for a given advisory should be identical across gates so the decision is auditable in one place.
- **Evidence:** ci.yml:75 `bun audit --audit-level=high --ignore=GHSA-v39h-62p7-jpjc --ignore=GHSA-q3j6-qgpj-74h6`; release.yml:99 `bun audit --audit-level=high`.
- **Fix:** Factor the audit command (with its ignore list and the explaining comment) into a single shared script or composite action invoked by both workflows, so the suppression policy is defined once. Add a TODO/expiry to revisit the fast-uri ignores when stryker/eslint ship the transitive bump, as the comment already anticipates.

### ⚪ security.20 — `.gitleaks.toml` allowlists a path/file that does not exist in the repo

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `.gitleaks.toml` — lines 11-14 (paths allowlist) — `^opencode\.json$`
- **Problem:** The gitleaks allowlist exempts `opencode.json` from secret scanning, but no `opencode.json` exists at the repo root (file not present). A standing allowlist entry for a non-existent file is a latent hole: if a file by that name is later added (the project README/AGENTS references opencode config), any secret committed in it would be silently skipped by the CI secrets-scan (ci.yml:26-39). The `^\.obsidian/` exemption is broad too — it blanket-excludes a whole tree of auto-generated plugin data from scanning. Neither is exploited today, but allowlisting by path rather than by specific known-safe match is the weaker pattern for a finance repo.
- **Evidence:** .gitleaks.toml:12-13 `paths = [ '''^\.obsidian/''', '''^opencode\.json$''' ]`; `ls /workspaces/Vision/opencode.json` returns nothing.
- **Fix:** Remove the `opencode.json` path exemption until/unless the file exists and is shown to contain only non-secret config; if it must be exempt, scope the allowlist to the specific keys/regexes that are false positives rather than the whole file. Periodically prune stale allowlist paths so the secret scanner's coverage matches the actual tree.

## Correctness (16)

🟠 4 high · 🟡 7 medium · ⚪ 5 low

### 🟠 correctness.1 — Planned-transaction PATCH performs two separate DB transactions, leaving loan params and schedule inconsistent on partial failure

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/plannedTransactions.js` — router.patch('/:id'), lines 233-263 (calls update() then updateLoanScheduleForPatch())
- **Problem:** The PATCH handler updates the planned-transaction row (including derived loan_regular_payment_amount / loan_first_payment_date) via plannedTransactionRepository.update(id, fields) — a self-contained withTransaction — and THEN, in a second, independent withTransaction, replaces the amortization schedule via replaceLoanSchedule(id, schedule). The two writes are not wrapped in one transaction. If the process crashes or the DB connection drops between the two calls, the planned_transactions row reflects new loan parameters while planned_transaction_loan_schedule still holds the OLD schedule (or, in the is_loan=false path, the row says not-a-loan but the schedule rows survive). For a financial app this is a correctness hazard: the displayed loan terms and the per-installment schedule silently disagree. The repo even proves the correct pattern exists — executeAndAdvance (line 554) and replaceLoanSchedule (line 603) each use withTransaction internally — but the route composes two of them instead of one atomic boundary.
- **Evidence:** plannedTransactions.js:251-253 — `const updated = await plannedTransactionRepository.update(id, fields);` followed by `const loanScheduleChanged = await updateLoanScheduleForPatch(id, generatedLoanSchedule, fields, existing);` where updateLoanScheduleForPatch (line 134) calls `plannedTransactionRepository.replaceLoanSchedule(id, ...)` — a separate withTransaction (repo line 603-611).
- **Fix:** Move the row update + loan-schedule replacement into a single repository method that runs both inside one withTransaction(client => {...}), passing the client through (as setTransactionTags already does). The route should call one atomic method, not orchestrate two writes. Contrast with services/recipientMergeService.js which correctly does all five FK reassignments in one transaction.

### 🟠 correctness.2 — Hidden-category exclusion logic duplicated across 3 sites with mismatched fetch limits and unshared caches

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/hooks/useFilteredDashboardStats.ts` — useFilteredDashboardStats.ts:60-65; useStatistics.ts:210-223; DashboardPage.tsx:71-99
- **Problem:** The logic that resolves which categories are excluded from money totals (fetch all categories, filter to !is_active, append to excludedCategoryIds) is reimplemented in three independent places, AND each fetches the 'all categories' list differently. useStatistics.ts fetches with React Query key ['categories','all-for-stats'] and limit 500; DashboardPage.tsx fetches with key ['categories','all'] and limit 1000; useFilteredDashboardStats.ts fetches imperatively INSIDE its queryFn (no query key at all) with limit 1000. The 500 vs 1000 limit mismatch means a user with 501-1000 categories gets a different set of hidden categories resolved on the Statistics page versus the Dashboard, so the same 'exclude hidden categories' setting can silently produce different income/spending/net totals on different screens. Because the fetches use different (or no) cache keys, the lists are also fetched redundantly and can be stale relative to each other.
- **Evidence:** useStatistics.ts:210-212 `queryKey: ['categories', 'all-for-stats'], ... const res = await apiClient.getCategories({ limit: 500 });` vs useFilteredDashboardStats.ts:61 `const categoriesData = await apiClient.getCategories({ limit: 1000 });` (imperative, no key) vs DashboardPage.tsx:72-73 `queryKey: ['categories', 'all'], queryFn: () => apiClient.getCategories({ limit: 1000 })`. Hidden-resolution filter repeated in all three: `.filter((cat) => !cat.is_active).map((cat) => cat.id)`.
- **Fix:** Extract a single hook, e.g. useExcludedIds(scope) in hooks/, that owns one React Query for the full category list under one shared key with one limit constant, resolves hidden IDs, and merges with settings.excludedCategoryIds/RecipientIds. Have DashboardPage, useFilteredDashboardStats, and useStatistics all consume it so the exclusion set (and thus the money totals) is computed identically everywhere. Replace the imperative in-queryFn fetch in useFilteredDashboardStats with the shared cached query.

### 🟠 correctness.3 — Two-of-three portfolio money-derivation logic duplicated verbatim across Add/Edit dialogs

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx` — AddPortfolioTxnDialog.tsx:95-118 and EditPortfolioTxnDialog.tsx:110-133
- **Problem:** The financial 'derive the missing one of amount/units/price from the other two' logic — including the rounding precisions (4/8/6 decimals) and the float-tolerance validation (epsilon 0.0001) — is copy-pasted character-for-character into two components. This is money/correctness code: if the rounding precision or tolerance is fixed in one place (e.g. to address float drift) and not the other, the Add and Edit flows will silently accept/reject different inputs for the same portfolio transaction. It violates DRY in exactly the kind of code where drift is most dangerous.
- **Evidence:** Both files contain identical blocks: `const provided = Number(amountInput !== undefined) + Number(unitsInput !== undefined) + Number(priceInput !== undefined);` then `derivedAmount = roundTo(unitsInput * priceInput, 4)` / `roundTo(amountInput / priceInput, 8)` / `roundTo(amountInput / unitsInput, 6)`, and `Math.abs(roundTo(effectiveUnits * effectivePrice, 4) - roundTo(effectiveAmount, 4)) <= 0.0001`. grep confirms `Number(amountInput !== undefined)` exists only in these two files.
- **Fix:** Extract a single pure helper, e.g. `deriveUnitMath({ amount, units, price }): { amount?, units?, price?, isValid }`, into a shared util under `features/portfolio` or `utils/`, with the rounding precisions and the tolerance as named constants (e.g. `UNIT_MATH_TOLERANCE = 0.0001`, `AMOUNT_DECIMALS = 4`). Both dialogs call it. Unit-test the helper directly.

### 🟠 correctness.4 — Foreign-currency portfolio history converted at today's FX rate, not the rate on each day

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/services/portfolio/snapshotBuilder.js` — convertAmount (lines 178-188) + fxResult query (line 103); applied across the day walk and to invested-capital accumulators (lines 258, 264-291, 320)
- **Problem:** computeDailySnapshots builds a multi-year daily timeseries of invested capital and portfolio value, but the only FX table it loads is the LATEST rate set: `SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true` (line 103). convertAmount uses the per-transaction `fxRateToEur` when present, but otherwise falls back to `fxRates[from]` — today's rate — for every historical day (line 187). So a USD buy made in 2021 (with no stored fx_rate_to_eur) contributes its EUR-converted invested amount and market value computed at the 2026 USD/EUR rate on EVERY day of the chart, including 2021. This silently rewrites historical invested-capital and value in EUR whenever the rate has moved, producing a distorted performance/gain-loss curve and contradicting the live-summary reconciliation the file claims. Unlike convertRowsToEur (which has full historical-rate-by-date support with nearest-date fallback), this hot path has none.
- **Evidence:** Line 103: `query(\`SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true\`)`. Lines 184-187: `if (fxRateToEur !== undefined && Number.isFinite(fxRateToEur) && fxRateToEur > 0) { return amt.times(fxRateToEur).div(rateTo); } return amt.times(fxRates[from] || 1).div(rateTo);`
- **Fix:** For non-EUR investments without a stored fx_rate_to_eur, resolve the historical rate for the transaction date (the existing getRateToEurForDate / buildHistoricalRateIndex / findNearestRateInIndex utilities in rateFetcher.js already do exactly this and are used by convertRowsToEur). Load a per-currency historical index once before the day walk and look up by `day`/transaction date, falling back to latest only as a last resort and flagging the snapshot as fallback-converted. The backfillPortfolioHistoricalRates() path already exists to populate these rows.

### 🟡 correctness.5 — POST /api/transactions accepts unvalidated money amount and date — invalid input becomes a 500, not a clean 400

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/transactions.js` — router.post('/') lines 480-538
- **Problem:** The create handler checks only field *presence* (`data.amount == null`, `!txDate`) and validates `recipient_id` as a positive integer, but never validates that `amount` is a finite number, that `balance`/`category_id` are numeric, or that `transaction_date` matches YYYY-MM-DD. The raw values are passed straight to transactionRepository.create() and inserted into numeric/date columns. A non-numeric `amount` (e.g. "abc" or {}), or a malformed date, reaches Postgres as a type error and surfaces as an opaque 500 instead of a 400. This violates the project rule 'Validate all inputs at boundaries' and 'Money/decimals must avoid floating-point drift / validate at boundaries' — the most safety-critical field (amount) is the one left unvalidated. Note the validation middleware already exports validateNumber() and validateDateString() helpers that are simply not used here.
- **Evidence:** const txDate = data.transaction_date || data.date;
if (!txDate || !data.bank_account || !data.recipient_id || data.amount == null) {
  throw new ValidationError('Missing required fields: date, bank_account, recipient_id, amount');
}
... // amount/date/category_id types never checked
const transaction = await transactionRepository.create({ transaction_date: txDate, ..., amount: data.amount, balance: data.balance, category_id: data.category_id, ... });
- **Fix:** Validate at the boundary using the existing helpers (or a Zod schema): validateNumber(data.amount, { fieldName: 'amount' }), validateDateString(txDate, 'date'), and validateNumber for balance/category_id when present. Reject with ValidationError (400) before calling the repository. Apply the same to PATCH where `amount`/`balance` flow through normalizeTransactionPatchFields untyped.

### 🟡 correctness.6 — Category assign endpoints pass unvalidated recipient_ids into an int[] cast

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/categories.js` — POST /assign (lines 48-62) and POST /:id/assign (lines 84-92); sink: categoryRepository.assignToRecipients (categoryRepository.js:115-119)
- **Problem:** Both assign routes accept `recipient_ids`, normalize a scalar to an array, and forward it unvalidated to categoryRepository.assignToRecipients, which binds it as `id = ANY($2::int[])`. There is no integer/positive/range validation (unlike savedCharts and dashboard_settings, which run validateIntArray). A client sending `recipient_ids: ["abc"]` or `[1.5]` triggers a Postgres int[] cast error → 500 rather than a 400, and the UPDATE silently runs against whatever survives coercion. The project ships validateIntArray() precisely for this and uses it elsewhere; these two routes skip it.
- **Evidence:** // categories.js
const ids = Array.isArray(recipient_ids) ? recipient_ids : [recipient_ids];
... await categoryRepository.assignToRecipients(category.id, ids);
// categoryRepository.js
const sql = `UPDATE recipients SET default_category_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`;
const result = await query(sql, [categoryId, recipientIds]);
- **Fix:** Run the supplied ids through validateIntArray(recipient_ids, 'recipient_ids') in both handlers and throw ValidationError on the .valid === false path before calling assignToRecipients, mirroring savedCharts.js parseIntIds().

### 🟡 correctness.7 — Manual transaction POST is non-atomic: create() commits, then dedup record is written separately and its errors are swallowed

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/node-backend/src/routes/transactions.js` — router.post('/'), lines 510-533; recordManualRawTransaction in services/deduplication.js lines 105-121
- **Problem:** POST /api/transactions calls transactionRepository.create(...) (which COMMITs the transaction immediately) and then separately calls recordManualRawTransaction(...) to persist the dedup hash row. recordManualRawTransaction catches every error and merely logs a warning (anything other than 42P01) — it never rethrows. So if the manual_raw_transactions INSERT fails for any reason after the transaction is already committed, the canonical transaction exists but its deduplication_hash record does not. A subsequent identical manual POST then misses the precise hash-based dedup (isManualDuplicate, deduplication.js:69) and falls through to the weaker field-based check, so true duplicates can slip in. This is a silent consistency gap, not data loss, but it undermines the dedup guarantee the table exists to provide.
- **Evidence:** transactions.js:510 `const transaction = await transactionRepository.create({...})` then 523 `await recordManualRawTransaction({...})` with no shared transaction. deduplication.js:115-120 `} catch (err) { if (err.code !== '42P01') { logger.warn('Unexpected error recording manual raw transaction', ...); } // Table may not exist yet — silently skip }`.
- **Fix:** Either wrap both writes in one withTransaction so the dedup row and the transaction commit/rollback together, or (since the table-missing case is a legitimate soft-fail) narrow the swallow strictly to err.code === '42P01' and rethrow other errors so a failed dedup write does not silently leave the system in an unguarded state.

### 🟡 correctness.8 — Lossy Math.round float rounding in portfolio buy/sell money math despite Decimal helpers in scope

- **Severity:** medium · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/repositories/portfolioTxRepo.common.js` — roundTo (lines 116-118), used by normalizeBuySellMath (121-154)
- **Problem:** roundTo uses `Math.round(value * factor) / factor` — the exact IEEE-754-drift pattern that lib/money.js was created to replace (money.js:65 comment: 'Use on emit to replace lossy Math.round(x * 10**n) / 10**n'). It is applied to amount/units/price_per_unit in buy/sell normalization and to the amount==units*price equality check, so accumulated rounding can mis-derive a missing field or wrongly reject a valid amount. The file already imports toDecimal/toNumber from lib/money.js, so the canonical path is one line away.
- **Evidence:** `function roundTo(value, decimals) { const factor = 10 ** decimals; return Math.round(value * factor) / factor; }` then `if (!hasAmount) nextAmount = roundTo(nextUnits * nextPrice, 4);` and `if (Math.abs(expectedAmount - comparableAmount) > 0.01)`. Top of file: `import { toDecimal, toNumber } from '../lib/money.js';`
- **Fix:** Replace roundTo with roundMoney from lib/money.js (or toDecimal(...).toDecimalPlaces(decimals, ROUND_HALF_UP).toNumber()) so the buy/sell derivation uses the same decimal path as the rest of the money code, and the equality tolerance can shrink.

### 🟡 correctness.9 — API responses force-cast with `as unknown as` instead of being typed through the generated client

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts` — useTransactionListData.ts:111 and 145; type at features/transactions/types.ts:20-36
- **Problem:** `getTransactions()` returns the generated/typed API response, but it is laundered through `as unknown as RawApiTransaction[]` — a double-cast that disables all compiler checking at the API boundary. `RawApiTransaction` is a hand-maintained interface with a permissive `[key: string]: unknown` index signature, parallel to the generated OpenAPI types. If a backend field is renamed or its nullability changes, TypeScript cannot catch it here because the cast erases the source type entirely; the mismatch surfaces only at runtime. The project's type-safety strategy (generated OpenAPI types) is being bypassed for this list, which is the highest-traffic data path in the app.
- **Evidence:** `setAllItems(initialData.items as unknown as RawApiTransaction[]);` (line 111) and `const newItems = (result.items as unknown as RawApiTransaction[]).filter(...)` (line 145). Type defined as `export interface RawApiTransaction { id: number; ... [key: string]: unknown; }`.
- **Fix:** Either align `RawApiTransaction` with the generated transaction type (extend or alias it) so a plain assignment type-checks, or map the API items to `RawApiTransaction` via an explicit, checked mapping function. Remove the `as unknown as` double-cast so a future field rename produces a compile error.

### 🟡 correctness.10 — Inconsistent rounding mode (banker's vs half-up) across money emit paths undermines snapshot/summary reconciliation

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/lib/money.js` — roundToCents (line 42, ROUND_HALF_EVEN) vs roundMoney (line 72, ROUND_HALF_UP); consumers in portfolioSummaryService.js (line 26 round2 = roundMoney) and snapshotBuilder.js (lines 373-385) vs portfolioMath.js (lines 148-152) and all repositories
- **Problem:** Two cent-rounding helpers with DIFFERENT rounding modes are both used on money paths. roundToCents uses banker's rounding (ROUND_HALF_EVEN) and is used by calculateCostBasis/FIFO/LIFO (portfolioMath.js) and every infoRepository emit. roundMoney uses ROUND_HALF_UP and is the emit rounder for portfolioSummaryService (round2/round6) and snapshotBuilder. A value ending in exactly .xx5 rounds differently in the two paths (e.g. 2.345 -> 2.34 banker's, 2.35 half-up). Since portfolioSummaryService consumes cost-basis figures already pre-rounded with banker's rounding and then re-rounds the converted result with half-up, and snapshotBuilder rounds independent Decimal accumulators with half-up, the headline snapshot value and the live /portfolio-summary value can differ by a cent on boundary cases — directly contradicting the 'always reconciles with /portfolio-summary' guarantee in snapshotBuilder.js comments (lines 307-309) and portfolioSummaryService.js (lines 5-11). It also violates the documented intent: money.js line 37 declares cent rounding as banker's rounding.
- **Evidence:** money.js line 42: `return toDecimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);` vs line 72: `return toDecimal(v).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toNumber();`. portfolioSummaryService.js line 26: `const round2 = (value) => roundMoney(value, 2);`
- **Fix:** Pick one rounding mode for money (banker's rounding is the conventional financial default and already declared canonical in money.js line 37) and make roundMoney delegate to the same mode, or route all cent emits through roundToCents. Add a test asserting snapshot headline value equals the live summary value on a .xx5 boundary input.

### 🟡 correctness.11 — Portfolio daily snapshot 'today' boundary uses UTC calendar day, not APP_TIMEZONE

- **Severity:** medium · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/portfolio/snapshotBuilder.js` — lines 219-223 (day-walk start/end) and 253 (todayYmd)
- **Problem:** ADR-009 and lib/timezone.js mandate that business-date math runs in APP_TIMEZONE (Europe/Brussels), with a hard rule: 'No raw new Date() + offset arithmetic in calc modules.' This module violates that: `today` is built from `new Date()` UTC getters and the walk uses `new Date(firstDateYmd)` + setUTCDate, so the final snapshot day (`todayYmd`) is the UTC calendar day. Between Brussels-evening and UTC-midnight (23:00-00:00 winter / 22:00-00:00 summer Brussels), the UTC date is still 'yesterday', so the latest snapshot — the one whose value must match the live summary and feed net-worth — is dated and bucketed one calendar day behind the Brussels business day. Transactions entered 'today' in Brussels during that window also fall after `today` and are excluded from the latest snapshot.
- **Evidence:** Line 219-220: `const _now = new Date(); const today = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate()));` Line 221: `for (let d = new Date(firstDateYmd); d <= today; d.setUTCDate(d.getUTCDate() + 1))`
- **Fix:** Derive the walk's end day from toAppDateString(new Date()) (lib/timezone.js) so 'today' is the APP_TIMEZONE calendar day, consistent with the rest of the calc layer (portfolioMath.calculateAccruedInterest already does this via toAppDateString). The DATE-column tx buckets are tz-independent, so only the loop bounds need the app-zone day.

### ⚪ correctness.12 — Portfolio transaction `type` is inserted without an enum allowlist

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/repositories/portfolioTxRepo.common.js` — normalizeTransactionPayload lines 160-235; consumed by portfolioTxRepo.writes.js create() line 22 / INSERT line 68-71; route createTransaction (investmentController.js:366-398) only checks presence
- **Problem:** createTransaction validates that `type` and `date` are present, then normalizeTransactionPayload branches on type === 'buy'|'sell'|'gift' but has a catch-all final branch (lines 226-235) that accepts ANY other string for `type` as long as `amount` is provided. That arbitrary `type` value is then inserted verbatim into the portfolio_transactions.type column. Numeric fields are well-guarded (parseOptionalNumber throws on NaN), but `type` is not constrained to a known set, so an unexpected value (e.g. 'buyy', 'withdraw') silently persists and will mis-drive downstream unit-math / holdings calculations that switch on type ('buy'|'sell'|'gift').
- **Evidence:** const type = payload.type;
... // buy/sell/gift branches
if (amount === undefined) { throw makeValidationError('amount is required'); }
return { ...payload, amount, units, price_per_unit: pricePerUnit, ... }; // any other `type` falls through here and is later INSERTed
- **Fix:** Add an explicit allowlist check at the top of normalizeTransactionPayload (e.g. const VALID_TYPES = new Set(['buy','sell','gift','dividend','interest', ...]); if (!VALID_TYPES.has(type)) throw makeValidationError(...)). Confirm the set against the DB CHECK constraint / Alembic schema so the boundary and the column agree.

### ⚪ correctness.13 — Boundary-validation pattern gap: handlers check presence but defer type/format/existence to Postgres (recurring across routes)

- **Severity:** low · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/plannedTransactions.js` — POST /:id/execute (lines 265-303, `executed_transaction_id`); POST / (lines 178-210, `amount`/`planned_date`/`category_id`); GET /api/info/transaction-summary (statistics.js:51-61, start_date/end_date)
- **Problem:** Several handlers accept identifiers, dates, and amounts after a presence-only check and rely on Postgres type-casts / FK constraints to reject bad values, producing 500s instead of 400s. Examples: planned-transactions execute throws only on missing `executed_transaction_id` then inserts it into an FK column (non-integer or non-existent id → 500); planned-transactions POST checks `amount == null` but never that it is numeric or that `planned_date` is a valid date; info/transaction-summary forwards `start_date`/`end_date` unvalidated into date comparisons. This is the same class as the transactions-POST finding and conflicts with the AGENTS.md 'Validate all inputs at boundaries' rule. No injection risk (all parameterized), but error UX and observability suffer and malformed input is indistinguishable from server faults.
- **Evidence:** // plannedTransactions.js execute
const { executed_transaction_id, execution_date } = req.body;
if (!executed_transaction_id) { throw new ValidationError('Missing required field: executed_transaction_id'); }
... await plannedTransactionRepository.executeAndAdvance(id, executed_transaction_id, execDate, ...); // id type/existence never validated here
- **Fix:** Validate types/formats at each boundary with the existing helpers (validateId/validateNumber/validateDateString) or a small Zod schema per route, e.g. require executed_transaction_id to be a positive integer and execution_date to be YYYY-MM-DD before calling the repository. Consider a shared body-validation middleware so the pattern is applied consistently rather than per-handler.

### ⚪ correctness.14 — Numeric form inputs silently coerce invalid entries to a default via `parseInt(...) || N`

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/frontend/src/features/imports/TransactionImportCard.tsx` — TransactionImportCard.tsx:272; RecipientPatternsDialog.tsx:383; ExportDialog.tsx:104; ExemptionsStep.tsx:183
- **Problem:** `parseInt(e.target.value) || 0` (and `|| 100`) swallows invalid or empty input by substituting a default, with no radix and no user feedback. For CSV import `skipRows`, a user who clears the field or types something unparseable silently gets 0 rows skipped; for recipient-pattern `priority` an empty field silently becomes 100. Missing radix also means a leading-zero string could be misparsed in older engines. This is the 'never silently swallow / validate at boundaries' convention applied to input handling.
- **Evidence:** `onChange={(e) => setCustomConfig({ ...customConfig, skipRows: parseInt(e.target.value) || 0 })}` and `priority: parseInt(e.target.value) || 100,`.
- **Fix:** Parse with an explicit radix and guard NaN distinctly from an intentional 0: `const n = Number.parseInt(e.target.value, 10); setCustomConfig({ ...customConfig, skipRows: Number.isNaN(n) ? customConfig.skipRows : Math.max(0, n) })`. Reserve the default only for the genuinely-empty case.

### ⚪ correctness.15 — CSSS tier boundary value lands in the lower tier despite comment claiming exclusive-upper bounds

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/frontend/src/lib/belgianTax/socialSecurity.ts` — computeSpecialSocialSecurityContribution, lines 44-48
- **Problem:** The tier loop comment (lines 45-46) states bounds are '[from, to] inclusive on the lower bound, exclusive on the upper.' The implementation is `if (netTaxableIncome < tier.from) continue; if (netTaxableIncome > tier.to) continue;` and returns on first match. Adjacent tiers share a boundary (e.g. csssTable tier1 to=18_592.02, tier2 from=18_592.02). At netTaxableIncome === 18_592.02 the FIRST tier matches (neither `< from` nor `> to` is true) and the function returns the lower tier's flat amount — i.e. the upper bound is treated as INCLUSIVE, contradicting the comment and assigning the exact-boundary income to the lower (cheaper) tier. Only exact-cent boundary incomes are affected, so the monetary impact is tiny, but the code does not match its documented contract and the boundary handling is the opposite of what's claimed.
- **Evidence:** Lines 47-48: `if (netTaxableIncome < tier.from) continue; if (netTaxableIncome > tier.to) continue;` against csssTable entries `{ from: 0, to: 18_592.02, ... }` then `{ from: 18_592.02, to: 21_070.96, ... }` (constants.ts lines 293-294).
- **Fix:** Make the upper bound exclusive to match the comment: use `if (netTaxableIncome >= tier.to) continue;` (with the last tier's to = Infinity this is safe), or document that boundaries resolve to the lower tier and update the comment. Add a unit test at an exact tier boundary.

### ⚪ correctness.16 — Recurring-detection prediction and interval math use local-time calendar getters

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/recurringDetectionService.js` — interval calc lines 200-202; predicted-next lines 227-232
- **Problem:** The interval and predicted-next math read calendar components with LOCAL-time getters (getFullYear/getMonth/getDate) on a Date built from a DATE column, then feed them into Date.UTC. The inline comments claim this 'uses UTC dates to avoid DST off-by-one,' but getFullYear/getMonth/getDate return the value in the SERVER's local timezone, not UTC or APP_TIMEZONE. The pg driver returns DATE columns as a Date at LOCAL midnight; if the server's local zone is not UTC (and APP_TIMEZONE is Europe/Brussels, +1/+2), these getters happen to recover the stored calendar day correctly only because the Date is at local midnight — but if the process TZ ever differs from the DB/app zone the recovered day shifts. This is fragile and inconsistent with lib/timezone.js (ADR-009) which the rest of the calc layer is required to use. Detection is heuristic so the practical impact is low, but predictedNext (surfaced to users and the aiChat tool) can be off by a day.
- **Evidence:** Lines 200-202: `const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());` (local getters fed into Date.UTC despite the 'Use UTC dates' comment). Lines 227-231 repeat the same pattern for lastUtcMidnight.
- **Fix:** Normalise dates through lib/timezone.js (toAppDateString / appDateStringToUtc) as portfolioMath.calendarDaysBetween does, or at minimum use getUTC* getters consistently so the comment matches the code. Pin the DB/process timezone if relying on local-midnight DATE decoding.

## Performance (19)

🟠 5 high · 🟡 10 medium · ⚪ 4 low

### 🟠 performance.1 — Unbounded full-table scan + in-app aggregation in /transaction-summary

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/repositories/infoRepositoryStatistics.js` — getTransactionSummary (lines 199-241)
- **Problem:** getTransactionSummary selects every active transaction's amount/currency/date with no LIMIT and no required filter, then computes count/sum/avg/min/max in Node. The public route /transaction-summary (routes/info/statistics.js:51) defaults bankAccount, startDate and endDate to null/undefined, so a no-arg request ships the entire transactions table over the wire into the Node process just to produce five scalars. On a multi-year dataset (tens of thousands of rows) this is a large memory + transfer + CPU cost on a hot dashboard endpoint, and Postgres could compute COUNT/SUM/AVG/MIN/MAX in a single indexed pass. The only reason it is done in JS is per-row FX conversion (convertRowsToEur), but min/max/avg in a single currency could be pushed down or the scan bounded.
- **Evidence:** let sql = `\n      SELECT t.amount, t.currency, t.date\n      FROM transactions t\n      WHERE t.is_active = true\n    `; ... const result = await query(sql, params); ... for (const row of converted) { total = total.plus(...); if (eur < min) min = eur; if (eur > max) max = eur; }  — route: const summary = await infoRepository.getTransactionSummary({ bankAccount: bank_account || null, startDate: start_date || null, endDate: end_date || null, ... })
- **Fix:** Require or default a bounded date window for the unfiltered case, or compute the aggregate in SQL. For multi-currency correctness either (a) aggregate per (currency) in SQL with GROUP BY currency and convert the small grouped result, or (b) keep JS conversion but cap the scan with a sane default range and pagination guard. At minimum add a server-side maximum date span.
- **Deferred 2026-05-29** — Fix rewrites the money-aggregation query path (`/transaction-summary`) and requires validation against a running DB with multi-currency data. Cannot be safely verified in a code-only pass. Tracked in TODO.md under "perf-DB — deferred".

### 🟠 performance.2 — Report monthly summary always takes the unbounded live path (MV bypassed for allTime)

- **Severity:** high · **Effort:** large · **Confidence:** high
- **Location:** `apps/node-backend/src/repositories/infoRepo.monthly.js` — getMonthlyFinancialSummary (lines 29, 95-144)
- **Problem:** The mv_monthly_summary fast path is skipped whenever allTime is true OR any category/recipient exclusion is set (line 29). The PDF report data fetcher always calls computeMonthlySummary({ allTime: true }) (services/reports/dataFetcher.js:59-62), so report generation never benefits from the MV. The live allTime query joins a generate_series of all months against filtered_transactions and returns one row per transaction across the full history (LEFT JOIN on date range), then streams every transaction into Node for JS aggregation. mv_monthly_summary is structurally limited to the last 12 months (materializedViewService.js:46), so it can never serve allTime even if the gate were relaxed.
- **Evidence:** if (!allTime && validIds.length === 0 && validRecipientIds.length === 0 && await mvAvailable('mv_monthly_summary')) { ... }  // else live path:\nLEFT JOIN filtered_transactions t ON t.date >= m.month_start AND t.date < m.month_start + interval '1 month' ... const result = await query(sql, params); const liveConverted = await convertRowsToEur(mapRowsForAmountConversion(result.rows.filter(r => r.txn_id != null), 'amount', false), ...)
- **Fix:** Add an all-time materialized view (or extend mv_monthly_summary to full history with an incremental refresh strategy) so the report path reads pre-aggregated monthly buckets per currency, then applies FX to the small grouped result instead of every raw transaction. Alternatively, push the monthly SUM/COUNT into SQL grouped by (year, month, currency) and convert the grouped rows.
- **Deferred 2026-05-29** — Fix requires adding a new all-time MV or restructuring the existing `mv_monthly_summary` (Alembic migration + rollback plan) and can only be validated against a running DB with multi-year history. Tracked in TODO.md under "perf-DB — deferred".

### 🟠 performance.3 — Recipient insight/pivot reads do full live scans while the purpose-built MV goes unused

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/repositories/infoRepositoryRecipients.js` — getRecipientInsights (22-128), getRecipientByYear (130-184), getRecipientPivot (186-247)
- **Problem:** All three recipient-insight reads scan the full active transactions table (getRecipientByYear has NO date bound at all) selecting t.amount/currency/date and aggregate in Node. Meanwhile mv_recipient_monthly — created, uniquely indexed, and REFRESHed on every single transaction mutation and after every import (aggregationRefresh.js:39, 67-83; commit.js:226) — is never read by any repository (grep shows only agg_recipient_totals is read, in recipientRepository.js:43). So the app pays the recurring refresh cost of mv_recipient_monthly for zero read benefit, and these hot insight endpoints repeat full-history aggregation on every call. The MV already pre-computes month x recipient x currency income/spending/net for the last 24 months — exactly what getRecipientPivot/getRecipientByYear need.
- **Evidence:** getRecipientByYear: FROM transactions t ... WHERE t.is_active = true AND t.amount < 0 ${recExclude} ORDER BY t.date (no date filter, no LIMIT). aggregationRefresh.js: const PHASE_1_MATERIALIZED_VIEWS = ['mv_recipient_monthly']; ... await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`). grep for mv_recipient_monthly in repositories/ returns no read usages.
- **Fix:** Either route the recipient pivot/by-year/insight reads through mv_recipient_monthly (add it to the mvAvailable allowlist and query it, converting the small grouped result), or, if these reads must stay live, stop refreshing mv_recipient_monthly on every mutation to drop the unused write-amplification. Pick one — paying refresh cost for a never-read view is pure overhead.
- **Deferred 2026-05-29** — Fix rewrites money-aggregation queries touching `mv_recipient_monthly` and the three recipient-insight repository methods. Requires Alembic migration work (if the MV schema changes) and end-to-end validation against a running DB. Tracked in TODO.md under "perf-DB — deferred".

### 🟠 performance.4 — TransactionsTable rebuilds entire columns array on every row-selection toggle, invalidating VirtualDataTable's full-dataset processedRows useMemo

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/features/transactions/components/TransactionsTable.tsx` — columns useMemo deps (line 293, `selectedIds`); used by VirtualDataTable processedRows (VirtualDataTable.tsx:320)
- **Problem:** `selectedIds` (a Set) is in the dependency array of the `columns` useMemo. Each checkbox toggle calls `onSelectionChange(new Set(...))` in TransactionsPage (state owner, TransactionsPage.tsx:78/364), producing a brand-new Set identity. That invalidates the `columns` memo and rebuilds the whole column-definition array on every single click. `columns` is itself a dependency of VirtualDataTable's `processedRows` useMemo, which does `deferredData.map(...)` then filter/sort over the ENTIRE loaded dataset. With infinite scroll loading hundreds-to-thousands of rows, every checkbox tick re-allocates and re-processes the full row set on the main thread, plus re-runs the column-width re-seed effect (VirtualDataTable.tsx:189-201, dep `columns`). The only column cell that actually depends on selection is the per-row checkbox `checked={selectedIds.has(row.id)}`.
- **Evidence:** TransactionsTable.tsx:287-305 deps include `selectedIds, toggleSelect, toggleSelectAll, allSelected, someSelected`; VirtualDataTable.tsx:320 `}, [deferredData, columnFilters, localSearchQuery, isServerSearch, isServerSort, sortKey, sortDir, columns]);` and 287 `let result = deferredData.map((row, sourceIndex) => ({ row, sourceIndex }));`
- **Fix:** Decouple selection from column identity. Read `selectedIds`/`toggleSelect` inside the checkbox renderer from a ref or a stable callback that closes over the latest Set (e.g. keep `selectedIdsRef` updated each render and have `toggleSelect`/the checkbox read `selectedIdsRef.current`), so the `columns` memo no longer lists `selectedIds`, `allSelected`, or `someSelected`. Alternatively render the selection checkbox column outside the generic column pipeline. This keeps `columns` stable so `processedRows` is not recomputed on selection changes.
- **Remediated 2026-05-29** — `VirtualDataTable.tsx`: `processedRows` and the column-width re-seed effect now key on `columnKeySignature` (column keys joined as a string) instead of the `columns` array reference. A `columnsRef` keeps the live array accessible so the effect and processedRows body can read the actual columns without listing the unstable identity in deps. Selection toggles in `TransactionsTable` rebuild the `columns` array (new Set identity → new column array) but `columnKeySignature` is value-stable across toggles, so `processedRows` and the width-seed effect are no longer invalidated. See [[docs/components/shared-components#VirtualDataTable|VirtualDataTable — Performance Notes]].

### 🟠 performance.5 — Full recharts library (114 kB gzip) is eagerly preloaded on initial page load despite being used by only one lazy route

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/vite.config.ts` — manualChunks() lines 53-86 (the `charts` branch, lines 71-73) + emitted dist/index.html modulepreload
- **Problem:** recharts is imported by exactly one component, features/ai-chat/ToolResultCard.tsx, which is reachable only through the lazy-loaded AIChatPage (App.tsx:47). It should therefore never load until a user opens /ai-chat. But a production build shows the recharts chunk is preloaded on the very first paint of the dashboard ('/'). The built chunk dist/assets/charts-DCPECQsp.js is 396 kB raw / 114 kB gzipped (91 internal `recharts` references, plus ResponsiveContainer/CartesianGrid/XAxis/Tooltip identifiers) and appears in dist/index.html as `<link rel="modulepreload" ... href="/assets/charts-DCPECQsp.js">`. The eagerly-rendered AppSettingsContext (App.tsx:130, a top-level provider) statically imports a symbol from that same chunk (built output: AppSettingsContext-DZSTsTVB.js begins `import{q as t}from"./charts-DCPECQsp.js"`), which drags the whole recharts chunk into the initial load graph. By contrast the visx chunk that actually powers every real chart (charts-CGyZFHNQ.js, 212 kB/67 kB gz) is correctly NOT preloaded (modulepreload count 0 in index.html). So the single largest preloaded JS payload on first load is a chart library the first screen never uses.
- **Evidence:** dist/index.html line 15: `<link rel="modulepreload" crossorigin href="/assets/charts-DCPECQsp.js">`. dist/assets/charts-DCPECQsp.js size 396155 bytes, `grep -c recharts` = 91. dist/assets/AppSettingsContext-DZSTsTVB.js head: `import{a as e}from"./rolldown-runtime...";import{q as t}from"./charts-DCPECQsp.js";`. Source ToolResultCard.tsx:2-16 `import { Bar, BarChart, ... LineChart, Pie, PieChart, ResponsiveContainer, ... } from 'recharts';` is the only recharts importer (grep across src returns only this file).
- **Fix:** Stop forcing recharts into a named manualChunk so Rollup can keep it inside the AIChatPage lazy graph (see separate manualChunks finding), OR replace recharts in ToolResultCard with the existing visx-based @/components/charts primitives so recharts can be dropped entirely. After the change, re-run the build and confirm charts-*recharts* no longer appears in index.html modulepreload. Verify by inspecting the emitted index.html and the per-chunk import edges.
- **Remediated 2026-05-29** — Removed the `recharts → 'charts'` `manualChunks` rule from `apps/frontend/vite.config.ts`. Rollup now keeps recharts inside the lazy `AIChatPage` async chunk. The `charts-*recharts*` chunk no longer appears in `dist/index.html` as a `modulepreload`, confirmed via production build inspection. A comment in `vite.config.ts` explains the removal. See [[docs/performance/index#Recent Optimizations|Performance — Recent Optimizations]].

### 🟡 performance.6 — No aggregate per-turn timeout: a single chat request can pin a connection and DB/CPU for ~60 minutes

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/services/aiChatService.js` — runChatTurnInner while-loop, lines 231-342; MAX_TOOL_ITERATIONS=6 (line 26); OLLAMA_REQUEST_TIMEOUT_MS default 600000 (env.js:72)
- **Problem:** The tool loop runs up to MAX_TOOL_ITERATIONS=6 Ollama calls, and each individual Ollama call is bounded only by the per-request timeout (default 600000ms = 10 minutes; see withTimeout in client.js). There is no wall-clock deadline for the whole turn. A slow/large model, an adversarially long prompt, or a model that keeps emitting tool calls can therefore keep one HTTP connection (and the associated Node event-loop work + DB scans) busy for up to ~6 x 10 = 60 minutes. The default AI_CHAT_RATE_LIMIT is 30/min (env.js:76), so dozens of such turns can be started inside one minute, and the rate limiter is fully bypassed in development (rateLimiter.js:58-60). On a LAN-exposed single-user box this is a cheap denial-of-service / resource-exhaustion lever.
- **Evidence:** while (iterations < MAX_TOOL_ITERATIONS) { ... response = await ollamaClient.chatStream({ model: activeModel, messages: baseMessages, tools: ... , signal, ... }) } — no overall deadline is created; the only bound is per-call requestTimeoutMs, which defaults to `OLLAMA_REQUEST_TIMEOUT_MS: intEnv(600000)`.
- **Fix:** Introduce a single turn-level AbortController seeded with a max-turn budget (e.g. derive a deadline once in runChatTurnInner and pass a composed signal into every chat/chatStream call), so total model time per turn is capped regardless of iteration count. Consider lowering the default OLLAMA_REQUEST_TIMEOUT_MS (10 minutes per call is very high) and documenting the worst-case turn duration = iterations x per-call timeout.

### 🟡 performance.7 — No cap on tool calls per iteration; each tool can scan 50k-100k rows into memory, amplified across the loop

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/services/aiChatService.js` — for (const rawCall of response.toolCalls) loop, lines 317-341; heavy scans in expenses.js (MAX_ROWS=50_000 line 21; getNetCashflow limit 100_000 line 647), insights.js (SCAN_LIMIT=50_000 line 129), tax.js (limit 100_000 lines 80/261)
- **Problem:** Within each iteration the dispatcher executes every tool_call the model emits with no upper bound on how many calls per iteration are processed. Several tools deliberately pull very large row sets into memory and aggregate in JS: getNetCashflow fetches up to 100_000 transactions, getDeductibles/getTaxableIncomeSummary fetch 100_000, getRecipientInsights scans 50_000, and the expenses helpers scan MAX_ROWS=50_000. A model that emits multiple heavy tool calls per iteration, repeated across 6 iterations, can trigger many full-table-ish scans for one chat request. AI_CHAT_MAX_TOOL_ROWS (default 500) only caps the *returned* row count via .slice(maxRows); it does not cap the rows fetched and aggregated, so the DB+memory cost is unbounded by that setting. This compounds the missing per-turn timeout above.
- **Evidence:** for (const rawCall of response.toolCalls) { const { name, args } = normalizeToolCall(rawCall); ... const result = await dispatchTool(name, args, ...) } — no length check on response.toolCalls. And e.g. getNetCashflow: `const rows = await transactionRepository.getAll({ limit: 100_000, offset: 0, startDate: from, endDate: to, active: true });`.
- **Fix:** Cap the number of tool calls processed per iteration (and/or per turn) to a small constant, returning a TOOL_ERROR for the overflow so the model can adapt. Separately, bound the rows *fetched* by the heavy tools (push aggregation into SQL with GROUP BY, or cap the scan to a sane ceiling and surface truncated:true as getRecipientInsights already does) instead of pulling 50k-100k rows into Node memory per call.

### 🟡 performance.8 — DashboardPage redundantly re-fetches the same monthly-summary and category aggregations already fetched by useFilteredDashboardStats

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/pages/DashboardPage.tsx` — DashboardPage.tsx:65, 71-127
- **Problem:** DashboardPage calls useFilteredDashboardStats() (line 65), which internally fetches the monthly-summary aggregation (filtered) and the category list. The same component then fires its own useQuery for ['monthlySummary','filtered',...] and ['monthlySummary','unfiltered',...] (lines 116-127) plus its own ['categories','all'] query (lines 71-75). These hit the same backend aggregation/category data the hook already loaded, but under different query keys, so React Query cannot dedupe them. The result is the dashboard issuing roughly double the network requests for the same money figures, with two independently-cached copies that can drift in freshness.
- **Evidence:** Line 65 `const { data: statsData ... } = useFilteredDashboardStats();` (which calls apiClient.getAggregationMonthlySummary + getCategories internally) coexisting with lines 116-118 `queryKey: ['monthlySummary', 'filtered', targetCurrency, filteredExclusionParams], queryFn: () => apiClient.getMonthlyFinancialSummary(...)` and lines 71-73 `queryKey: ['categories', 'all'], queryFn: () => apiClient.getCategories({ limit: 1000 })`.
- **Fix:** Consolidate the dashboard's data needs into useFilteredDashboardStats (or a sibling hook) so the monthly-summary and category list are fetched once under shared keys and reused. If filtered+unfiltered monthly summaries are genuinely both needed, return both from the hook rather than re-querying in the page.

### 🟡 performance.9 — Per-row duplicate-check SELECT inside the import commit row loop (N+1)

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/importPipeline/commit.js` — commitBatch row loop (lines 73-195)
- **Problem:** For every staged row the loop issues a separate field-based duplicate-check SELECT against transactions (lines 96-109) plus SAVEPOINT / INSERT / staging UPDATE / RELEASE — roughly five round-trips per imported row. With COMMIT_CHUNK=1000 and large CSVs this is tens of thousands of sequential per-row queries. The dup-check SELECT in particular is a classic N+1: it could be replaced by a set-based anti-join or by relying on the existing partial unique index on tx_hash (uniq_transactions_tx_hash, migration 0036) with ON CONFLICT, which the INSERT already uses (line 151). The per-row SELECT largely duplicates the guarantee the unique index gives.
- **Evidence:** for (const row of chunk) { ... const dupCheck = await client.query(`SELECT t.id FROM transactions t WHERE t.date = $1 AND t.amount = $2 AND (...) AND COALESCE(TRIM(t.memo), '') = $4 AND t.is_active = true LIMIT 1`, [dateStr, row.amount, effectiveRecipientId, memoNorm]); ... await client.query(`SAVEPOINT ${sp}`); ... INSERT ... ON CONFLICT (tx_hash) ... }
- **Fix:** Pre-compute existing duplicates for the whole chunk in one query (e.g. a single SELECT keyed on (date, amount, recipient_id, memo) using = ANY/VALUES join, or a temp staging join), then skip matches in JS. Where tx_hash is present, lean on the ON CONFLICT path and drop the per-row field SELECT. This collapses ~5 round-trips/row toward a small constant per chunk.

### 🟡 performance.10 — mv_category_totals re-aggregates entire transaction history on every debounced mutation

- **Severity:** medium · **Effort:** large · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/materializedViewService.js` — mv_category_totals definition (61-81) + refreshMaterializedViews (171-218); triggered from routes/transactions.js:322,346,437,535,564,576
- **Problem:** Every single-row transaction create/update/delete calls scheduleRefresh() (routes/transactions.js), which after a 1s debounce runs REFRESH MATERIALIZED VIEW CONCURRENTLY on all four legacy MVs. Three of them are date-windowed (12/6 months) but mv_category_totals is all-time: it GROUP BYs the entire active transactions table with no date bound on every refresh. CONCURRENTLY also internally builds the full new result and diffs it, so cost scales with total history, not with the change. On a large dataset, a burst of edits triggers repeated full-history re-aggregation. The trigger-maintained agg_recipient_totals/agg_split_outstanding tables show the incremental pattern that mv_category_totals does not follow.
- **Evidence:** CREATE MATERIALIZED VIEW IF NOT EXISTS mv_category_totals AS SELECT ... COUNT(*) AS count, SUM(t.amount) AS total, t.currency FROM transactions t ... WHERE t.is_active = true GROUP BY ... (no date window). refreshMaterializedViews: MATERIALIZED_VIEWS.map(view => query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`)).
- **Fix:** Either back category totals with a trigger-maintained aggregate table (like agg_recipient_totals) so single-row edits are O(1), or bound mv_category_totals to a rolling window plus a separate rarely-refreshed all-time rollup. At minimum, decouple single-row-edit refresh cadence from the all-time view (e.g. refresh it on a nightly cron / after imports only, not on every debounced row edit).

### 🟡 performance.11 — Net-worth bank history does day x account lateral lookups (cardinality blow-up)

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/node-backend/src/repositories/infoRepositoryNetWorth.js` — getNetWorthFromSnapshots bankHistory CTE (71-104)
- **Problem:** The bank balance history builds days = generate_series(first_data_date .. CURRENT_DATE) CROSS JOIN account_list, then for each (day, account) pair runs a LEFT JOIN LATERAL correlated subquery picking the latest balance <= that day. This is O(days x accounts) lateral index probes. For several years of history and a handful of accounts that is thousands of probes per net-worth call, and the result row count (days x accounts) is materialized before the WHERE filter. The supporting index idx_transactions_bank_date_active makes each probe an index seek, so it is not catastrophic, but the quadratic-ish cross-join shape is the dominant cost of this endpoint.
- **Evidence:** days AS (SELECT generate_series(start_date, end_date, interval '1 day')::date AS day FROM bounds), account_list AS (SELECT DISTINCT bank_account ...) SELECT ... FROM days d CROSS JOIN account_list a LEFT JOIN LATERAL (SELECT t.currency, t.balance FROM transactions t WHERE ... AND t.bank_account = a.bank_account AND t.date <= d.day ORDER BY t.date DESC, t.id DESC LIMIT 1) lb ON true
- **Fix:** Replace the per-day lateral with a step-function approach: select one balance row per (account, date-of-change), then forward-fill in SQL with a window LAST_VALUE/gap-fill, or compute daily account balances once and forward-fill in JS (the code already forward-fills investments per day). This turns O(days x accounts) probes into a single ordered scan per account.

### 🟡 performance.12 — VirtualDataTable recomputes full-dataset processedRows on every search keystroke even in server-search mode

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/components/shared/VirtualDataTable.tsx` — processedRows useMemo, lines 286-320 (dep `localSearchQuery`)
- **Problem:** `localSearchQuery` is updated synchronously on every keystroke (handleSearchInput, line 140) and is a dependency of the `processedRows` useMemo. In server-search mode (`isServerSearch` true, the transactions table's configuration) the search-filter body is skipped (line 297 `if (!isServerSearch && ...)`), but the memo still re-runs `deferredData.map((row, sourceIndex) => ({ row, sourceIndex }))` over the whole loaded dataset on each keystroke, re-allocating the entire IndexedRow array and (in client-sort mode) re-sorting. `useDeferredValue(data)` defers data changes but does nothing to defer the keystroke-driven recompute. The result feeds the virtualizer's `count`, so the work is pure waste in server-search mode.
- **Evidence:** line 281 `const deferredData = useDeferredValue(data);`; line 287 `let result: IndexedRow<T>[] = deferredData.map((row, sourceIndex) => ({ row, sourceIndex }));`; line 320 dep array contains `localSearchQuery`; line 297 `if (!isServerSearch && localSearchQuery.trim()) {`
- **Fix:** Drop `localSearchQuery` from the `processedRows` dependency array when `isServerSearch` is true (e.g. compute an `effectiveSearch = isServerSearch ? '' : localSearchQuery` and depend on that), so server-mode keystrokes don't re-map the dataset. The displayed input value already lives in its own state and is unaffected.

### 🟡 performance.13 — PlannedPaymentsPage builds a non-memoized columns array, forcing DataTable to re-run its filter/sort pipeline every render

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/pages/PlannedPaymentsPage.tsx` — line 129 `const columns = [ ... ]`
- **Problem:** `columns` is a plain array literal recreated on every render of PlannedPaymentsPage (no `useMemo`, unlike every other table page which uses `useMemo`/`useDataTableColumns`). It is passed to `DataTable`, whose `processedRows` useMemo lists `columns` as a dependency (DataTable.tsx:255). So any state change on the page (form open/close, dialog toggles, filter state) gives `columns` a new identity and re-runs the full map/filter/sort pipeline plus the column-width re-seed effect (DataTable.tsx:133). This directly violates the project's own `useDataTableColumns` convention documented at hooks/useDataTableColumns.ts:6 ('Without memoization, inline column arrays cause the table to re-render every time the parent renders').
- **Evidence:** PlannedPaymentsPage.tsx:129 `const columns = [` (no useMemo); DataTable.tsx:255 `}, [data, columnFilters, localSearchQuery, isServerSearch, sortKey, sortDir, columns]);`; rows source is `useMemo` (line 91) but columns is not.
- **Fix:** Wrap the columns array in `useMemo` (or the project's `useDataTableColumns` helper) with deps `[t, ...callbacks]`, matching TransactionsTable/OwesPage/RecipientsPage.

### 🟡 performance.14 — PlannedPaymentsPage renders up to 1000 rows through the non-virtualized DataTable

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/frontend/src/pages/PlannedPaymentsPage.tsx` — DataTable usage line 466-472; data from usePlannedPayments (limit 1000, usePlannedPayments.ts:211)
- **Problem:** The planned-payments list is fetched with `limit: 1000` and rendered through `DataTable`, which is the non-virtualized table — its body does `processedRows.map(...)` and emits one TableRow per item directly into the DOM (DataTable.tsx:487), with no pagination passed (no `page`/`totalItems`/`onPageChange` props). At the upper bound that is up to 1000 fully-rendered rows, each with multiple buttons/badges, all live in the DOM at once. The repo already ships `VirtualDataTable` for exactly this scenario and uses it for the transactions/recipients/owes lists. While typical planned-payment counts are small (so this is a latent rather than constant cost), the unbounded fetch + non-virtualized render is a real scaling cliff.
- **Evidence:** usePlannedPayments.ts:209-211 `apiClient.getPlannedTransactions({ ... limit: 1000 })`; PlannedPaymentsPage.tsx:466 `<DataTable ... data={rows} />` with no pagination props; DataTable.tsx:487 `processedRows.map(({ row, sourceIndex }, visibleIndex) => { ... <TableRow ...>`
- **Fix:** Either switch this list to `VirtualDataTable`, or pass pagination props (`page`/`pageSize`/`totalItems`/`onPageChange`) to DataTable so the DOM row count is bounded. If planned payments are guaranteed small in practice, at minimum lower the fetch `limit` to a sane page size to cap the worst case.

### 🟡 performance.15 — manualChunks over-grouping forces lazy-only vendors into the eager startup graph

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/vite.config.ts` — manualChunks() lines 53-86
- **Problem:** manualChunks assigns vendors to fixed named chunks by package name regardless of whether they are statically or dynamically reachable. When a named chunk (here `charts` = recharts) contains any module also imported by eagerly-loaded app code, Rollup must mark the whole named chunk as a startup dependency and preload it — defeating the lazy boundary the React.lazy routes establish. This is exactly what happens with recharts (see the high-severity finding): grouping it into a named chunk caused the eager AppSettingsContext's shared import to pull all of recharts into the initial modulepreload set. Hand-rolled manualChunks generally fight Vite's automatic per-dynamic-import chunking and tend to enlarge, not shrink, the initial payload.
- **Evidence:** vite.config.ts:71-73 `if (norm.includes('/recharts') || norm.includes('+recharts')) { return 'charts'; }`. Build result: charts-DCPECQsp.js (recharts) is statically imported by entry index-B2rWNTzj.js (`grep` shows `import{q as t}from"./charts-DCPECQsp.js"` in the entry, 0 dynamic import() of that chunk) and is modulepreloaded in index.html line 15.
- **Fix:** Prefer letting Vite/Rolldown derive chunks automatically for code reachable only via dynamic import; reserve manualChunks for genuinely always-eager vendors (react, react-dom, router). At minimum, do not place a library that is only used behind a lazy route (recharts) into a manualChunk. Re-build and diff the index.html modulepreload list before/after to confirm the eager set shrinks.

### ⚪ performance.16 — Recipient list re-runs alias-count full GROUP BY on every page/read

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/repositories/recipientRepository.js` — getAll/getById/update alias_count subquery (94-99, 137-142, 251-256)
- **Problem:** getAll, getById and update each embed an inline derived table that scans all recipients with primary_recipient_id IS NOT NULL and GROUP BY primary_recipient_id to compute alias_count, joined back per result row. This aggregate over the whole recipients table is recomputed on every recipient list page render and every single getById. recipients is usually small so impact is limited, but it is repeated work on a frequently hit endpoint and the same subquery is duplicated in three places (DRY).
- **Evidence:** LEFT JOIN ( SELECT primary_recipient_id, count(*)::int AS alias_count FROM recipients WHERE primary_recipient_id IS NOT NULL GROUP BY primary_recipient_id ) ac ON ac.primary_recipient_id = r.id  — duplicated verbatim in getAll (94-99), getById (137-142), update (251-256).
- **Fix:** There is an index idx_recipients_primary_recipient_id, so the GROUP BY is cheap, but consider a correlated COUNT only for the rows on the page (or a trigger-maintained alias_count column) and extract the shared join fragment into one constant to remove the triplicated SQL.

### ⚪ performance.17 — ensureSymbolIsUnique uses LOWER(symbol) with no functional index

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/repositories/investmentRepository.js` — ensureSymbolIsUnique (126-135)
- **Problem:** Symbol uniqueness checks on investment create/update run WHERE LOWER(symbol) = LOWER($1). The schema (migration 0001) indexes investments only on asset_class and is_active — there is no index on symbol or on LOWER(symbol), so this check is a sequential scan with a per-row LOWER() evaluation. The investments table is small (typically tens of rows), so practical impact is minor, but the case-insensitive predicate cannot use any index and runs on every create/update.
- **Evidence:** await query('SELECT id FROM investments WHERE LOWER(symbol) = LOWER($1) AND id <> $2 LIMIT 1', [symbol, excludeId]); — and grep of 0001 indexes shows idx_investments_asset_class and idx_investments_is_active only, no symbol index.
- **Fix:** If symbol must be globally unique case-insensitively, add a unique functional index CREATE UNIQUE INDEX ON investments (LOWER(symbol)) WHERE symbol IS NOT NULL (which also enforces the constraint at the DB level instead of via a check-then-insert race). Otherwise leave as-is given table size, but document the intentional seq scan.

### ⚪ performance.18 — English fallback locale is always downloaded in addition to the active locale for non-English users

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/frontend/src/contexts/LanguageContext.tsx` — useEffect lines 57-66 (englishLoader) plus useEffect lines 68-79 (active loader)
- **Problem:** The first effect unconditionally loads the `en` dictionary as a fallback on every mount, and the second effect loads the active locale. For a Dutch user this means both en (dist en-*.js = 146 kB raw / 38.9 kB gz) and nl (156 kB raw / 41.9 kB gz) are fetched and parsed at runtime — roughly 81 kB gz of locale JS for one language. The locale code-splitting itself is correct (neither locale is in the eager index.html modulepreload, so this is runtime-after-paint, not first-paint cost), but the always-on en fallback doubles locale weight for any non-en user even when the active dictionary is complete.
- **Evidence:** LanguageContext.tsx:57-66 effect calls englishLoader() guarded only by `if (dicts.en) return;`. t() (lines 81-93) falls back `dict?.[key] ?? enDict?.[key] ?? key`. Build: dist/assets/en-B9dNpMNE.js 146.69 kB (38.88 gz), nl-cDgN4htU.js 156.75 kB (41.91 gz); neither preloaded in index.html (modulepreload count 0).
- **Fix:** Load the en fallback lazily only when a key is missing from the active dictionary (or skip it entirely when the active locale is en, since the second effect already loads en in that case). Given dictionaries are generated from the same source and should be key-complete, the eager fallback is usually wasted bytes for nl users.

### ⚪ performance.19 — All Radix UI primitives bundled into one monolithic preloaded chunk

- **Severity:** low · **Effort:** medium · **Confidence:** low
- **Location:** `apps/frontend/vite.config.ts` — manualChunks() lines 74-76 (radix-ui branch)
- **Problem:** manualChunks groups every @radix-ui/* primitive (25+ packages in package.json: accordion, menubar, navigation-menu, hover-card, context-menu, slider, etc.) into a single `radix-ui` chunk. The build emits radix-ui-DYIwDIjF.js at 146 kB raw / 44.7 kB gz and preloads it on initial load (index.html line 20). Many of these primitives (menubar, navigation-menu, context-menu, hover-card, slider, aspect-ratio, input-otp-adjacent) are only used on specific pages/dialogs, but the monolithic chunk forces all of them into the first-paint payload. Splitting is less clear-cut than recharts because some Radix primitives are used in the always-loaded shell, but the all-or-nothing grouping defeats per-route loading for the rarely-used ones.
- **Evidence:** vite.config.ts:74 `if (norm.includes('@radix-ui/') || norm.includes('@radix-ui+')) { return 'radix-ui'; }`. dist/assets/radix-ui-DYIwDIjF.js 146.31 kB / gzip 44.70 kB; index.html line 20 `<link rel="modulepreload" ... href="/assets/radix-ui-DYIwDIjF.js">`. package.json lines 26-52 list 27 @radix-ui/* deps.
- **Fix:** Either drop the radix-ui manualChunk so each primitive co-locates with the route/dialog chunk that uses it, or split into a small 'radix-core' (only the primitives used by AppLayout/shell) vs the rest. Measure the eager radix payload before/after via index.html modulepreload to confirm reduction; verify shell dialogs still resolve their primitives.

## Architecture (8)

🟠 0 high · 🟡 5 medium · ⚪ 3 low

### 🟡 architecture.1 — Routes pervasively bypass the services layer and import repositories / the DB pool directly, defeating the enforced layering rule

- **Severity:** medium · **Effort:** large · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/transactions.js` — 15 route files carry `// eslint-disable-next-line vision-local/no-repo-direct-from-route`; 4 routes import database/connection directly
- **Problem:** The project ships a custom ESLint rule (eslint.config.js:24-53, no-repo-direct-from-route) whose stated intent is 'routes must delegate data access to the services layer.' In practice 15 of 19 route files suppress it with an inline eslint-disable and import repositories straight into the handler, and 4 routes (transactions, plannedTransactions, attachments, admin) import the raw pg pool via database/connection.js and run ad-hoc SQL inside handlers. The rule is configured as 'warn' precisely so violations don't block CI, so the architectural boundary it documents is effectively decorative — the route layer is doing repository AND service work. Concrete leakage: transactions.js:140-178 (resolveRecipientNameToId / resolveCategoryNameToId run their own SELECTs against recipients/categories), transactions.js:262-320 (bulk-tag resolves tag slugs and runs INSERT/DELETE SQL inline), plannedTransactions.js:36-73 (recipient/category name resolution via dbQuery). This is business logic and data access living in HTTP handlers.
- **Evidence:** eslint.config.js:122-125 `'vision-local/no-repo-direct-from-route': 'warn'` // warn: existing violations surface without blocking; treat as tech-debt. transactions.js:9-10 `// eslint-disable-next-line vision-local/no-repo-direct-from-route` then `import transactionRepository from '../repositories/transactionRepository.js';`. transactions.js:8 `import { query as dbQuery, withTransaction } from '../database/connection.js';` used directly in handlers (e.g. line 143, 262, 392).
- **Fix:** Pick one boundary and enforce it. Either (a) introduce thin service modules (transactionService, plannedTransactionService) that own name→id resolution, bulk-tag, and bulk-update SQL, and flip the rule to 'error' once routes are migrated; or (b) explicitly retire the rule and document that repositories are a valid direct dependency for routes. The current half-state — a rule that exists, is documented as mandatory, and is universally suppressed — is the worst of both: it implies a guarantee the codebase does not keep.

### 🟡 architecture.2 — features/ vs components/ migration is half-finished; import feature is split across two parallel directories with a back-reference

- **Severity:** medium · **Effort:** large · **Confidence:** high
- **Location:** `apps/frontend/src/pages/ImportPage.tsx` — ImportPage.tsx:5-10; features/imports/TransactionImportCard.tsx:22
- **Problem:** The import surface lives in two parallel directories at once: features/imports/ (TransactionImportCard, RecipientsImportCard, CategoriesImportCard, ExportCard, SupportedBanksCard) and components/import/ (CsvColumnMapper, ImportHistoryCard) — note the plural 'imports' vs singular 'import'. ImportPage imports from BOTH, and a feature component reaches back into components/ (features/imports/TransactionImportCard imports @/components/import/CsvColumnMapper). The same split-brain exists for transactions (features/transactions/* AND components/dashboard, components/statistics, components/splits, components/shared/CategoryCombobox/RecipientCombobox), categories (features/categories/AddCategoryDialog with no components/categories peer), and recipients. There is no consistent rule for what belongs in features/ vs components/, so contributors cannot predict where a given piece of UI lives, and feature boundaries are not enforced.
- **Evidence:** ImportPage.tsx:5 `import { ImportHistoryCard } from "@/components/import/ImportHistoryCard";` and lines 6-10 `import { TransactionImportCard } from "@/features/imports/TransactionImportCard"; ...`. features/imports/TransactionImportCard.tsx:22 `import { CsvColumnMapper } from "@/components/import/CsvColumnMapper";`. Directory listing shows both `components/import/` (singular) and `features/imports/` (plural) coexisting.
- **Fix:** Pick one organizing axis and finish the migration. Either complete the move into feature folders (consolidate components/import/* into features/imports/, components/statistics into features/statistics, etc.) or roll back to components/-by-type. Document the rule in AGENTS.md / docs/architecture. At minimum, move CsvColumnMapper and ImportHistoryCard into features/imports/ so the feature stops reaching back into components/import/.

### 🟡 architecture.3 — Pure utilities hand-mirrored across frontend/backend instead of shared in packages/

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/lib/slugify.ts` — slugify.ts:5-13 (and lib/money.ts, utils/downsample.ts, utils/currency.ts)
- **Problem:** Several pure, logic-identical utilities are duplicated by hand across the workspace boundary rather than living in a shared package. The duplicates even carry self-referential comments admitting the mirror ('Mirrors apps/node-backend/src/lib/slugify.js', 'Frontend money helpers — mirror of apps/node-backend/src/lib/money.js', 'Ported from apps/frontend/src/utils/downsample.ts'). The monorepo already has a packages/* workspace (only packages/types today), so the sharing mechanism exists. Mirrored copies drift independently: any fix to one (e.g. the LTTB tail-bucket fix) must be manually re-applied to the other.
- **Evidence:** frontend slugify.ts: `.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')` is byte-for-byte the same chain as backend lib/slugify.js:17-23. downsample.ts and node-backend/src/utils/downsample.js share the identical algorithm AND the identical multi-line tail-bucket fix comment. money.ts header literally says 'mirror of apps/node-backend/src/lib/money.js'.
- **Fix:** Extract slugify, the Decimal money helpers (toDecimal/addAll/multiply/divide/roundMoney/toNumber), and downsampleLTTB into a shared workspace package (e.g. packages/shared-utils) and import from both apps. Keep the JS/TS surface thin if dual-runtime is a concern, but maintain a single source of truth.

### 🟡 architecture.4 — getStatistics duplicates getCategoryBreakdown's query and aggregation wholesale

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/repositories/infoRepositoryStatistics.js` — getStatistics (lines 16-80) vs getCategoryBreakdown (lines 82-121)
- **Problem:** getStatistics is effectively getCategoryBreakdown plus a count/total wrapper, yet it reimplements both the materialized-view fast path and the live fallback (the full category JOIN query and the catMap reduce+sort loop) verbatim. The category-aggregation SQL and the catMap building block are duplicated, so a change to category attribution logic (e.g. the COALESCE(t.category_id, r.default_category_id) join) must be edited in two places in money-handling code.
- **Evidence:** Both methods contain the identical fallback SQL `SELECT COALESCE(c.id, -1) AS category_id, ... FROM transactions t LEFT JOIN recipients r ... LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id WHERE t.is_active = true` and the identical `for (const row of catConverted){... catMap[key]...}` aggregation. diff of lines 60-79 vs 104-121 shows the catMap block is the same.
- **Fix:** Have getStatistics call getCategoryBreakdown (or a shared private buildCategoryTotals(targetCurrency) helper) for the categories array, then derive total_transactions and total_amount from it. Removes ~50 duplicated lines and a redundant full-table scan path.

### 🟡 architecture.5 — MarketLookupPage bypasses the lib/api client and validates JSON with inline `as` casts

- **Severity:** medium · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/frontend/src/pages/MarketLookupPage.tsx` — MarketLookupPage.tsx:165, 178, 194, 207 (and raw fetch calls at 176, 191, 205)
- **Problem:** All other server access goes through the `lib/api/` client layer, but this page calls `fetch()` directly and casts the parsed JSON with `await res.json() as { data: { quotes: Quote[] } }`. The cast asserts a shape that is never verified — malformed or partial responses (e.g. missing `data`, `quotes` undefined) will throw deep in rendering rather than at the boundary, and the project convention calls for Zod validation at input boundaries (currently Zod is used in only one file, `lib/env.ts`). Inlining API access plus shape-casting in a page component also couples the page to the wire format and duplicates envelope-unwrapping logic.
- **Evidence:** `const envelope = await res.json() as { data: { quotes: Quote[] } }; return envelope.data.quotes[0] || null;` Four such inline-cast fetches in this page; grep shows raw `fetch(` only in a handful of files, most of which are the `lib/api/` client itself.
- **Fix:** Move the market quote/chart/news/search fetches into `lib/api/` functions and validate the envelope with a small Zod schema (`z.object({ data: ... })`) before returning, so a bad response fails with a clear error at the boundary. The page then consumes typed, validated data.

### ⚪ architecture.6 — infoRepository family is fragmented across 11 files with two parallel naming schemes and a barrel that hides the split

- **Severity:** low · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/node-backend/src/repositories/infoRepository.js` — repositories/ — infoRepository.js, infoRepositoryBanks/Helpers/Monthly/NetWorth/Planned/Recipients/Statistics.js, plus infoRepo.forecast.js / infoRepo.monthly.js / infoRepo.statistics.js
- **Problem:** The 'info' data-access concern is spread over 11 files under two inconsistent naming conventions: infoRepository*.js (camelCase suffix) AND infoRepo.*.js (dotted). There are near-duplicate names that are NOT the same module — infoRepositoryMonthly.js (800 bytes) vs infoRepo.monthly.js (182 lines), and infoRepositoryStatistics.js vs infoRepo.statistics.js — which is a real trap for anyone navigating by filename. The barrel (infoRepository.js) spreads six sub-repositories into one object so consumers see a single flat API, but that flattening also masks the sprawl and makes it ambiguous which file owns a given method. This reads as incomplete-refactor residue rather than deliberate cohesion: a single 'info/statistics' domain has been sliced thinly enough that the slicing itself is now the maintenance cost.
- **Evidence:** infoRepository.js:21-34 spreads `statisticsRepository, monthlyRepository, banksRepository, netWorthRepository, plannedRepository, recipientInsightsRepository` into one object; directory listing shows both `infoRepositoryMonthly.js` and `infoRepo.monthly.js`, and both `infoRepositoryStatistics.js` and `infoRepo.statistics.js` coexisting.
- **Fix:** Consolidate under one naming scheme and one directory (e.g. repositories/info/ with statistics.js, monthly.js, netWorth.js, banks.js, planned.js, recipients.js, forecast.js, helpers.js). Delete the stale near-duplicate (infoRepositoryMonthly.js 800B looks vestigial next to infoRepo.monthly.js 182 lines — confirm which is live and remove the other). Keep the barrel but make the file layout self-explanatory.

### ⚪ architecture.7 — Mutation hooks bind to useLanguage's t() purely for toast strings, coupling data layer to i18n context and recreating mutations on locale change

- **Severity:** low · **Effort:** medium · **Confidence:** medium
- **Location:** `apps/frontend/src/hooks/useTransactions.ts` — useTransactions.ts:48, 65, 86, 102; mirrored in useCategories.ts and useRecipients.ts
- **Problem:** Every mutation hook (useCreateTransaction, useUpdateTransaction, useDeleteTransaction, useBulk*, and the equivalents in useCategories.ts / useRecipients.ts) calls useLanguage() solely to localize toast messages. This couples the server-state/data layer to the i18n React context: any component using these mutations now also subscribes to LanguageContext (152 useLanguage consumers exist), and the mutation closures are rebuilt whenever the active locale changes. It also means side-effect UI (toasts) is hard-wired inside reusable data hooks rather than handled at the call site, reducing their reusability and testability.
- **Evidence:** useTransactions.ts:48 `const { t } = useLanguage();` inside useCreateTransaction, with onSuccess `toast.success(t('transactions.created'));` and onError `toast.error(t('transactions.createFailedTitle'), ...)`. The identical pattern repeats in useUpdateTransaction (65), useDeleteTransaction (86), the bulk hooks, and across useCategories.ts:25/45/61 and useRecipients.ts:25/45/61/77/111.
- **Fix:** Keep the data hooks i18n-free: have them throw/return typed results and let the calling component (which already has useLanguage) render toasts, or pass a small onSuccess/onError messaging adapter. Alternatively expose a stable translate function (e.g. an imperative i18n.t outside React) so mutation hooks don't subscribe to context. This is a consistent pattern, not a one-off, which is why it is worth flagging.

### ⚪ architecture.8 — Large page components concentrate ~300 lines of logic plus ~400 lines of JSX in one function

- **Severity:** low · **Effort:** large · **Confidence:** medium
- **Location:** `apps/frontend/src/pages/TaxOverviewPage.tsx` — TaxOverviewPage.tsx:58-759 (single default-export component; JSX return spans 357-759); similar: PortfolioTaxPage.tsx (727), MarketLookupPage.tsx (636), DashboardPage.tsx (554)
- **Problem:** Several page components are 550-760 lines in a single function — under the 800-line hard cap but well past the 200-400 'typical' guidance, and the render body alone is far longer than the 50-line function guideline. The logic is decomposed into useMemo/useCallback blocks, but the JSX is a single monolithic return, which makes these pages hard to review, test in isolation, and reuse. This is a maintainability pattern across the tax/portfolio/market pages rather than a one-off.
- **Evidence:** `export default function TaxOverviewPage() {` at line 58 with `return (` at line 357 and file ending at 759; each of the four named pages has exactly one exported component spanning the bulk of the file.
- **Fix:** Extract cohesive JSX sections into presentational subcomponents (e.g. `TaxIncomeSummaryCard`, `MonthlyTaxChartSection`) and move data-shaping useMemo logic into custom hooks (`useTaxOverviewData`). Aim each page back toward the 200-400 line range with focused children.

## Dependencies (4)

🟠 0 high · 🟡 2 medium · ⚪ 2 low

### 🟡 dependency.1 — Root `overrides`/`resolutions` pin exact patch versions that can silently downgrade workspace requirements (vite)

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `package.json` — lines 65-90 (overrides + resolutions); specifically vite at lines 67 and 81
- **Problem:** The root forces `vite: "8.0.8"` exact, but apps/frontend/package.json:126 declares `"vite": "^8.0.13"`. The override wins, so the workspace resolves to 8.0.8 (confirmed in bun.lock) — an OLDER version than the workspace explicitly asks for, defeating the stated minimum and any fixes in 8.0.9-8.0.14. Exact-version overrides like this (`flatted 3.4.2`, `basic-ftp 5.3.1`, `picomatch 4.0.4`, `lodash 4.18.1`) rot quietly: when an upstream advisory lands in the pinned patch line, the pin keeps you on the vulnerable build and silently overrides any in-tree request for a fixed version. For security-sensitive transitive libs (qs, postcss, path-to-regexp) the project correctly used floor ranges (`>=`); the exact pins are the inconsistent, riskier subset.
- **Evidence:** package.json:67 `"vite": "8.0.8"` vs apps/frontend/package.json:126 `"vite": "^8.0.13"`; bun.lock resolves `vite@8.0.8`. Registry shows 8.0.13/8.0.14 available.
- **Fix:** Reserve overrides for forcing security floors and express them as `>=` ranges, not exact patch pins. Remove the exact `vite: 8.0.8` pin (or raise it to `>=8.0.13` to match the workspace) so an override never downgrades a declared dependency. Re-audit each exact pin and convert to a floor range unless an exact value is required to dodge a specific broken release.

### 🟡 dependency.2 — Two charting libraries shipped (recharts + visx) where visx already covers every use case

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/package.json` — dependencies: "recharts": "^3.8.1" (line 84) vs @visx/* (lines 58-64) + d3-* (lines 68-70)
- **Problem:** The app maintains a complete visx-based chart system in apps/frontend/src/components/charts/ (AreaChart, BarChart, LineChart, PieChart, DonutChart, StackedBarChart, Sparkline, plus axes/legend/tooltip) used by ~28 modules across dashboard, statistics, portfolio and tax pages. recharts is a second, fully overlapping charting library used by exactly one file (ToolResultCard.tsx) to render line/bar/pie views of AI tool results — capability the visx LineChart/BarChart/PieChart already provide. This duplicates ~114 kB gzip of dependency weight and creates two divergent chart-styling systems to maintain.
- **Evidence:** src/components/charts/index.ts:1 comment `Chart primitives — visx + framer-motion`. `grep -rln recharts src` returns only features/ai-chat/ToolResultCard.tsx. ToolResultCard.tsx:198-204 uses recharts `<ResponsiveContainer><LineChart><CartesianGrid/><XAxis/><YAxis/><Tooltip/>` for the same line/bar/pie rendering the visx primitives expose.
- **Fix:** Port ToolResultCard's LineChartView/BarChartView/PieChartView to the existing @/components/charts visx primitives, then remove the recharts dependency from package.json. This both deletes a redundant library and resolves the eager-preload finding above.

### ⚪ dependency.3 — Electron `overrides` uses bun-only syntax that npm (the actual installer in release) ignores

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `packaging/electron/package.json` — lines 24-26 ("overrides": { "brace-expansion@5.0.5": "5.0.6" })
- **Problem:** The electron workspace ships BOTH a `bun.lock` and a `package-lock.json`, and the release/verify jobs install it with npm (`npm install --prefix packaging/electron`, release.yml:256/125, ci.yml:347), not bun. The override is written in bun's `"<pkg>@<ver>": "<replacement>"` form, which is NOT valid npm `overrides` syntax (npm expects `"overrides": { "brace-expansion": "5.0.6" }`). The package-lock.json records no `overrides` key at all. brace-expansion did resolve to 5.0.6 in the lock, but only because the natural tree happened to land there — the pin is not actually enforcing anything under the toolchain that builds releases. Any future security pin added this way will silently be a no-op for the shipped app.
- **Evidence:** package.json:24-26 `"overrides": { "brace-expansion@5.0.5": "5.0.6" }`; package-lock.json has no "overrides" key (grep returned nothing) yet contains two lockfiles (`packaging/electron/bun.lock` and `packaging/electron/package-lock.json`) describing the same tree.
- **Fix:** Pick one package manager for the electron workspace and delete the other lockfile. If npm is the release installer, rewrite the override in npm syntax (`"overrides": { "brace-expansion": "5.0.6" }`) so security pins are actually honored when the shipped .dmg is built.

### ⚪ dependency.4 — Dead `rollup` override/resolution and yarn-only `resolutions` block under bun

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `package.json` — lines 66/79 (rollup) and the entire resolutions block 78-90
- **Problem:** Two inert constructs add confusion to the supply-chain config: (1) `rollup` is pinned as override `>=4.59.0` and resolution `4.59.0`, but rollup is never resolved in bun.lock (it appears only on the override declaration line; vite 8 uses rolldown). The pin protects nothing. (2) bun honors the `overrides` field; `resolutions` is yarn's field and is ignored by bun. The repo carries a near-duplicate `resolutions` block (the only divergence is rollup: override range `>=4.59.0` vs resolution exact `4.59.0`), so a reader cannot tell which one is authoritative and a security bump made in only one place would appear applied but not be.
- **Evidence:** bun.lock line 165 is the sole rollup reference: `"rollup": ">=4.59.0",` with no resolved `rollup@x.y.z` package entry. package.json keeps both `overrides` (65-77) and `resolutions` (78-90) that differ only at rollup.
- **Fix:** Drop the rollup pins (dead) and remove the `resolutions` block (bun ignores it) — or, if multi-tool support is intended, add a comment and keep the two blocks byte-for-byte identical via tooling so they can't drift. Consolidating to a single authoritative `overrides` block removes the ambiguity.

## UX & Accessibility (21)

🟠 5 high · 🟡 11 medium · ⚪ 5 low

### 🟠 ux.1 — VirtualDataTable renders the core data grid with no table semantics or ARIA roles

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/shared/VirtualDataTable.tsx` — header div lines 482-557; body rows lines 561-676
- **Problem:** The virtualised data grid that backs core surfaces (transactions via RecipientsPage, OwesPage, RecipientInsightsPage, SnapshotDataTable) is built entirely from <div>s with no role="table"/"row"/"columnheader"/"cell" and no <table> semantics. A screen reader sees an undifferentiated stack of text with no row/column structure, no header association, and no announced row count. The sibling DataTable.tsx uses real <table>/<th>/<td>, so the same data is accessible in one component and not the other.
- **Evidence:** Header: `<div className="flex items-center bg-muted/50 min-h-[40px]">{columns.map((col) => { ... return (<div key={col.key} className="px-4 py-2 font-semibold...">` — no role/scope. Body: `<div ... className={`flex items-center border-b ... ${onRowDoubleClick ? "cursor-pointer" : ""}`} onDoubleClick={...}>` with cells as `<div key={col.key} className="px-4 py-2 text-sm flex-1...">`.
- **Fix:** Add ARIA grid roles to the div structure: role="table" on the outer container, role="row" on each header/body row, role="columnheader" on header cells, role="cell" on body cells, plus aria-rowcount/aria-colcount. Alternatively render a real semantic table with virtualization (e.g. position the tbody rows) so headers associate with cells.
- **Remediated 2026-05-29** — `VirtualDataTable.tsx` now carries a complete ARIA table role tree: `role="table"` + `aria-rowcount` + `aria-colcount` on the `CardContent` body container; `role="rowgroup"` on the header and body scroll containers; `role="row"` on header and body row divs; `role="columnheader"` + `aria-sort` (reflecting active sort direction) on header cells; `role="cell"` on body cells; `role="presentation"` on the virtualizer sizing div; `aria-rowindex` on each body row. See [[docs/components/shared-components#ARIA Grid Semantics (2026-05-29)|VirtualDataTable ARIA Grid Semantics]].

### 🟠 ux.2 — Double-click-only activation makes rows/cards unreachable by keyboard across 7 surfaces

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/shared/VirtualDataTable.tsx` — VirtualDataTable.tsx:599 onDoubleClick; CategoriesPage.tsx:200; OwesPage.tsx:93 (onClick on div Card); WatchlistPage.tsx:158,165; StocksPage.tsx:342; CryptoPage.tsx:206; InvestmentDetailDialog.tsx
- **Problem:** Primary navigation/open actions are bound to onDoubleClick (or onClick on a non-interactive <div>/<Card>) with no keyboard equivalent. Keyboard users cannot trigger them: a <div> with onDoubleClick is not focusable and has no role; even where a real <button> is used (StocksPage:339, CryptoPage:203) it only has onDoubleClick, and pressing Enter/Space on a button fires `click`, not `dblclick`, so activation is impossible. This blocks opening market lookup, drilling into categories/transactions, and selecting a recipient.
- **Evidence:** VirtualDataTable.tsx:599 `onDoubleClick={() => { if (onRowDoubleClick) onRowDoubleClick(row, sourceIndex); ... }}` on a <div> with no tabIndex/role. OwesPage.tsx:90-93 `<Card ... className="cursor-pointer ..." onClick={() => setSelectedRecipient(...)}>` (Card is a <div>, no role/tabIndex). StocksPage.tsx:339-344 `<button type="button" ... onDoubleClick={() => openMarketLookup(h.symbol)}>` — no onClick / onKeyDown.
- **Fix:** Bind the primary action to onClick (single click) on real <button> elements, or add role="button"/tabIndex={0}/onKeyDown (Enter+Space) to the clickable <div>/<Card>. For double-click affordances, keep dblclick as an enhancement but always provide a keyboard-operable single-action path (e.g. an explicit 'Open' button per row).
- **Remediated 2026-05-29** — Two-part fix. (1) New shared helper `apps/frontend/src/utils/a11y.ts` exports `onActivateKeyDown(handler)`, which fires `handler` on Enter/Space while ignoring events bubbling from nested focusable children. (2) Applied across all 6 affected surfaces: `CategoriesPage` rows, `OwesPage` debtor cards, `WatchlistPage` holding cards (all got `role="button"` + `tabIndex={0}` + `onKeyDown`); `StocksPage` and `CryptoPage` name buttons and `InvestmentDetailDialog` title button (native buttons, just `onKeyDown` added). `VirtualDataTable` rows receive `tabIndex={0}` + an inline Enter/Space handler when `onRowDoubleClick` is set. See [[docs/components/shared-components#onActivateKeyDown (a11y utility)|onActivateKeyDown]] and [[docs/reference/code-patterns#Keyboard Activation Helper — onActivateKeyDown (Frontend, 2026-05-29)|code-patterns entry]].

### 🟠 ux.3 — Portfolio pages cannot distinguish loading/error from empty (usePortfolio drops isLoading/isError)

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/hooks/usePortfolio.ts` — usePortfolio() lines 22-45; consumers StocksPage.tsx:186, CryptoPage.tsx:56, SavingsPage.tsx:52, RealEstatePage.tsx:59
- **Problem:** usePortfolio() destructures only `data` from the investments query and never re-exposes loading or error state: `const { data: invData } = useInvestmentsQuery(); const investments = invData?.items ?? EMPTY_INVESTMENTS;`. Every page built on it (Stocks, Crypto, Savings, RealEstate) gates its empty state purely on `holdings.length === 0`. As a result, during the initial fetch the user sees the 'no stocks / no holdings' EmptyState instead of a loading skeleton, and on a failed fetch they ALSO see the empty state with no error message at all — silently masking a backend/network failure as 'you have no investments'. This is a data-trust problem on the financial-portfolio surface and is inconsistent with the rest of the app (DashboardPage, StatisticsPage, CategoriesPage, RecipientsPage all gate on isLoading/isError).
- **Evidence:** usePortfolio.ts:23 `const { data: invData } = useInvestmentsQuery();` (isLoading/isError discarded). StocksPage.tsx:53 `const { byAssetClass, deleteInvestment, refreshPrices, isRefreshingPrices } = usePortfolio();` then StocksPage.tsx:186 `if (holdings.length === 0) { return ( ... <EmptyState ... title={t(emptyTitleKey)} /> ) }` with no loading/error branch.
- **Fix:** Surface `isLoading` and `isError`/`error` from useInvestmentsQuery() (and the transactions query) through usePortfolio(), then in each portfolio page render a skeleton while loading and a PageError when the query fails BEFORE falling through to the `holdings.length === 0` empty state — mirroring the pattern already used in CategoriesPage.tsx:95-118 and StatisticsPage.tsx:79-108.

### 🟠 ux.4 — All chart screen-reader labels are hardcoded English, never translated

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/charts/chartAria.ts` — summarizeSeriesChart / summarizeProportionChart / summarizeSparkline (lines 11-46) plus all callers
- **Problem:** Every chart in the app renders an <svg role="img"> whose aria-label is generated entirely from hardcoded English by chartAria.ts, with zero involvement of the t() function. The chart kind is passed as a literal at each call site ("Pie chart", "Bar chart", "Line chart", "Stacked bar chart", "Area chart", "Donut chart"), and the helper appends hardcoded words: "with N categories", "segment(s)", "and N more", "Sparkline of N points, ranging X to Y", "Sparkline, no data". A Dutch user with a screen reader hears English descriptions for every chart across dashboards, statistics, portfolio, and tax pages. This is a systemic i18n + a11y gap: the very accessibility feature added to describe charts is monolingual.
- **Evidence:** chartAria.ts line 23: `return `${kind} with ${pluralize(categoryCount, 'category', 'categories')}${seriesPart}`;` and line 45: `return `Sparkline of ${pluralize(finite.length, 'point', 'points')}, ranging ${min} to ${max}`;`. Callers, e.g. PieChart.tsx:66 `aria-label={ariaLabel ?? summarizeProportionChart("Pie chart", data.map((d) => d.name))}` and BarChart.tsx:209 `summarizeSeriesChart("Bar chart", data.length, series.map((s) => s.label))`.
- **Fix:** Pass localized strings into these builders instead of literals. Either (a) thread the t() function (or pre-resolved labels) into the summarize* functions so 'Pie chart', 'with', 'categories', 'ranging X to Y', 'no data' come from translation keys, or (b) have each chart component build its aria-label from t() and pass it as the explicit ariaLabel prop. Add keys like chart.aria.pie, chart.aria.seriesWith, chart.aria.sparkline to both en/nl source. Update chartAria.test.ts accordingly.
- **Remediated 2026-05-29** — `chartAria.ts` now accepts `t` (the `TFn` translator) and a `kindKey` string (e.g. `"chart.aria.kind.bar"`) instead of a hardcoded English label. All 16 `chart.aria.*` keys added to `i18n/source/en.json` and `i18n/source/nl.json` (kind labels + one/other plural fragments for series, segments, and sparkline). All 6 chart components (`PieChart`, `DonutChart`, `BarChart`, `LineChart`, `AreaChart`, `StackedBarChart`, `Sparkline`) now call `useLanguage()` and pass `t` + the appropriate `kindKey` to the generator. See [[docs/i18n/translations#chart.aria and aria namespaces (2026-05-29)|i18n translations — chart.aria namespace]] and [[docs/components/charts#Accessibility|Chart Accessibility]].

### 🟠 ux.5 — 30+ application-code aria-labels hardcoded in English, bypassing t()

- **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/features/transactions/components/TransactionsTable.tsx` — TransactionsTable.tsx:104,241,281 plus ~27 others across pages/ components/ features/
- **Problem:** Icon-only action buttons across the app expose their meaning to screen readers only via aria-label, but those labels are hardcoded English even though every one of these files imports useLanguage and calls t() for visible text. Dutch screen-reader and voice-control users get English-only affordances for core CRUD actions (delete, edit, save, cancel, clear, dismiss, remove, select-all). This is the same defect as the chart labels but in the project's own page/feature code, so it is clearly an oversight rather than a vendored primitive.
- **Evidence:** TransactionsTable.tsx:281 `aria-label="Delete transaction"`, :104 `aria-label="Select all"`, :241 `aria-label="Transaction info"`. Also CategoriesPage.tsx:252 `aria-label="Delete category"`, RecipientsPage.tsx:293 `aria-label="Delete recipient"`, PlannedPaymentsPage.tsx:304/312 Edit/Delete, PortfolioOverviewPage.tsx:400 `aria-label="Delete investment"`, DataTable.tsx:333/534/543/554 Clear search/Save/Cancel/Edit, VirtualDataTable.tsx:438/653/658/665, InvestmentDetailDialog.tsx:472/485/497, AppSidebar.tsx:152 `aria-label="Toggle sidebar"` / :170 `aria-label="Collapse sidebar"`, OnboardingWizard.tsx:225 `aria-label="Close"`, SplitTransactionDialog.tsx:208 `aria-label="Remove entry"`, MergeRecipientsDialog.tsx:111, FilterBanner.tsx:95, RecurringDetectionPanel.tsx:258 `aria-label="Dismiss"`. `grep -c useLanguage` confirms these files already use t().
- **Fix:** Replace each literal with t('...') using existing or new keys (many already exist: common.cancel, common.edit, etc.). Add an ESLint guard (eslint-plugin-jsx-a11y is already implied; pair with a custom rule or grep in CI) to fail on `aria-label="<literal>"` in files that import useLanguage, to prevent regressions.
- **Remediated 2026-05-29** — 27 previously hardcoded English `aria-label` attributes across pages, features, and shared components now use `t()` with new `aria.*` keys. 21 new `aria.*` keys added to `i18n/source/en.json` and `i18n/source/nl.json` and regenerated (`aria.deleteTransaction`, `aria.editPlannedPayment`, `aria.removeFromWatchlist`, `aria.save`, `aria.cancel`, `aria.edit`, `aria.close`, `aria.clearSearch`, `aria.selectAll`, `aria.toggleSidebar`, `aria.collapseSidebar`, `aria.deleteCategory`, `aria.deleteRecipient`, `aria.deleteInvestment`, `aria.deletePlannedPayment`, `aria.editTransaction`, `aria.transactionInfo`, `aria.removeEntry`, `aria.dismiss`, `aria.clearFilter`, `aria.clearSelection`). `validate-locales` clean after regeneration. See [[docs/i18n/translations#chart.aria and aria namespaces (2026-05-29)|i18n translations — aria namespace]].

### 🟡 ux.6 — AddTransactionDialog labels are not associated with their controls (orphaned htmlFor)

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/components/forms/AddTransactionDialog.tsx` — Date label line 84; Recipient label line 109; Category label line 121
- **Problem:** The date <Label htmlFor="tx_date"> targets an id that is never rendered — DatePicker renders a <Button> with no id (see DatePicker.tsx:43-55), so the label points at nothing. The Recipient (line 109) and Category (line 121) <Label>s have no htmlFor at all and the Radix Select triggers carry no id, so those labels are orphaned too. Clicking the label does not focus the control and screen readers announce the controls without their visible label. This is the app's primary transaction-entry form.
- **Evidence:** Line 84 `<Label htmlFor="tx_date">{t('form.addTransaction.date')}</Label>` followed by `<DatePicker ... />` (no id). Line 109 `<Label>{t('form.addTransaction.recipient')}</Label>` then `<Select ...><SelectTrigger><SelectValue .../></SelectTrigger>`. DatePicker.tsx:43 `<Button type="button" variant="outline" ...>` exposes no id prop.
- **Fix:** Wire labels via aria-labelledby on the Radix SelectTrigger (give the Label an id and reference it), or use the shadcn Form primitives (form.tsx already wires htmlFor/aria-describedby/aria-invalid correctly). For DatePicker, accept an id prop and forward it to the trigger Button so htmlFor resolves.

### 🟡 ux.7 — AddTransactionDialog inputs lack error association and accessible validation feedback

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/forms/AddTransactionDialog.tsx` — handleSubmit lines 34-67; amount input line 93
- **Problem:** Validation failures are not exposed to assistive tech. A silent early-return (`if (!form.transaction_date || !form.bank_account.trim() || !form.recipient_id || !form.amount) return;`) gives no feedback at all when required fields are empty — the submit just does nothing. The amount field uses a regex `pattern` for native validation but has no aria-invalid/aria-describedby tying a visible error message to the field, and the invalid-amount case only fires a transient toast. Screen-reader and keyboard users get no programmatic indication of which field is wrong.
- **Evidence:** Line 36 `if (!form.transaction_date || !form.bank_account.trim() || !form.recipient_id || !form.amount) return;` (silent). Line 93 `<Input id="tx_amount" type="text" inputMode="decimal" pattern="^-?[0-9]+([.,][0-9]+)?$" ... required />` — no aria-invalid / aria-describedby / inline error node.
- **Fix:** Track per-field error state and render an inline error <p id="tx_amount-error"> referenced via aria-describedby, set aria-invalid on the offending field, and move focus to the first invalid control on failed submit instead of returning silently. Adopting the form.tsx (FormControl/FormMessage) pattern would provide this for free.

### 🟡 ux.8 — Filter-chip dismiss buttons have no accessible name (icon-only)

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/components/shared/DataTable.tsx` — DataTable.tsx:379-384; identical in VirtualDataTable.tsx:471-473
- **Problem:** The active-filter chip's remove control is a bare <button> containing only an <X/> icon, with no aria-label, title, or visually-hidden text. Screen readers announce it as an unlabeled 'button', giving no indication it removes that column's filter. Every other icon-only button in these files (Clear search, Save, Cancel, Edit, Filter) was given an aria-label, so this is an inconsistency, not a deliberate choice.
- **Evidence:** DataTable.tsx:379 `<button onClick={() => setColumnFilter(key, "")} className="hover:text-destructive ml-0.5"><X className="h-3 w-3" /></button>` — no accessible name. Contrast with line 333 `aria-label="Clear search"`.
- **Fix:** Add `aria-label={`Remove filter ${col?.header || key}`}` (localized) to both chip dismiss buttons.

### 🟡 ux.9 — Column resize handle and sortable headers lack keyboard support and aria-sort

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/shared/DataTable.tsx` — resize handle line 455-462 (and VirtualDataTable.tsx:540-547); sortable header button line 411-417
- **Problem:** Two issues on the table headers. (1) The column-resize affordance is a <div> with onMouseDown only — no role="separator", no tabIndex, no keyboard handler, so resizing is mouse-only. (2) Sortable column headers are real <button>s (good, keyboard-operable) but the current sort state is conveyed only by a visual icon (ArrowUp/ArrowDown); the <th>/header carries no aria-sort="ascending|descending|none", so screen readers cannot announce which column is sorted or in which direction.
- **Evidence:** Line 455 `<div className="absolute right-0 ... cursor-col-resize ..." onMouseDown={(e) => { ... handleResizeStart(e, col.key, currentWidth); }} />` (no role/tabIndex/onKeyDown). Sort: `<SortIcon colKey={col.key} />` is the only sort-state signal; no `aria-sort` on the <TableHead>.
- **Fix:** Add aria-sort to the <TableHead> for the active sort key. Resizing is a lower priority, but at minimum give the handle role="separator" aria-orientation="vertical" and tabIndex with arrow-key resize, or document it as a pointer-only enhancement.

### 🟡 ux.10 — Theme-schedule time inputs in the topbar have no accessible name

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/components/layout/AppLayout.tsx` — lines 106-112 (light-at) and 116-122 (dark-at)
- **Problem:** Inside the theme dropdown's schedule section, two <input type="time"> controls are paired with <Label> elements that have no htmlFor, and the inputs have no id, aria-label, or aria-labelledby. The label text ('Light at' / 'Dark at') is purely visual; a screen reader announces these as unlabeled time fields, and clicking the label does not focus the input.
- **Evidence:** Line 106 `<Label className="text-xs text-muted-foreground w-14 shrink-0">{t('layout.lightAt')}</Label>` immediately followed by line 107 `<Input type="time" value={schedule.lightFrom} onChange={...} className="h-7 text-xs" />` — no id/htmlFor link.
- **Fix:** Give each Input an id and the matching Label an htmlFor (or add aria-label using the existing layout.lightAt/layout.darkAt strings).

### 🟡 ux.11 — OwesPage shows 'no debts' empty state on a failed fetch (no isError handling)

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/pages/OwesPage.tsx` — OwesPage line 27 (useOwedSummary) and RecipientOwesDetail line 127 (useOwedByRecipient)
- **Problem:** Both query consumers destructure only `isLoading` and never `isError`. When useOwedSummary() fails, `summary` is undefined, `items` becomes `[]`, and the page renders the 'no debts yet' empty state (lines 75-84) — telling the user nobody owes them money when in reality the request failed. Same issue in the detail view, which renders 'all settled' (lines 219-224) on a failed useOwedByRecipient(). Money-tracking data silently reads as zero on error.
- **Evidence:** OwesPage.tsx:27 `const { data: summary, isLoading } = useOwedSummary();` then OwesPage.tsx:48 `const items = summary?.items || [];` and OwesPage.tsx:75 `{items.length === 0 ? ( <Card>...<p>{t('owesPage.noDebts')}</p>... ) : (...)}`. No `isError` branch anywhere in the file (grep confirms only isLoading + an export-only try/catch).
- **Fix:** Destructure `isError`/`error` from both useOwedSummary() and useOwedByRecipient() and render an explicit error card (e.g. PageError) before the empty-state branch, so a failed fetch is not indistinguishable from a genuinely empty ledger.

### 🟡 ux.12 — PlannedPaymentsPage uses native window.alert() for save errors and silently swallows toggle/delete errors

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/pages/PlannedPaymentsPage.tsx` — handleSubmit line 353 (alert); toggle catch line 279; delete catch line 326
- **Problem:** This page is the only place in the audited frontend that uses a native browser `alert()` for error feedback — every other surface uses sonner toasts. Native alert is unstyled, blocking, untranslatable-looking and inconsistent. Worse, the toggle-active and delete handlers catch their errors and only `logger.error(...)` them with NO user-facing feedback at all: a failed pause/resume or failed delete looks like nothing happened. The page-level `error` Alert (line 407) only reflects the initial fetch error from usePlannedPayments, not these mutation failures. Root cause: usePlannedPayments (apps/frontend/src/hooks/usePlannedPayments.ts) is a hand-rolled useState/useEffect hook (not React Query like the rest of the app) whose addPayment/updatePayment/deletePayment/toggleActive just re-throw without toasting.
- **Evidence:** PlannedPaymentsPage.tsx:351-354 `} catch (err) { logger.error("Failed to save payment:", err); alert(t('plannedPage.saveFailed')); }`. Toggle handler PlannedPaymentsPage.tsx:278-280 `} catch (err) { logger.error("Failed to toggle status:", err); }` (no toast). Delete handler PlannedPaymentsPage.tsx:325-327 `} catch (err) { logger.error("Failed to delete payment:", err); }` (no toast). grep for native alert across the whole scope returns only this one line.
- **Fix:** Replace the `alert()` with `toast.error(...)` and add `toast.error(...)` to the toggle and delete catch blocks (matching useTransactions/useRecipients which toast on every onError). Better: migrate usePlannedPayments to React Query mutations like every other domain hook so error toasts are centralized and consistent.

### 🟡 ux.13 — OwesPage per-row settle and delete buttons have no pending/disabled state (double-submit risk)

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/pages/OwesPage.tsx` — RecipientOwesDetail settle button line 278, delete button line 285
- **Problem:** The per-split 'mark settled' and 'delete split' icon buttons fire `settleSplit.mutate(split.id)` / `deleteSplit.mutate(split.id)` directly with no `disabled` guard and no in-flight indicator. A user can double-click and fire the mutation twice, and there is no visual feedback that anything is happening between click and the invalidate-driven refetch. This contrasts with the same page's settle-all button (line 200, `disabled={...settleAllSplitsByRecipient.isPending}`) and record-payment button (line 325, `disabled={recordPayment.isPending}`), which DO guard against double-submit — so the inconsistency is within a single file.
- **Evidence:** OwesPage.tsx:275-281 settle button `<Button ... onClick={() => settleSplit.mutate(split.id)}>` with no `disabled`. OwesPage.tsx:282-288 delete button `<Button ... onClick={() => deleteSplit.mutate(split.id)}>` with no `disabled`. Compare line 200 `disabled={!items.length || settleAllSplitsByRecipient.isPending}` and line 325 `disabled={recordPayment.isPending}`.
- **Fix:** Track which split id is in flight (settleSplit.variables / deleteSplit.variables when isPending) and disable that row's buttons + show a spinner while pending, mirroring the settle-all and record-payment buttons already in this file.

### 🟡 ux.14 — No optimistic updates anywhere: all list mutations use invalidate-and-refetch (round-trip latency on every edit)

- **Severity:** medium · **Effort:** large · **Confidence:** high
- **Location:** `apps/frontend/src/hooks/useTransactions.ts` — useUpdateTransaction (lines 64-81), useDeleteTransaction (83-99); pattern repeats in useRecipients.ts, useTags.ts, useSplits.ts, hooks/portfolio/useInvestments.ts
- **Problem:** Across the frontend, 64 useMutation call sites exist but only 2 use onMutate, and both of those (DbMaintenancePage.tsx:121 setVacuumingTable, admin/ProviderHealthPage.tsx:133) are local loading-flag toggles, NOT cache-level optimistic updates with snapshot+rollback. Every domain mutation (create/update/delete transaction, recipient, category, tag, split, planned payment, investment) instead calls queryClient.invalidateQueries and waits for a full refetch before the UI reflects the change. For frequent inline edits (toggling category active, settling a split, deleting a row) the user sees a visible delay and no instant feedback. This matches the previously-deferred 'optimistic updates' work item — confirming the gap is still open. It is a UX-latency issue rather than a correctness bug because onError toasts are present, but the rollback safety net that optimistic updates require is also entirely absent.
- **Evidence:** useTransactions.ts:64-81 useUpdateTransaction has only `onSuccess: () => { queryClient.invalidateQueries(...); toast.success(...) }` and `onError` — no `onMutate`/rollback. Repo-wide grep: `useMutation` = 64 occurrences, `onMutate` = 2 occurrences (both UI-flag toggles, not cache snapshots).
- **Fix:** For high-frequency inline edits (category active toggle, split settle/delete, recipient default-category change), add onMutate to snapshot the cache, apply the optimistic change, and roll back in onError (the canonical TanStack Query optimistic pattern). Keep invalidate-only for low-frequency/complex mutations. Prioritize the surfaces where the round trip is most visible.

### 🟡 ux.15 — t() has no plural support; count strings render ungrammatical "1 items"

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/frontend/src/components/shared/DataTable.tsx` — DataTable.tsx:578; keys table.items / portfolio.investments / performance.holdingsPlural in i18n/source/{en,nl}.json
- **Problem:** The t() function (LanguageContext.tsx:81-92) does plain {var} replacement with no ICU/plural logic. Several keys hardcode the plural noun form, so when count === 1 the UI shows ungrammatical text in BOTH languages: e.g. table.items 'EN: {count} items' / 'NL: {count} items' renders "1 items"; portfolio.investments renders "1 beleggingen"; performance.holdingsPlural "1 posities"; import.rowsImported "1 transacties geïmporteerd". The codebase is inconsistent: some call sites correctly branch on count (PerformanceBreakdown.tsx:111, OwesPage.tsx:99 with separate .split/.splits keys), while DataTable.tsx:578 and PortfolioOverviewPage.tsx:281 blindly interpolate count into a fixed-plural string. There is no table.item singular key to fall back to.
- **Evidence:** LanguageContext.tsx:85-90 only does `text.replaceAll(`{${k}}`, String(v))` with no plural branch. DataTable.tsx:578 `: t('table.items', { count: data.length.toString() })`. en.json: `"table.items": "{count} items"` (no singular key exists). PortfolioOverviewPage.tsx:281 `investments: t('portfolio.investments', { count: String(summaries.length) })` where nl is `{count} beleggingen`.
- **Fix:** Introduce a minimal plural mechanism — either Intl.PluralRules-aware keys (e.g. table.items.one / table.items.other resolved by a small helper) or, at minimum, follow the existing .split/.splits pattern for these count keys and branch at the call site. Standardize so all count-bearing strings use the same approach.

### 🟡 ux.16 — TaxOverviewPage badges hardcode English labels despite 99 t() calls in the same file

- **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/pages/TaxOverviewPage.tsx` — TaxOverviewPage.tsx:389-391
- **Problem:** Three visible summary badges at the top of the tax overview render literal English ('Region:', 'Marginal rate:', 'Effective burden:'). The file otherwise calls t() ~99 times and translation keys for related concepts already exist (tax.effectiveTaxRate, tax.comparison.row.effectiveRate, tax.profile.field.regionLabel). Dutch users see English labels on a primary, high-visibility surface (Belgian tax is a core feature).
- **Evidence:** Lines 389-391: `<Badge variant="outline">Region: {profile.region}</Badge>` / `<Badge variant="outline">Marginal rate: {calculation.marginalRate.toFixed(0)}%</Badge>` / `<Badge variant="outline">Effective burden: {calculation.effectiveRate.toFixed(1)}%</Badge>`.
- **Fix:** Replace with t() using interpolation, e.g. t('tax.badge.region', { region: profile.region }), t('tax.badge.marginalRate', { pct: ... }), reusing/adding keys in both en and nl source, then run bun run generate-locales && bun run validate-locales.

### ⚪ ux.17 — Workspace switcher tabs signal selection by color/shadow only, with no ARIA state

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/components/layout/AppSidebar.tsx` — WorkspaceTab component lines 310-333; usage lines 211-222
- **Problem:** The Budgeting/Portfolio switcher is a pair of <button>s whose active state is conveyed only visually (background, shadow, ring, scale). They expose no aria-pressed, role="tab"+aria-selected, or any programmatic selected state, so screen-reader users cannot tell which workspace is active. The collapsed-mode single toggle (line 228) similarly relies on the icon alone.
- **Evidence:** Line 322 `<button onClick={onClick} className={`... ${active ? "bg-background/90 ... ring-1 ring-primary/25 scale-[1.02]" : "text-muted-foreground ..."}`}>` — `active` drives only className, never an aria attribute.
- **Fix:** Add aria-pressed={active} to the WorkspaceTab button (toggle semantics), or model the pair as role="tablist"/role="tab" with aria-selected. Add a visually-hidden 'active' indicator if a tab pattern is adopted.

### ⚪ ux.18 — No skip-to-content link before the sidebar/topbar

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/frontend/src/components/layout/AppLayout.tsx` — SidebarProvider/header/main composition lines 43-145
- **Problem:** Every route renders the full AppSidebar (with its large per-workspace navigation menu) and the topbar before <main>. There is no skip link, so keyboard and screen-reader users must tab through the entire sidebar nav on every page before reaching page content. A repo-wide grep found no skip-link/skipToContent anywhere. The <main> landmark exists (line 140), so a skip target is available — only the link is missing.
- **Evidence:** AppLayout.tsx renders `<AppSidebar />` then `<header>...</header>` then `<main className="flex-1 p-4 ...">{children}</main>` with no preceding anchor to #main; `grep -rn "skip"` over src returns no skip-link implementation.
- **Fix:** Add a visually-hidden-until-focused 'Skip to content' anchor as the first focusable element, targeting an id on the <main> element (e.g. <main id="main-content">).

### ⚪ ux.19 — useUpdateRecipient and useUpdateTag/useCreateTag/useCreateCategory show no success feedback (silent success inconsistency)

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/hooks/useRecipients.ts` — useUpdateRecipient lines 43-57; useTags.ts useCreateTag 15-28 & useUpdateTag 30-43
- **Problem:** Several mutations toast on error but are silent on success, while their sibling mutations in the same file toast on both. useUpdateRecipient (recipients.ts:43-57) only invalidates on success with no toast, whereas useCreateRecipient and useDeleteRecipient in the same file both toast.success. Likewise useCreateTag and useUpdateTag (useTags.ts) are silent on success while useDeleteTag toasts. The result is inconsistent confirmation feedback: editing a recipient or renaming a tag gives the user no acknowledgement that the change saved, but deleting does. Some of these silent-success cases are intentional (inline edits where a toast would be noisy), so this is low severity, but the inconsistency is real.
- **Evidence:** useRecipients.ts:50-52 `onSuccess: () => { queryClient.invalidateQueries({queryKey: ['recipients']}); },` (no toast) vs useRecipients.ts:65-68 useDeleteRecipient `onSuccess: () => { ...invalidateQueries...; toast.success(t('recipients.deleted')); }`. useTags.ts:21-23 useCreateTag onSuccess invalidates only (no toast) vs useTags.ts:51-54 useDeleteTag `toast.success(t('tags.deleted'))`.
- **Fix:** Decide a consistent policy (e.g. toast on every create/update/delete, or deliberately silent for inline edits) and apply it uniformly. If inline-edit silence is intentional, document it; otherwise add toast.success to useUpdateRecipient, useCreateTag, and useUpdateTag to match their siblings.

### ⚪ ux.20 — Chart date/number formatting ignores the app's number-format setting (uses browser locale)

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/frontend/src/components/charts/AreaChart.tsx` — AreaChart.tsx:445-447 (formatHoverTitle), LineChart.tsx:376, DbMaintenancePage.tsx:80/84, ToolResultCard.tsx:68
- **Problem:** The project deliberately decouples number/date display from the UI language via a separate numberFormat setting (utils/currency.ts numberFormatToLocale: eu/us/ch/in -> de-DE/en-US/de-CH/en-IN) consumed by formatCurrency. But several chart/table sites call .toLocaleDateString()/.toLocaleString() with NO locale argument, so they fall back to the browser's locale instead of the configured number-format. Result: a user who set EU number format but runs an en-US browser sees mixed grouping/date styles on chart hover tooltips and DB maintenance counts, inconsistent with the rest of the app. Lower severity because it depends on browser-vs-setting mismatch and affects formatting style, not correctness of values.
- **Evidence:** AreaChart.tsx:446 `if (x instanceof Date) return x.toLocaleDateString();` (no locale arg); LineChart.tsx:376 identical; DbMaintenancePage.tsx:80 `{Number(row.live_rows).toLocaleString()}`; ToolResultCard.tsx:68 `return value.toLocaleString();`. Contrast utils/currency.ts:137 which threads an explicit effectiveLocale into Intl.NumberFormat.
- **Fix:** Route these through the existing locale resolution: pass getCurrencyFormatDefaults().locale (or a shared formatNumber/formatDate helper) into the toLocale*String calls so chart and admin formatting honor the user's numberFormat setting like currency does.

### ⚪ ux.21 — Vendored ui/ primitives hardcode sr-only labels (Close, Toggle Sidebar, More pages)

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/components/ui/dialog.tsx` — dialog.tsx:48, sheet.tsx:64, sidebar.tsx:231/246/249, pagination.tsx:56/72/91, breadcrumb.tsx:86; plus RecipientPatternsDialog.tsx:274
- **Problem:** shadcn-derived UI primitives carry hardcoded English screen-reader text ('Close', 'Toggle Sidebar', 'More pages', 'More', 'Go to previous/next page'). These render on every dialog/sheet/pagination instance, so Dutch screen-reader users hear English for ubiquitous controls. Lower severity than the app-code findings because these are vendored primitives and the strings are short/uniform, but they form a consistent untranslated layer beneath the otherwise-translated UI. One app-code instance (RecipientPatternsDialog.tsx:274 sr-only 'Edit') is the same defect outside ui/.
- **Evidence:** dialog.tsx:48 `<span className="sr-only">Close</span>`; sidebar.tsx:231 `<span className="sr-only">Toggle Sidebar</span>`, :246 `aria-label="Toggle Sidebar"`; pagination.tsx:56 `aria-label="Go to previous page"`, :91 `<span className="sr-only">More pages</span>`; RecipientPatternsDialog.tsx:274 `<span className="sr-only">Edit</span>`.
- **Fix:** Either accept these as known primitive defaults and document it, or (preferred for full nl parity) parameterize the labels via props defaulting to t() at the call sites, and fix the one app-code instance (RecipientPatternsDialog.tsx:274) directly with t('common.edit').

## Code Style (11)

🟠 0 high · 🟡 2 medium · ⚪ 9 low

### 🟡 code-style.1 — Pervasive use of `null` literals violates the "never use null — use undefined" backend convention

- **Severity:** medium · **Effort:** large · **Confidence:** high
- **Location:** `apps/node-backend/src/services/calculations/splits.js` — splits.js:56 & :118; deduplication.js:99; recurrence.js:71; rateFetcher.js (8x); transactionRepository.js (6x); ~307 pure-JS occurrences backend-wide
- **Problem:** AGENTS.md mandates for the Node backend: "Never use null — use undefined for optional values." The codebase violates this widely. Beyond the defensible cases of binding `null` into parameterized SQL (the pg driver needs `null`, not `undefined`, to bind SQL NULL), there are ~307 pure-JS `null` uses in return values, ternaries, and object literals that have nothing to do with SQL binding and should be `undefined`. These flow into service return shapes and HTTP responses, so the convention violation is observable at the API boundary, not just internal.
- **Evidence:** splits.js: `return { ok: true, error: null };` (lines 56, 118). deduplication.js:99 `return { isDuplicate: false, existingTransactionId: null };`. recurrence.js:71 `return days >= 1 ? addDaysUtc(currentDate, days) : null;`. categoryRepository.js:60 `return result.rows[0] ? enrichCategory(result.rows[0]) : null;`. JSDoc also documents this: 17 comments say "Returns null" / "or null" / "null if".
- **Fix:** Decide and codify the boundary: keep `null` only where it is literally bound into a parameterized SQL query (document that exception in AGENTS.md), and replace all pure-JS `null` returns/ternaries/object fields with `undefined`. Add an ESLint rule (e.g. `no-restricted-syntax` for `Literal[raw="null"]` outside SQL-binding contexts, or `unicorn/no-null` with a query-binding allowlist) so the convention is actually enforced — currently nothing in eslint.config.js checks for it, which is why 891 occurrences exist with a clean lint run.

### 🟡 code-style.2 — `computeDailySnapshots` is a 359-line function mixing six queries, six lookup-map builders, and the day-by-day valuation loop

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/services/portfolio/snapshotBuilder.js` — computeDailySnapshots, lines 42-~400
- **Problem:** The convention is functions < 50 lines. This single function is ~359 lines and carries the entire daily-snapshot pipeline: parallel data fetch, construction of six separate lookup structures (investmentsById, nonUnitInvestmentsById, priceHistoryByInvestment, priceHistorySortedDays, inflationByMonth, fxRates, txByDay), then the per-day valuation walk. Each lookup-map builder is an independent, testable unit, but none can be unit-tested in isolation today, and the function is hard to reason about as a whole.
- **Evidence:** `export async function computeDailySnapshots(targetCurrency = 'EUR') {` at line 42 with the six-query `Promise.all` (lines 53-105) and inline map building (lines 109-170) all in one body; the function continues well past line 170 to ~400.
- **Fix:** Extract the lookup-map builders into named pure helpers (e.g. `buildPriceHistoryIndex(rows)`, `buildTxByDay(rows)`, `buildFxRates(rows)`) and a `valueDay(...)` helper, leaving `computeDailySnapshots` as a thin orchestrator. This also unlocks unit tests for the forward-fill / FX logic that financial correctness depends on.

### ⚪ code-style.3 — sanitizeString in validation middleware returns null, violating the backend no-null convention

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/middleware/validation.js` — sanitizeString line 72-76; validateDateString line 96 returns { value: null }
- **Problem:** AGENTS.md mandates 'NEVER use null — use undefined for optional values' for the Node backend. sanitizeString returns `null` for nullish input, and validateDateString returns `{ valid: true, value: null }` for empty input. These are shared validation utilities, so the null leaks into any caller that adopts them and then into DB writes / response shaping, contradicting the codebase's documented null-free invariant (the repositories deliberately translate to `|| null` only at the SQL layer).
- **Evidence:** export function sanitizeString(value, maxLength = 500) {
  if (value == null) return null;
  ...
}
// validateDateString
if (!value) return { valid: true, value: null };
- **Fix:** Return `undefined` instead of `null` from these helpers to match the backend convention; let the repository layer convert to SQL NULL at the boundary (it already does `x ?? null`). Confirms with the existing pattern used in transactionRepository/plannedTransactionRepository params arrays.

### ⚪ code-style.4 — Inconsistent list-response shaping: pagination sometimes in envelope meta, usually in the data body

- **Severity:** low · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/plannedTransactions.js` — plannedTransactions.js:223 vs recipients.js:26/159/168, categories.js:29-35, transactions.js:200-207
- **Problem:** ADR-026 (envelope.js) defines one success envelope { ok, data, meta? } where meta is intended for pagination/cross-cutting metadata. But list endpoints disagree on where collection metadata goes. Most endpoints embed total/limit/offset INSIDE data (transactions list, categories list, recipients list), while plannedTransactions due-soon puts it in meta: `res.ok(items, { days, total: items.length })`. Other list endpoints return `{ items, total }` in data with no limit/offset at all (recipients clusters/aliases/patterns). A frontend consuming these cannot rely on a single pagination contract; it must special-case per endpoint. Every list shape also hand-attaches `links: []` placeholders that are always empty.
- **Evidence:** plannedTransactions.js:223 `res.ok(items, { days, total: items.length });` (meta-based) vs categories.js:29-35 `res.ok({ items: ..., total, limit: opts.limit, offset: opts.offset, links: [] });` (data-based) vs recipients.js:25-26 `res.ok({ items: clusters, total: clusters.length });` (no limit/offset).
- **Fix:** Standardize one paginated-list contract — given the envelope supports meta, the cleanest is res.ok(items, { total, limit, offset }) everywhere — and add a small helper (e.g. okList(res, items, page)) so the shape can't drift per route. Drop the always-empty `links: []` placeholders or populate them.

### ⚪ code-style.5 — Backend convention 'never use null, use undefined' is widely violated in route default-parsing

- **Severity:** low · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/transactions.js` — transactions.js:63-78 parseTransactionListQuery; recipients.js:39-44; categories.js:18-20; plannedTransactions.js:158-165 (≈137 `null` occurrences across route files)
- **Problem:** AGENTS.md mandates for the Node backend: 'Never use null — use undefined for optional values.' Query-parsing in the route layer instead normalizes every absent optional to literal null (transactionId: ... : null, startDate: start_date || null, etc.), and these nulls then flow into repository option objects whose own defaults are also `= null`. This is a consistent, pervasive deviation from the stated convention, not a one-off. It also means callers and helpers must treat both null and undefined as 'absent', which is exactly the ambiguity the convention exists to remove.
- **Evidence:** transactions.js:63-71 `transactionId: transaction_id ? parseInt(transaction_id, 10) : null, startDate: start_date || null, endDate: end_date || null, bankAccount: bank_account || null, categoryId: category_id ? parseInt(category_id, 10) : null,` and repository signatures like transactionRepository.getAll({ transactionId = null, ... }).
- **Fix:** If the convention is real, normalize absent optionals to undefined in the parse helpers and switch repository option defaults from `= null` to `= undefined` (buildTransactionWhere already has to handle absence either way). If the convention is not actually being enforced for this layer, update AGENTS.md to reflect reality so future reviewers and agents are not misled. Either way, resolve the documented-vs-actual mismatch.

### ⚪ code-style.6 — Inline median reimplementation in recurringDetectionService instead of lib/math.js median()

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/services/recurringDetectionService.js` — lines 34-38
- **Problem:** recurringDetectionService computes a median inline (sort + mid + even/odd branch) while lib/math.js already exports a median() used by quoteBackfillService and priceProviderRegistry. This is the same algorithm copy-pasted, so an edge-case fix to median (e.g. empty-array handling) would not reach this caller.
- **Evidence:** `const sorted = [...intervals].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); const medianInterval = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];` — identical to lib/math.js:13-17.
- **Fix:** Import { median } from '../lib/math.js' and use it; handle the undefined return for empty input explicitly.

### ⚪ code-style.7 — Multiple business-logic functions exceed the 50-line limit (snapshotBuilder, ollama client, forecast, portfolio summary, recurring detection)

- **Severity:** low · **Effort:** large · **Confidence:** high
- **Location:** `apps/node-backend/src/services/portfolio/portfolioSummaryService.js` — buildInvestmentSummary (portfolioSummaryService.js:109, ~184 lines); createOllamaClient (integrations/ollama/client.js:68, ~312 lines); chatStream (client.js:202, ~169 lines); runChatTurnInner (aiChatService.js:188, ~178 lines); computeCashflowForecast (calculations/forecast/index.js:251, ~150 lines); detectRecurringPatterns (recurringDetectionService.js:129, ~149 lines)
- **Problem:** A consistent pattern of functions 2-7x the 50-line guideline. Several are genuine multi-responsibility logic (not just one long SQL string), so they are hard to test and review piecewise. `createOllamaClient` at 312 lines is effectively a class-in-a-closure holding multiple methods. This is maintainability debt rather than a correctness bug, but the count (>30 functions over 50 lines) makes it a real pattern, not a one-off.
- **Evidence:** Line-span analysis of src/**/*.js: `buildInvestmentSummary` 184 lines, `createOllamaClient` 312 lines, `runChatTurnInner` 178 lines, `computeCashflowForecast` 150 lines, `detectRecurringPatterns` 149 lines, plus ~25 more over 50 lines.
- **Fix:** Prioritize splitting the non-SQL ones (createOllamaClient, runChatTurnInner, buildInvestmentSummary, detectRecurringPatterns) into focused helpers. SQL-string-dominated functions (e.g. getMonthlyFinancialSummary) are lower priority since most of their length is a query literal. Don't fold this into unrelated work — track as a refactor backlog item.

### ⚪ code-style.8 — `importRecipients` in dataImportService nests 5 levels deep (for → try → if → if → if)

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/services/dataImportService.js` — lines ~90-145 (category-assignment block at 119-135)
- **Problem:** The convention caps nesting at 4 levels; this loop body reaches 5. The deepest branch (for-loop → try → `if (categoryStr)` → `if (colonIdx > 0)` → `if (general && detail)`) buries the actual DB write at 24 spaces of indentation, which is the only place in the backend hitting this depth. It is harder to follow than it needs to be.
- **Evidence:** Line 124 `if (general && detail) {` then line 125 `const { category } = await categoryRepository.createOrGet({ general, detail });` at 24-space indentation, inside `for` (90) → `try` (98) → `if (categoryStr)` (119) → `if (colonIdx > 0)` (121).
- **Fix:** Extract the category-parsing/assignment into a helper like `assignDefaultCategory(recipient, categoryStr)` that early-returns on invalid format and bad colon index, flattening the per-row loop to 2-3 levels.

### ⚪ code-style.9 — Repeated `String(search).slice(0, 200)` magic-number idiom across four route files

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/node-backend/src/routes/transactions.js` — transactions.js:72, categories.js:20, recipients.js:40, plannedTransactions.js:164
- **Problem:** The same search-length-cap of 200 is hardcoded as an unnamed literal in four route handlers (a DRY violation plus a magic number). If the cap needs to change, or differs from what the repository/SQL expects, the four copies can drift. It also pairs with the `: null` convention violation on the same lines.
- **Evidence:** All four lines read `search: search ? String(search).slice(0, 200) : null,` verbatim.
- **Fix:** Extract a shared helper such as `normalizeSearchParam(search)` with a named `MAX_SEARCH_LENGTH = 200` constant (and return `undefined` instead of `null`), and import it in all four routes.

### ⚪ code-style.10 — Module-level currency-format config mutated in place, violating the immutability convention

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/frontend/src/utils/currency.ts` — currency.ts:70-82 (configureCurrencyFormatDefaults), singleton at 11-15
- **Problem:** `configureCurrencyFormatDefaults` mutates the shared module-level `currencyFormatDefaults` object field-by-field (`currencyFormatDefaults.defaultCurrency = ...`). The repo convention is immutable updates only, never mutating existing objects. A mutable global also means formatting behavior depends on call order and is hard to reason about under concurrent renders; any reader holding a reference can observe it change underfoot (the getter does defensively return a copy, but the store itself is mutated).
- **Evidence:** `const currencyFormatDefaults: CurrencyFormatDefaults = { defaultCurrency: 'EUR', ... };` then `currencyFormatDefaults.defaultCurrency = updates.defaultCurrency;` inside the configure function.
- **Fix:** Replace the in-place writes with a single reassignment of a new object: `currentDefaults = { ...currentDefaults, ...sanitized }` behind a `let`, or better, thread the format config through context/props rather than a mutable module singleton. At minimum, build the next state immutably.

### ⚪ code-style.11 — Backend repository writes null for optional planned-transaction fields, violating the no-null convention

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/repositories/plannedTransactionRepository.js` — buildPlannedTransactionWhereClause defaults (lines 11-19); create() recurrence_pattern reset (line 324) and params array (lines 329-345); getById execution mapping (line 252, 433)
- **Problem:** AGENTS.md states for the Node backend: 'Never use null — use undefined for optional values.' This file uses null pervasively for optional/absent values: default parameters (`startDate = null`, ... `recipientId = null`), `recurrence_pattern = null` for loans, and the insert params array passes `null` for unset columns (`bank_account ? ... : null`, `url || null`, `recurrence_pattern || null`, etc.), plus `executed_transaction_id ... : null`. While `null` is the correct SQL binding for pg, the convention is about the JS layer; the default-parameter and returned-shape nulls (e.g. row.executed_transaction_id = null) are the convention violation, and they leak null into API responses inconsistently with the rest of the codebase that returns undefined.
- **Evidence:** Lines 12-19: `startDate = null, endDate = null, bankAccount = null, ...`. Line 324: `recurrence_pattern = null;`. Line 217/252: `row.executed_transaction_id = executions.length > 0 ? executions[0].executed_transaction_id : null;`
- **Fix:** Use undefined for JS-layer optionals and returned shapes; for SQL bindings, pass undefined (node-postgres coerces undefined params to NULL) or convert at the boundary. Keep the column-name sanitization as-is.

## Dead Code (6)

🟠 0 high · 🟡 1 medium · ⚪ 5 low

### 🟡 dead-code.1 — Two parallel MAD-based price spike-sanitization implementations that have already drifted

- **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `apps/node-backend/src/services/quoteBackfillService.js` — sanitizeIsolatedSpikes (quoteBackfillService.js:101-179) vs sanitizeKinesisIsolatedSpikes (prices/priceProviderRegistry.js:161-241)
- **Problem:** Two separate functions implement the same robust (median absolute deviation) spike-detection algorithm over price time-series, sharing the same magic constants and loop structure, but they have drifted: one uses _isPositive + raw .price, the other isValidPrice + toNumber() and adds localNeedleNeighborTolerance; one mutates the array in place (violating the immutability convention), the other spreads. A correctness fix to the spike heuristic in one will silently not apply to the other, so backfilled quotes and Kinesis quotes can diverge.
- **Evidence:** Both contain: `const medianReturn = median(logReturns) ?? 0; const absDeviations = logReturns.map(r => Math.abs(r - medianReturn)); const mad = median(absDeviations) ?? 0; const robustSigma = Math.max(1.4826 * mad, 0.0015); const spikeThreshold = 6 * robustSigma; const bridgeThreshold = 4 * robustSigma; const minSpikeMove = Math.log(1.18);` followed by the same hasLargeJump/hasLargeRevert/oppositeDirections/bridgeLooksNormal test. priceProviderRegistry.js:185 mutates: `sanitized[lastIdx].price = lastPrev;`
- **Fix:** Extract the shared MAD spike-detection core into one helper (e.g. lib/priceSanitize.js) parameterized by the price accessor and the extra Kinesis tolerance, and have both services call it. Name the magic constants (ROBUST_SIGMA_FLOOR=0.0015, SPIKE_SIGMA=6, BRIDGE_SIGMA=4, MAD_SCALE=1.4826). Make it non-mutating.

### ⚪ dead-code.2 — Root production `dependencies` (archiver, yauzl) are only used by a test, not by any shipped code

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `package.json` — lines 57-60 (dependencies: archiver ^8.0.0, yauzl ^3.3.0)
- **Problem:** These are declared as top-level production `dependencies` of the repo root, but the only consumer in apps/ or scripts/ is a backend test file (`apps/node-backend/tests/backup-roundtrip.test.js:33 require('archiver')`). The backend's own package.json does not list them, and the electron package.json declares its own archiver/yauzl. Production-classified deps that are actually test-only widen the audited/shipped surface and mislead `bun audit` severity triage (a vuln here would be flagged as production-reachable when it is not). For a finance app the dependency inventory should reflect real runtime reachability.
- **Evidence:** package.json:57-60 lists archiver/yauzl under `dependencies`; grep for `archiver`/`yauzl` imports across apps+scripts returns only `apps/node-backend/tests/backup-roundtrip.test.js:33: const pkg = require('archiver');`.
- **Fix:** Move archiver/yauzl to `devDependencies` of the workspace that actually uses them (node-backend, for the test) or to root `devDependencies`, so the production dependency set matches what ships. Confirm no runtime backup code path imports them before reclassifying.

### ⚪ dead-code.3 — Dead code: exported useTransaction(id) hook has no call sites

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/hooks/useTransactions.ts` — useTransactions.ts:37-44
- **Problem:** useTransaction (singular, fetch-by-id) is exported but never imported anywhere in pages/, features/, components/, or other hooks (verified by word-boundary grep across the whole frontend src). It is maintenance surface that ships an extra query definition no one uses, and its query key shape ['transactions', id] overlaps the list key ['transactions', params] prefix without being exercised.
- **Evidence:** useTransactions.ts:37-44 `export function useTransaction(id: number) { return useQuery({ queryKey: ['transactions', id], queryFn: () => apiClient.getTransaction(id), enabled: !!id, staleTime: 60_000 }); }` — `grep -rn "\buseTransaction\b"` (excluding the definition and useTransactions/useTransactionList) returns no results.
- **Fix:** Delete useTransaction (and apiClient.getTransaction if it is likewise unused), or wire it into the transaction info dialog if a by-id fetch is actually intended. If kept for API symmetry, mark it clearly so reviewers know it is intentionally unused.

### ⚪ dead-code.4 — Dead export formatAmountWithSymbol in currency utils

- **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `apps/frontend/src/utils/currency.ts` — formatAmountWithSymbol (lines 188-210)
- **Problem:** formatAmountWithSymbol is exported but has zero references anywhere in the frontend, including tests. It is a third currency-formatting code path (alongside formatCurrency and formatCurrencyCompact) carrying its own symbolAfter table and sign logic, so it is both dead and a maintenance trap if someone later copies it.
- **Evidence:** grep across apps for `formatAmountWithSymbol` returns only the definition: `apps/frontend/src/utils/currency.ts:188:export function formatAmountWithSymbol(`. No importers, no test references.
- **Fix:** Delete formatAmountWithSymbol (and its symbolAfter constant if unused elsewhere). If a symbol-prefixed format is needed in future, derive it from formatCurrency.

### ⚪ dead-code.5 — bankAdapters.js shim re-exports unused getAdapter; createAdapter/detectBank used only by tests

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/node-backend/src/services/bankAdapters.js` — bankAdapters.js:6-11
- **Problem:** The deprecated bankAdapters.js shim re-exports four names but production code imports only getSupportedBanks (importRoutes.js). getAdapter is consumed directly from importPipeline/adapters/index.js (stage.js:39), so the shim's getAdapter re-export is dead. createAdapter and detectBank are referenced only by adapter tests, not by any production module — the import pipeline drives adapters via getAdapter/parse, so these two are tested-but-unused-in-prod surface kept alive only by the tests that exercise them.
- **Evidence:** grep shows createAdapter/detectBank have no non-test, non-definition callers; getAdapter's only real caller is `services/importPipeline/stage.js:39: const adapter = getAdapter(adapterName);` which imports from adapters/index.js, not the shim. importRoutes.js:11 imports only getSupportedBanks from the shim.
- **Fix:** Narrow the shim to re-export only getSupportedBanks (or point importRoutes at adapters/index.js and delete the shim entirely). Repoint the adapter tests at importPipeline/adapters/index.js so the legacy entrypoint can be removed, and drop the unused getAdapter re-export.

### ⚪ dead-code.6 — Stale, divergent second Vite config in config/ with a broken PostCSS path

- **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `config/vite.config.ts` — config/vite.config.ts (whole file), esp. css.postcss line 32
- **Problem:** There are two Vite configs: the authoritative apps/frontend/vite.config.ts (used by the build — root build script runs `bun run --filter 'vision-frontend' build` -> `vite build` in apps/frontend) and an unused config/vite.config.ts. The config/ copy has NO manualChunks/build optimization, a different `@` alias root, and references `path.resolve(__dirname, "./postcss.config.js")` — but the file on disk is config/postcss.config.cjs, so this config would fail to resolve PostCSS if ever used. No script references it (`grep --config` / `config/vite.config` finds no consumers). It is dead config that will mislead anyone who edits it expecting build behavior to change.
- **Evidence:** config/vite.config.ts:32 `postcss: path.resolve(__dirname, "./postcss.config.js")`; `ls config/postcss.config.*` shows only config/postcss.config.cjs. Root package.json build = `... && bun run --filter 'vision-frontend' build`; apps/frontend/package.json build = `... && vite build` (uses apps/frontend/vite.config.ts). No `--config` flag anywhere.
- **Fix:** Delete config/vite.config.ts (and config/postcss.config if also unused) or, if it is intentionally the canonical config, wire the build to it and fix the postcss path to .cjs. Keeping a divergent duplicate invites config drift between the two manualChunks definitions.

---

_Generated from the multi-agent audit run (workflow `vision-improvement-audit`, 2026-05-29). See [[docs/index]] for the KB home._
