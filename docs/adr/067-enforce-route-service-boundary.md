---
title: "ADR-067: Enforce Route → Service Boundary"
type: adr
status: Accepted
date: 2026-06-01
tags: [adr, architecture, backend, service-layer, route-layer, eslint, lint-rule, three-layer-architecture]
description: All Express route files must import from service seams only — never directly from repositories. The ESLint rule vision-local/no-repo-direct-from-route is promoted from warn to ERROR. 14 new thin service modules complete the boundary.
aliases: [route-service-boundary, no-repo-direct-from-route, service-seam enforcement]
---

# ADR-067: Enforce Route → Service Boundary

## Status

Accepted

## Date

2026-06-01

## Context

ADR-006 defines a three-layer architecture: Route → Service → Repository. In practice, several route files imported repository modules directly, bypassing the service layer. The ESLint rule `vision-local/no-repo-direct-from-route` existed but was set to `warn`, meaning violations accumulated silently in CI.

This left the architecture in a mixed state: some domains had proper service seams; others had routes that directly called repository functions. The consequences were:

- Business logic scattered across route handlers rather than centralized in services
- Testing boundary unclear — integration tests had to mock repositories from route tests
- Adding cross-cutting concerns (authorization, observability, audit trails) required patching each route individually instead of a single service layer

As of the June 2026 remediation pass, **all 15 route files** have been audited. Where service seams were missing, thin delegation modules were created.

## Decision

1. The ESLint rule `vision-local/no-repo-direct-from-route` is promoted from `"warn"` to `"error"`. CI fails on any new violation.

2. 13 new thin service modules were created to complete the boundary for domains that previously imported repositories directly from routes:

   | Service Module | Route covered |
   |---|---|
   | `categoryService.js` | `categories.js` |
   | `transactionService.js` | `transactions.js` |
   | `recipientService.js` | `recipients.js` |
   | `recipientBankAccountService.js` | `recipientBankAccounts.js` |
   | `savedChartsService.js` | `savedCharts.js` |
   | `infoService.js` | `info/` route group |
   | `plannedTransactionService.js` | `plannedTransactions.js` |
   | `settingsService.js` | `settings.js` |
   | `splitService.js` | `splits.js` |
   | `watchlistService.js` | `watchlist.js` |
   | `attachmentRecordService.js` | `attachments.js` |
   | `importBatchService.js` | `importRoutes.js` (batch delegation) |
   | `customParserConfigService.js` | `importRoutes.js` (parser CRUD) |

   Portfolio-transaction coordination is intentionally *not* a route seam: there is no dedicated portfolio-transaction route file, and the `portfolioTxRepo.{common,reads,writes}.js` repositories are consumed exclusively by portfolio services (e.g. `moveHoldingService.js`, the import pipeline), never directly from a route — so the boundary already holds without a `portfolioTxService.js` seam.

3. These seams are deliberately thin at creation time — they delegate to repositories with minimal added logic. They exist to establish the correct dependency direction and provide a stable extension point.

## Consequences

**Positive:**
- All route handlers now have a single, testable seam. Unit tests can mock at the service boundary.
- Cross-cutting concerns (caching, audit, metrics) can be added to a service without touching route code.
- ESLint error gate prevents regression to direct-repo imports from routes.

**Negative:**
- 14 new files add indirection for simple CRUD paths. For now they are pure delegation with no extra logic.
- Any developer adding a new route must also add or reuse a service module. CI will enforce this.

**Neutral:**
- Existing pre-June substantial services (`aiChatService`, `importPipeline`, `priceProviderService`, `portfolioPerformanceSnapshotService`, etc.) are unchanged.

## Related

- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]]
- [[docs/reference/service-layer|Service Layer Reference]]
- [[docs/adr/index|All ADRs]]
