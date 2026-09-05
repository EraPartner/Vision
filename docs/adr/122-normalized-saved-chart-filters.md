---
title: ADR-122 Normalized Saved Chart Filters
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, saved-charts, postgresql, referential-integrity, migrations]
description: Store saved-chart category, recipient, and tag selections in foreign-keyed membership tables while preserving array-shaped API fields.
aliases: [adr-122, normalized-saved-chart-filters]
---

# ADR-122: Normalized Saved Chart Filters

## Status

Accepted

## Context

`saved_charts` stored category, recipient, and tag identifiers in three `INTEGER[]` columns.
PostgreSQL cannot attach a foreign key to each array element. Deleting a category or recipient could
therefore leave a silent dangling filter. Application-level cleanup would still race concurrent
chart updates and would not protect direct database maintenance.

## Decision

Migration 0096 replaces the arrays with `saved_chart_categories`, `saved_chart_recipients`, and
`saved_chart_tags`. Each table has a composite primary key and cascading foreign keys to both the
chart and selected entity. Backfill keeps distinct live identifiers and prunes identifiers that
were already dangling.

The repository remains the compatibility boundary. Reads aggregate memberships into sorted arrays,
and create or update replaces the requested sets inside one transaction. Updates lock the chart row
before replacing memberships. The HTTP API and frontend types therefore keep `categoryIds`,
`recipientIds`, and `tagIds` unchanged. A concurrent deletion is reported as a validation error.

Tag soft-delete does not remove membership rows because the tag still exists. A future hard delete
would receive the same database-enforced cleanup as categories and recipients.

## Consequences

- Entity and chart deletion cannot leave dangling membership rows.
- Duplicate incoming identifiers collapse to one deterministic membership.
- Backup coverage includes all three membership tables.
- Downgrade reconstructs sorted arrays before removing the membership tables.
- A live upgrade and downgrade still require the normal migration verification against disposable
  PostgreSQL before release.

## Related

- [[docs/features/saved-charts|Saved Charts]]
- [[docs/api/savedCharts|Saved Charts API]]
- [[docs/reference/data-model|Data Model]]
- [[apps/node-backend/src/repositories/savedChartsRepository.js|Saved charts repository]]
