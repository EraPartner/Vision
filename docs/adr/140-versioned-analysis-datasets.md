---
title: ADR-140 - Versioned Analysis Datasets
type: adr
status: Accepted
date: 2026-09-12
tags: [adr, analysis, datasets, reconciliation, security, money, portfolio]
description: Define four bounded version-1 financial datasets with explicit grain, semantics, lineage, and a deny-by-default database boundary.
aliases: [analysis datasets, financial analysis views]
---

# ADR-140: Versioned Analysis Datasets

## Status

Accepted

## Context

ADR-137 defines how an analysis names datasets and records results. It deliberately does not decide
which financial rows those dataset names mean. Allowing future visual, SQL, spreadsheet, and AI
paths to query application tables directly would expose unstable implementation detail, duplicate
portfolio calculations, and make secrets or administrative state reachable by accident.

## Decision

Version 1 contains four logical datasets:

- `transactions`: one canonical ledger transaction, including inactive history;
- `accounts`: one own-account entity with its complete `statement_balances` collection;
- `holdings`: one canonical portfolio event used as input to the existing cost-basis replay; and
- `cash-flows`: one budgeting ledger row with explicit transfer and sign projections.

`@vision/types/analysis-datasets` is the immutable catalog. It records the schema version, backing
relation, row grain, primary key, approved joins, authorization scope, time basis, currency and sign
rules, and known coverage. The backing `vision_analysis` schema is created by migration 0107. Its
views use PostgreSQL security barriers and revoke all access from `PUBLIC`. A future isolated SQL
executor must receive an explicit `SELECT` grant and must validate catalog references before query
execution.

The local Vision database is single-user. Version 1 therefore authorizes the whole local user's
database rather than inventing row ownership that does not exist. Inactive business history remains
present and is marked. Provider credentials, raw import rows, duplicate fingerprints, admin audit
records, settings, and AI transcripts are not exposed.

The holdings dataset exposes events, not a second SQL implementation of current positions. Current
units, partial-sale cost basis, realized gain, corporate actions, transaction-date foreign exchange,
and broker partitions must use the canonical portfolio engine. The cash-flow dataset covers the
budgeting ledger only. Transfers have zero spending and positive-flow projections; positive rows
remain `income_or_refund` because the sign alone cannot distinguish those meanings.

Cross-currency aggregation is never implicit. Consumers must select a reporting currency and retain
missing or fallback foreign-exchange coverage in the ADR-137 result contract.

## Reconciliation contract

- Spending is the positive magnitude of non-transfer negative ledger rows.
- Positive non-transfer rows remain income-or-refund until a documented metric classifies them.
- Both transfer legs remain visible but are excluded from default cash flow.
- Historical portfolio flows use recorded transaction-date foreign exchange.
- Current valuation uses the canonical current-rate path and reports fallback coverage.
- Partial sales and broker partitions use the same cost-basis implementation as Portfolio.
- A chart, formula, SQL result, or AI answer that cannot prove its dataset and metric versions fails
  compatibility rather than silently recomputing a different meaning.

## Consequences

The views are stable query inputs, not a general read-only mirror of the application schema. Adding
fields or datasets requires a catalog and view version review. A breaking semantic change creates a
new version; old saved definitions keep naming version 1. Migration 0107 is additive and its
downgrade drops only the four views and their empty schema.

## Evidence

`apps/node-backend/tests/analysisDatasets.test.js` checks the catalog, excluded sensitive surfaces,
transfer/refund projections, canonical mixed-currency partial-sale reconciliation, and reversible
migration shape. `apps/node-backend/tests/analysisDatasets.db.test.js` is the PostgreSQL acceptance:
it queries every view, verifies native types and row grains, proves `PUBLIC` has no access, and
reconciles transfer-safe cash-flow totals with the existing monthly report query. That database
test must pass against a disposable PostgreSQL instance before the backlog item is closed; it must
not target user data.

## Related

- [[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137]]
- [[docs/reference/analysis-datasets|Analysis Datasets]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/reference/data-model|Data Model Reference]]
