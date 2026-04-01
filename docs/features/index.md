---
title: Features Documentation Index
type: features-index
status: active
date: 2026-03-31
tags: [features, index, documentation]
description: Feature documentation for all major capabilities of the Vision application
aliases: [features, capabilities]
---

# Features Documentation

> [!abstract] Overview
> Documentation for all major features in Vision, from core transaction management to portfolio tracking and Belgian tax support.

## All Features

```dataview
TABLE WITHOUT FILE title AS "Feature", description AS "Description", date AS "Updated"
FROM "docs/features"
WHERE type = "feature"
SORT title ASC
```

## Feature Categories

### Core Features
- [[docs/features/views\|Views & Pages]] - Complete overview of all views and pages
- [[docs/features/transactions\|Transactions]] - Core financial transaction management
- [[docs/features/import\|Imports]] - CSV import with deduplication

### Organization
- [[docs/api/categories\|Categories]] - Category management ("GENERAL:DETAIL" format)
- [[docs/api/recipients\|Recipients]] - Payee/payer management with merge support

### Planning & Scheduling
- [[docs/features/plannedTransactions\|Planned Payments]] - Scheduled and recurring transactions, including loan support

### Portfolio & Investments
- [[docs/features/portfolio\|Portfolio]] - Investment tracking (stocks, ETFs, crypto, metals, real estate, savings, bonds)

### Tax
- [[docs/adr/002-database-schema\|Belgian Tax]] - Tax profile and deductions (schema)

### Analytics
- [[docs/api/marketLookup\|Analytics]] - Statistics and reporting

## Related Documentation

- [[docs/api/index\|API Documentation]] - Endpoints that power these features
- [[docs/components/index\|Components]] - Frontend components implementing these features
- [[docs/integrations/index\|Integrations]] - External services used by features
