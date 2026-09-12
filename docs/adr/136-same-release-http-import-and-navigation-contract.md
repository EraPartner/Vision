---
title: ADR-136 Same-Release HTTP, Import, and Navigation Contract
type: adr
status: accepted
date: 2026-09-12
tags:
  [
    adr,
    compatibility,
    breaking-change,
    api,
    error-envelope,
    import,
    multipart,
    routing,
    deep-links,
  ]
description: Ends legacy HTTP error parsing, import query-field fallbacks, and retired frontend route aliases under a same-release frontend/backend support policy.
aliases: [same-release compatibility contract, HTTP and navigation cutoff]
related_code:
  - apps/frontend/src/lib/api/client.ts
  - apps/frontend/src/App.tsx
  - apps/frontend/src/pages/AccountsPage.tsx
  - apps/frontend/src/features/settings/DashboardSettingsDialog.tsx
  - apps/node-backend/src/routes/importRoutes.js
  - apps/node-backend/src/routes/portfolioImportRoutes.js
  - apps/node-backend/tests/responseEnvelopeContract.test.js
  - openapi.yaml
---

# ADR-136: Same-Release HTTP, Import, and Navigation Contract

## Status

Accepted

## Date

2026-09-12

## Context

Vision still accepted three groups of client compatibility behavior after their canonical
replacements were established:

- the frontend HTTP client interpreted pre-[[docs/adr/026-unified-api-response-envelope|ADR-026]]
  `{ detail }`, `{ message }`, Pydantic validation-array, and top-level `retry_after` errors;
- budgeting and portfolio CSV uploads accepted configuration in either multipart fields or query
  parameters, with body-first precedence;
- frontend routing redirected former Portfolio and Research paths, an account query parameter, and
  old settings-section names to current destinations.

These paths made the actual contract wider than `openapi.yaml` and kept old bookmarks alive without
an explicit support policy. The frontend and Node backend are built and delivered from the same
repository. Electron embeds the matching frontend bundle and backend. A separately deployed web
frontend and backend must also use the same Vision release.

## Decision

### Supported client/server skew

Vision supports the shipped frontend with the backend from the same release. Mixed Vision
frontend/backend versions are unsupported. External clients must follow the `openapi.yaml` contract
for the server release they call. This decision does not alter Server-Sent Events: stream terminal
errors keep their endpoint-specific `{ detail, code }` event payload.

### Canonical HTTP errors only

Every JSON HTTP failure uses `{ ok: false, error: { code, message, details? }, meta? }`. The
frontend accepts that shape when `code` and `message` are non-empty strings. A recognized code is
preserved. An unrecognized code keeps the canonical message and details but maps the client-facing
`ApiErrorCode` to the HTTP-status fallback, which permits additive server codes without trusting an
unknown discriminator in UI branches. Empty, non-JSON, malformed, and retired error bodies fall
back to the HTTP status and the call site's generic message. They do not recover a server-provided
message or details.

`apps/node-backend/tests/responseEnvelopeContract.test.js` scans backend JavaScript for the
repository's conventionally named Express response writers. It confines direct `res.json(...)`
writers to the health endpoints and shared success-envelope/error-handler middleware, and rejects
object-valued `res.send(...)` writers that follow that convention. This guard supports focused
route tests; it is not an abstract-syntax proof against aliased or renamed response objects. CSV
downloads, `204 No Content`, and Server-Sent Events are separate response contracts.

### Import options are multipart-body-only

The compatibility window for import query fields ends on 2026-09-12. The following upload options
are accepted only as multipart form fields:

- `bank_name` on budgeting one-shot and streaming bank imports;
- all custom budgeting mapping fields;
- `separator` and `encoding` on recipient and category imports;
- all portfolio mapping, format, brokerage, and account fields on one-shot and streaming imports.

Query fields are ignored. `bank_name` remains required in the multipart body. This is a breaking
request-contract change for clients that still place upload options in the URL.

### Retired frontend entry points are unsupported

The compatibility window for old bookmarks ends on 2026-09-12:

| Retired entry point         | Canonical entry point              | Current result for the retired form |
| --------------------------- | ---------------------------------- | ----------------------------------- |
| `/portfolio/exchange-rates` | `/admin/exchange-rates`            | Not Found                           |
| `/research/symbol/:symbol`  | `/research/market?symbol=<symbol>` | Not Found                           |
| `/portfolio/market`         | `/research/market`                 | Not Found                           |
| `/portfolio/watchlist`      | `/research/watchlist`              | Not Found                           |
| `/accounts?account=<id>`    | `/accounts/<id>`                   | Accounts hub; query field ignored   |
| `?settings=dashboard`       | `?settings=statistics`             | Settings stays closed               |
| `?settings=app`             | `?settings=about`                  | Settings stays closed               |

Current menus, Electron navigation, onboarding, command-palette actions, and test page objects use
only canonical routes and settings-section identifiers.

This supersedes ADR-084's narrow decision to keep the `dashboard` and `app` settings aliases. The
instant-apply settings behavior and current section identifiers from ADR-084 remain unchanged.

## Consequences

- Error handling has one machine contract. A malformed server response still produces a useful
  status-derived client error, but it cannot surface untrusted legacy fields.
- Import URLs no longer duplicate potentially sensitive or conflicting configuration. Clients that
  used query fields must move them into the multipart body before upgrading.
- Old bookmarks stop redirecting. Users must update saved URLs; no persisted financial data is
  changed.
- Rollback is code-only: restore the parser branches, query readers, or explicit redirect routes.
  No schema migration or data repair is involved.
- This ADR does not retire Electron legacy-install guards. Their fail-closed database protection
  remains governed by [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]] until its separate
  packaged migration and recovery gate passes.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]]
- [[docs/adr/084-settings-instant-apply-sidebar|ADR-084: Settings instant apply and sidebar]]
- [[docs/reference/frontend-api-client|Frontend API Client Architecture]]
- [[docs/api/imports|Imports API]]
- [[docs/api/portfolio-imports|Portfolio Imports API]]
- [[docs/reference/frontend-routes|Frontend Routes Reference]]
- [[docs/reference/error-codes|Error Codes Reference]]
