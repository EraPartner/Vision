---
title: Analysis Datasets
type: reference
status: active
date: 2026-10-08
tags: [analysis, datasets, reconciliation, money, portfolio, security]
description: Versioned analysis datasets, including ordered category paths, financial meanings, joins, and reconciliation rules.
aliases: [financial datasets, vision_analysis]
related_code:
  - packages/types/src/analysisDatasets.ts
  - alembic/versions/0107_analysis_dataset_views.py
  - alembic/versions/0114_category_hierarchy.py
  - apps/node-backend/tests/analysisDatasets.test.ts
  - apps/node-backend/tests/analysisDatasets.db.test.ts
---

# Analysis Datasets

The authoritative machine-readable catalog is `@vision/types/analysis-datasets`. The PostgreSQL
relations live in `vision_analysis`. They are not automatically available to application or public
roles; the isolated executor receives explicit read-only grants.

| Dataset          | Relation                            | Row grain                | Default meaning                                                                            | Known coverage                                                                       |
| ---------------- | ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `transactions@1` | `vision_analysis.transactions_v1`   | One ledger transaction   | Signed canonical row with account, recipient, category, transfer, and active-state context | All ledger history; raw imports and duplicate identities excluded                    |
| `accounts@1`     | `vision_analysis.accounts_v1`       | One own account          | Account policy plus the complete per-currency statement-balance collection                 | Active and archived own accounts; credentials and settings excluded                  |
| `holdings@1`     | `vision_analysis.holding_events_v1` | One portfolio event      | Replay input for the canonical portfolio engine                                            | All portfolio events; current positions are derived, not stored in the view          |
| `cash-flows@1`   | `vision_analysis.cash_flows_v1`     | One budgeting ledger row | Signed flow plus transfer-safe spending and positive-flow projections                      | Budgeting ledger only; portfolio income appears only when represented in that ledger |

The catalog-backed builder now selects `vision_analysis.transactions_v2` and
`vision_analysis.cash_flows_v2` for new transaction and cash-flow analyses. Each is the same
one-ledger-row grain as version 1, with additive `category_path` (display text),
`category_path_segments` (ordered text array), and `category_path_ids` (ordered integer array).
The version-1 views remain available to previously saved immutable SQL definitions. The catalog
also retains the old `category_general` and `category_detail` fields for compatibility; they are
not the canonical hierarchy after a move or rename. No path field expands a transaction into
multiple rows, so existing totals stay at the same grain. New ancestor aggregation must join
the selected category ID to `category_ancestors` explicitly.

## Allowed joins

Version 1 permits `transactions.account`, `cash-flows.account`, and `holdings.account`, each as a
many-to-one join through `account_id`. It does not publish free-form joins to provider, import,
settings, audit, AI transcript, or raw provenance tables.

## Money and signs

- Ledger amounts retain their native currency and sign. Negative means outflow. Positive means
  income or refund. Classification needs more evidence than sign.
- `spending_amount` is the positive magnitude only for non-transfer negative rows.
- `positive_flow_amount` is positive only for non-transfer positive rows.
- Cross-currency totals require an explicit reporting currency and dated exchange-rate evidence. The current visual catalog does not convert currencies: every money sum requires selected currency grouping or an equality filter on one uppercase currency code. Raw custom SQL remains the author's responsibility.
- Portfolio event amounts use event currency. `fx_rate_to_eur` is transaction-date evidence, not a
  current valuation rate.

## Time

Ledger and portfolio dates are calendar dates. Business grouping uses `APP_TIMEZONE`; it must not
shift a `DATE` through Coordinated Universal Time. Timestamps such as `updated_at` remain instants.

## Holdings

The catalog labels `sum_amount` and `sum_units` as raw event totals. They preserve stored event values and do not apply buy/sell direction. Unit totals require selected `investment_id` grouping or a single-investment equality filter, so unrelated instruments are not added together.

Do not sum event units blindly. Buys and gifts add units and sells remove them, but splits, mergers,
spinoffs, returns of capital, fees, taxes, and cost-basis methods require the canonical Portfolio
replay. A result must record the selected metric and engine versions. Broker partitions must sum to
the global result, and foreign-exchange fallback must create partial coverage rather than a hidden
estimate.

## Security boundary

Migration 0107 revokes access from `PUBLIC`, and migration 0114 does the same for the two v2 views.
The executor grants only approved versioned views. They exclude provider keys, admin audit data, raw CSV,
deduplication hashes, application settings, and AI conversations. The dataset scope is
`local-user-database`. This describes one single-user Vision database; it is not proof that a future
multi-user deployment has row-level authorization. Broader read-only schema access is a separate
security decision.

## Reconciliation checklist

1. Use identical account, date, active-state, timezone, and reporting-currency filters.
2. Compare cash-flow totals with the canonical Statistics monthly query.
3. Confirm transfer legs are visible but contribute zero to default spending and positive flow.
4. Keep refunds as positive flows unless the chosen metric has explicit refund classification.
5. Replay holdings through the shared portfolio cost-basis engine.
6. Compare broker partitions with the global portfolio result.
7. Record missing exchange rates or source fields as partial coverage.

## Canonical service datasets

The service catalog adds `positions`, `cost-basis`, `portfolio-history`, `broker-history`,
`fx-history` and `benchmark-history` (schema version 1). These IDs are registered separately from
SQL views. They use whitelisted projections and the canonical partitioned portfolio replay;
application tables remain unavailable to user-authored SQL.

Current positions/cost basis value today's active investments using stored FX evidence and the
selected weighted-average/FIFO/LIFO policy. Stamped event FX takes precedence. Missing FX or an
open market asset's missing quote withholds affected figures and reports partial coverage; known
units/basis may remain available. History reads existing snapshots and never creates history.
Returns are gain/capital ratios; benchmark returns are price returns without dividend reinvestment.
Neither is claimed as time-weighted performance. Stock values require closing-period comparisons,
with broker account partitions preserved. Aggregated stocks first select the last observation
per currency and, for broker history, per account inside each output bucket, then combine those
closing observations. Missing older observations remain partial coverage even when a later closing
observation is available. Benchmark price returns use the first positive close within the inclusive
`from`/`to` interval, before applying other field filters; those filters do not rebase returns.

Money units retain native/original currency identity and explicit reporting-currency semantics.
Conversion uses stored on-or-before rates and decimal source/target ratios; missing evidence never
becomes 1:1. Dataset coverage and methodology accompany every result. Source reads cap at 100,000
rows/20 MiB; grouped output paginates only after filtering and aggregation, capped at 1,000 rows
and 2 MiB per output page. Financial pivots reuse one source snapshot across hierarchy levels.

## Related

- [[docs/adr/175-bounded-analysis-workbench|ADR-175]]

- [[docs/adr/140-versioned-analysis-datasets|ADR-140: Versioned Analysis Datasets]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/features/statistics|Statistics]]
- [[docs/features/portfolio|Portfolio]]
