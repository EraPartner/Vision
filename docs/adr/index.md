---
title: Architecture Decision Records Index
type: adr-index
status: active
date: 2026-04-17
tags: [adr, index, architecture, decisions, phase-8]
description: Architecture Decision Records documenting significant technical choices and their rationale
aliases: [ADRs, decisions, architecture decisions]
---

# Architecture Decision Records

> [!abstract] What is an ADR?
> An ADR (Architecture Decision Record) documents a significant architectural decision along with its context, consequences, and status. Use these to understand **why** the system is built the way it is.

## All ADRs

```dataview
TABLE WITHOUT FILE status AS "Status", date AS "Date", description AS "Summary"
FROM "docs/adr"
WHERE !contains(file.name, "template") AND type = "adr"
SORT date DESC
```

## Active Decisions

```dataview
LIST WITHOUT FILE
FROM "docs/adr"
WHERE status = "Accepted"
SORT date DESC
```

## Creating a New ADR

See [[docs/adr/template\|the ADR template]] for the format to use when creating a new decision record.

> [!tip] When to Create an ADR
> - Choosing a new technology or framework
> - Changing a fundamental architectural pattern
> - Documenting a significant bug fix with architectural implications
> - Recording a decision that affects multiple parts of the system

## Recent Decisions

### 2026-04-17: Aggregation Shadow Mode

[[docs/adr/016-aggregation-shadow-mode|ADR-016]] — Observational Express middleware (`createAggregationShadow`) shadows new `/api/aggregations/*` responses against legacy `/api/info/*` during Phase 2 → Phase 9 migration window. Default threshold 1¢, `queueMicrotask` fire-and-forget, swallows legacy failures, envelope-aware diff with Postgres NUMERIC string coercion. Removal gated on zero divergence logs across a full release cycle. References [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] and [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]].

### 2026-04-16: Recipient, Bank Account, and Category Uniqueness Constraints

[[docs/adr/015-recipient-bank-account-uniqueness|ADR-015]] — Database-level UNIQUE constraints on `recipients.normalized_name`, `recipient_bank_accounts.account_number`, and `categories(general, detail)`. Enforced at DB level for race-safe idempotent operations (create-or-get), conflict-free merge deduplication, and guaranteed data integrity. Implemented in Phase 6 via migration 0029.

### 2026-04-16: Atomic Merge Transactional Safety

[[docs/adr/014-atomic-merge-transactional-safety|ADR-014]] — Recipient merge uses single database transaction with `FOR UPDATE` row-level locking and race-safe `INSERT ... ON CONFLICT` deduplication. All FK reassignments (transactions, splits, planned, bank accounts) execute atomically; partial state is impossible. Implemented in Phase 6.

### 2026-04-16: Split Hard-Delete with split_audit Trail

[[docs/adr/013-split-hard-delete-with-audit-trail|ADR-013]] — Splits and split_payments are hard-deleted via ON DELETE CASCADE; lifecycle is preserved in an append-only split_audit table. Overpayment protection enforced at three layers: pure calc module validation, DB trigger (SQLSTATE 23514), audit trail. Implemented in Phase 4.

### 2026-04-16: Planned Execution Idempotency

[[docs/adr/012-planned-execution-idempotency|ADR-012]] — Use PostgreSQL UNIQUE constraint on (planned_transaction_id, executed_transaction_id) + explicit error detection (Postgres 23505) to guarantee idempotent planned transaction executions. Safe to retry; no duplicate rows on double-click or network retry. Implemented in Phase 3.

### 2026-04-16: Phase 2 Aggregation Envelope Standard

[[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]] — Standardized response envelope for all `/api/aggregations/*` endpoints with `{ data, meta: { source, computedAt } }` to transparently communicate whether results came from materialized views (cached, ~15min stale) or live computation.

### 2026-04-16: Phase 1 Aggregation Strategy

[[docs/adr/010-phase1-aggregation-strategy|ADR-010]] — Postgres-backed aggregations (materialized views + trigger-maintained tables) as the caching tier instead of Redis or in-process caches. Removes dependency on external caches while providing fast, deterministic dashboard aggregates. Driven by performance issues with the 1433-LOC infoRepository monolith.

### 2026-04-16: Timezone Policy

[[docs/adr/009-timezone-policy|ADR-009]] — Single deterministic timezone per environment for business math (dates, recurrence, loan schedules). Database stores UTC; application layer uses configurable `APP_TIMEZONE`. Materializes SQL aggregations using `AT TIME ZONE` literal.

### 2026-04-16: Performance Page Rewrite

[[docs/adr/008-performance-page-server-computed-response|ADR-008]] — Moved performance computations from frontend to backend, fixed contribution-adjusted heatmap formula.

## Related Documentation

- [[docs/architecture/index\|Architecture Overview]] - System diagrams
- [[docs/adr/002-database-schema\|Database Schema]] - Current schema design
- [[docs/guides/migrations\|Migration Guide]] - How schema changes are managed
