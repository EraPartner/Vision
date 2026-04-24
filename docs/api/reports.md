---
title: Reports API
type: endpoint
status: active
date: 2026-04-24
tags:
  - api
  - reports
  - pdf
  - export
  - phase-7
description: PDF report generation endpoint. Returns a binary stream — not a JSON envelope. Added in Phase 7.
aliases:
  - reports
  - pdf export
  - financial report
related_code:
  - apps/node-backend/src/routes/reports.js
  - apps/node-backend/src/services/pdfReportService.js
  - apps/frontend/src/lib/api/reports.ts
---

# Reports API

Server-side PDF generation via PDFKit. Returns a binary stream (`application/pdf`), not the standard [[docs/adr/026-unified-api-response-envelope|ADR-026 JSON envelope]].

## Base URL

```
/api/reports
```

## Endpoints

### GET /api/reports/financial

Generate and stream a full financial report as an A4 PDF.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | `EUR` | 3-letter ISO currency code for all monetary values |

**Response Headers**

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="financial-report-YYYY-MM-DD.pdf"
```

**Response body:** Raw PDF binary stream.

**PDF Contents**

1. **Header** — title, generation date, target currency, period covered
2. **Summary cards** — Total Income, Total Spending, Net Balance, Transaction Count (last 6 months)
3. **Monthly Breakdown table** — one row per month, most-recent first; income/spending/net columns
4. **Top Spending Categories** — top 10 by absolute total, with transaction count and amount

**Error responses**

If the underlying aggregation queries fail, the response body will be a partial or empty PDF. The HTTP status remains `200` until headers are flushed; callers should validate the downloaded file size.

**Example request**

```
GET /api/reports/financial?currency=EUR
```

**Frontend usage**

```typescript
import { downloadFinancialReport } from '@/lib/api/reports';

await downloadFinancialReport({ currency: 'EUR' });
// triggers browser download of financial-report-YYYY-MM-DD.pdf
```

The frontend helper fetches the endpoint as a `Blob`, creates an object URL, and clicks a temporary anchor element to trigger the native download dialog. No `apiRequest` wrapper is used because the response is a binary stream.

## Implementation Notes

- Uses **PDFKit 0.18.0** (Node.js-native, no headless browser required)
- Aggregation data sourced from `computeMonthlySummary` and `computeCategoryBreakdown` — same services as `/api/aggregations/*`
- The route is **not** behind the `AGGREGATIONS_V2_ENABLED` feature flag; it always queries live data
- No auth required beyond standard session middleware (matches other read-only aggregation routes)

## Related

- [[docs/features/pdf-report-export|PDF Report Export feature doc]]
- [[docs/api/aggregations|Aggregations API]] — source data endpoints
- [[docs/adr/026-unified-api-response-envelope|ADR-026]] — why this route does *not* use the standard envelope
