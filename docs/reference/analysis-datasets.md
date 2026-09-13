---
title: Analysis Datasets
type: reference
status: active
date: 2026-09-12
tags: [analysis, datasets, reconciliation, money, portfolio, security]
description: Version-1 dataset catalog, financial meanings, allowed joins, exclusions, and reconciliation rules for Vision analyses.
aliases: [financial datasets, vision_analysis]
related_code:
  - packages/types/src/analysisDatasets.js
  - alembic/versions/0107_analysis_dataset_views.py
  - apps/node-backend/tests/analysisDatasets.test.js
  - apps/node-backend/tests/analysisDatasets.db.test.js
---

# Analysis Datasets

The authoritative machine-readable catalog is `@vision/types/analysis-datasets`. The PostgreSQL
relations live in `vision_analysis`. They are not automatically available to application or public
roles; a future isolated executor must receive an explicit grant.

| Dataset          | Relation                            | Row grain                | Default meaning                                                                            | Known coverage                                                                       |
| ---------------- | ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `transactions@1` | `vision_analysis.transactions_v1`   | One ledger transaction   | Signed canonical row with account, recipient, category, transfer, and active-state context | All ledger history; raw imports and duplicate identities excluded                    |
| `accounts@1`     | `vision_analysis.accounts_v1`       | One own account          | Account policy plus the complete per-currency statement-balance collection                 | Active and archived own accounts; credentials and settings excluded                  |
| `holdings@1`     | `vision_analysis.holding_events_v1` | One portfolio event      | Replay input for the canonical portfolio engine                                            | All portfolio events; current positions are derived, not stored in the view          |
| `cash-flows@1`   | `vision_analysis.cash_flows_v1`     | One budgeting ledger row | Signed flow plus transfer-safe spending and positive-flow projections                      | Budgeting ledger only; portfolio income appears only when represented in that ledger |

## Allowed joins

Version 1 permits `transactions.account`, `cash-flows.account`, and `holdings.account`, each as a
many-to-one join through `account_id`. It does not publish free-form joins to provider, import,
settings, audit, AI transcript, or raw provenance tables.

## Money and signs

- Ledger amounts retain their native currency and sign. Negative means outflow. Positive means
  income or refund. Classification needs more evidence than sign.
- `spending_amount` is the positive magnitude only for non-transfer negative rows.
- `positive_flow_amount` is positive only for non-transfer positive rows.
- Cross-currency totals require an explicit reporting currency and dated exchange-rate evidence.
- Portfolio event amounts use event currency. `fx_rate_to_eur` is transaction-date evidence, not a
  current valuation rate.

## Time

Ledger and portfolio dates are calendar dates. Business grouping uses `APP_TIMEZONE`; it must not
shift a `DATE` through Coordinated Universal Time. Timestamps such as `updated_at` remain instants.

## Holdings

Do not sum event units blindly. Buys and gifts add units and sells remove them, but splits, mergers,
spinoffs, returns of capital, fees, taxes, and cost-basis methods require the canonical Portfolio
replay. A result must record the selected metric and engine versions. Broker partitions must sum to
the global result, and foreign-exchange fallback must create partial coverage rather than a hidden
estimate.

## Security boundary

Migration 0107 revokes access from `PUBLIC` and excludes provider keys, admin audit data, raw CSV,
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

## Related

- [[docs/adr/140-versioned-analysis-datasets|ADR-140: Versioned Analysis Datasets]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/features/statistics|Statistics]]
- [[docs/features/portfolio|Portfolio]]
