---
title: PDF Financial Report Export
type: feature
status: active
date: 2026-04-24
tags: [feature, export, reporting, pdf, statistics, phase-7]
description: One-click PDF financial report export from Statistics page; includes summary cards, monthly breakdown table, and top-10 categories; uses pdfkit for server-side generation with streaming response.
aliases: [pdf export, financial report, report download]
related_code:
  - apps/node-backend/src/services/pdfReportService.js
  - apps/node-backend/src/routes/reports.js
  - apps/frontend/src/lib/api/reports.ts
  - apps/frontend/src/pages/StatisticsPage.tsx
---

# PDF Financial Report Export (Phase 7)

> [!abstract] Overview
> Users can export a comprehensive financial summary as a PDF document from the Statistics page. The report includes summary KPIs, monthly breakdown, and top spending categories. Phase 7 addition.

## Feature Overview

The "Export PDF" button in the Statistics page header triggers a server-side PDF generation and download. The PDF contains:

1. **Summary Cards**: Income, spending, net, and period covered
2. **Monthly Breakdown Table**: Per-month income, spending, net, and transaction count
3. **Top Categories**: Top 10 spending categories by total amount
4. **Metadata**: Generation timestamp, currency

## User Interface

### Export Button

Located in the Statistics page (`/statistics`) header:

- **Button Label**: "Export PDF"
- **Icon**: Download or document icon
- **Behavior**: 
  - Click triggers backend PDF generation
  - File downloads as `financial-report-{YYYY-MM-DD}.pdf`
  - Loading state during generation

## Endpoint

### GET /api/reports/financial

Generate and stream a financial PDF report.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency for report |
| `period` | string | all | Period to include: `all`, `ytd`, `last-12m` |

**Response:**

- **Content-Type**: `application/pdf`
- **Headers**: `Content-Disposition: attachment; filename="financial-report-{YYYY-MM-DD}.pdf"`
- **Body**: Binary PDF stream

**Error Response (400):**

```json
{
  "detail": "Invalid currency code"
}
```

## Backend Implementation

### PDF Report Service

**Location:** `apps/node-backend/src/services/pdfReportService.js`

**Function:**

```javascript
async function generateFinancialReportPDF(params: {
  workspaceId: string;
  currency: string;
  period: 'all' | 'ytd' | 'last-12m';
}): Promise<Buffer>
```

**Algorithm:**

1. **Fetch data**:
   - Monthly aggregations from `/api/aggregations/monthly-summary`
   - Category breakdown from `/api/aggregations/category-breakdown`
   - Fetch all transactions for period filtering

2. **Prepare layout**:
   - A4 page size (210 × 297 mm)
   - Top/bottom margins (20 mm)
   - Left/right margins (15 mm)

3. **Render sections** (top to bottom):
   - **Header**: "Financial Report" title + generation timestamp
   - **Summary Cards**: 4-card KPI section (income, spending, net, count)
   - **Monthly Table**: Tabular breakdown of each month
   - **Top Categories**: Bar-chart-style rendering of top 10 categories
   - **Footer**: Page number, currency notation

### PDF Library

**Library:** `pdfkit@0.18.0`

**Why pdfkit?**
- Pure Node.js, no external dependencies
- Streaming response (memory-efficient)
- Text, table, and image support built-in
- Suitable for server-side generation

### Report Generation Route

**Location:** `apps/node-backend/src/routes/reports.js`

```javascript
router.get('/financial', async (req, res) => {
  const { currency = 'EUR', period = 'all' } = req.query;
  
  const pdf = await generateFinancialReportPDF({
    workspaceId: req.workspace.id,
    currency,
    period
  });
  
  const filename = `financial-report-${new Date().toISOString().split('T')[0]}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdf);
});
```

## Frontend Implementation

### API Client

**Location:** `apps/frontend/src/lib/api/reports.ts`

```typescript
export async function downloadFinancialReport(params?: {
  currency?: string;
  period?: 'all' | 'ytd' | 'last-12m';
}): Promise<void> {
  const url = new URL(`${API_BASE}/reports/financial`, window.location.origin);
  if (params?.currency) url.searchParams.set('currency', params.currency);
  if (params?.period) url.searchParams.set('period', params.period);
  
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error('Report generation failed');
  
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `financial-report-${new Date().toISOString().split('T')[0]}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}
```

### StatisticsPage Button

**Location:** `apps/frontend/src/pages/StatisticsPage.tsx`

```typescript
const [isExporting, setIsExporting] = useState(false);

const handleExportPDF = async () => {
  setIsExporting(true);
  try {
    await downloadFinancialReport({ currency: 'EUR' });
    toast.success('Report downloaded');
  } catch (error) {
    toast.error('Failed to generate report');
  } finally {
    setIsExporting(false);
  }
};

return (
  <button 
    onClick={handleExportPDF}
    disabled={isExporting}
  >
    {isExporting ? 'Exporting...' : 'Export PDF'}
  </button>
);
```

## PDF Layout

### Page Structure

```
┌─────────────────────────────────┐
│ Financial Report                │  Header
│ Generated: 2026-04-24           │
├─────────────────────────────────┤
│ Income: 9,550.50 EUR            │  Summary Cards
│ Spending: -6,050.50 EUR         │  (4 columns)
│ Net: 3,500.00 EUR               │
│ Transactions: 156               │
├─────────────────────────────────┤
│ Month       │ Income │ Spending│  Monthly Table
│ 2026-01     │ 3,500  │ -2,150 │
│ 2026-02     │ 3,500  │ -1,900 │
│ ...         │  ...   │  ...   │
├─────────────────────────────────┤
│ Top Categories                  │  Categories
│ Groceries: 850.00               │  (bar-style)
│ Transport: 425.50               │
│ ...                             │
├─────────────────────────────────┤
│ Page 1 of 1 | EUR               │  Footer
└─────────────────────────────────┘
```

## Data Source

The PDF uses real-time data from:

| Component | Source |
|-----------|--------|
| Summary cards | Computed from monthly aggregations |
| Monthly table | `/api/aggregations/monthly-summary` |
| Top categories | `/api/aggregations/category-breakdown` |

## Performance Considerations

- **Server-side generation**: All data fetching and PDF rendering on backend
- **Streaming response**: Binary stream sent directly to client (no buffering)
- **Async operation**: PDF generation doesn't block other requests
- **Timeout**: Set reasonable timeout (e.g., 30s) for large reports

## Related Features

- [[docs/features/statistics|Statistics Feature]] — Host page
- [[docs/features/transactions|Transactions Export]] — CSV/JSON export options

## Related

- [[docs/api/index|API Documentation]]
- [[docs/features/statistics|Statistics Feature]]
