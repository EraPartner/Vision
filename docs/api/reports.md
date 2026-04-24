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
  - phase-3
  - phase-5
  - phase-6
  - puppeteer
  - theme-aware
  - pagination
  - footer
  - i18n
description: PDF report generation endpoints with Puppeteer rendering, modular sections, and theme-aware styling. Phase 5 adds paginated footers and enhanced print breaks. Phase 6 adds i18n support. Three POST endpoints (financial, portfolio, tax) with legacy GET fallback.
aliases:
  - reports
  - pdf export
  - financial report
  - report download
related_code:
  - apps/node-backend/src/services/reports/index.js
  - apps/node-backend/src/services/reports/sectionHelpers.js
  - apps/node-backend/src/services/reports/dataFetcher.js
  - apps/node-backend/src/services/reports/sections/
  - apps/node-backend/src/services/reports/puppeteerRenderer.js
  - apps/node-backend/src/routes/reports.js
  - apps/frontend/src/lib/api/reports.ts
  - apps/frontend/src/lib/themeTokens.ts
---

# Reports API

Server-side PDF generation via **Puppeteer headless Chrome** (Phase 3 redesign). Returns a binary stream (`application/pdf`), not the standard [[docs/adr/026-unified-api-response-envelope|ADR-026 JSON envelope]].

**Key Features:**
- **Modular sections**: 7 financial section renderers (executive summary, cashflow, categories, recipients, bank balances, rolling averages, planned outlook)
- **Theme-aware styling**: CSS custom properties (HSL) from frontend theme tokens
- **Period filtering**: YTD, rolling N months, custom date range, or specific year
- **Paginated footers** (Phase 5): "Vision | Confidential | page X / Y" on all content pages; theme colors interpolated as HSL literals
- **Enhanced print breaks** (Phase 5): `break-inside: avoid` prevents card/row orphaning; `display: table-header-group` repeats table headers across pages
- **Full i18n support** (Phase 6): 32 translation keys for dialog UI, period labels, section toggles, and actions (en/nl)
- **Graceful degradation**: Promise.allSettled ensures one failed data source doesn't crash report
- **Three report types**: Financial (complete), Portfolio (placeholder), Tax (placeholder)

## Phase Updates

### Phase 5 — PDF Polish (2026-04-24)

- **Paginated Footer**: Puppeteer `footerTemplate` option now used with theme-aware colors (primary, muted, border) interpolated as HSL literals. Footer displays on all content pages except cover.
- **Footer Space Management**: CSS variable `--footer-h: 28px` reserves space; Puppeteer margin `{ bottom: '28px' }` aligns footer area with cover page
- **Print Break Control**: New CSS rules in `SECTION_CSS` block:
  - `.kpi-card { break-inside: avoid }` — prevents KPI card splits
  - `.account-card { break-inside: avoid }` — keeps account balance cards intact
  - `.stat-row { break-inside: avoid }` — preserves row alignment
  - `.planned-day { break-inside: avoid }` — keeps day groups intact
  - `.data-table thead { display: table-header-group }` — repeats headers on page overflow
- **Section Title Preservation**: `.section-title` and `.section-subtitle` use `break-after: avoid` to keep headers with content
- **Visual Separation**: `.page` border-top changed to `4px solid hsl(var(--primary))`

### Phase 6 — Localization (2026-04-24)

- **32 New Translation Keys**: Added `export.*` keys to `i18n/source/en.json` and `i18n/source/nl.json` for full i18n coverage
- **Key Categories**:
  - Dialog UI: `export.title`, `export.description`, `export.openDialog`
  - Report Types: `export.reportType`, `export.reportType.{financial,portfolio,tax}`
  - Periods: `export.period`, `export.period.{ytd,rolling3,rolling12,year,custom}`, labels
  - Sections: `export.sections`, `export.section.{7 financial + 3 placeholder}`
  - Actions: `export.{currency,download,downloading,comingSoon}`
- **Generated Artifacts**: Keys regenerated into `apps/frontend/src/locales/en.ts` and `nl.ts` via build system
- **Validation**: All keys pass parity checks, placeholder consistency, type safety, and drift detection

## Base URL

```
/api/reports
```

## Endpoints

### POST /api/reports/financial

Generate a theme-aware financial PDF report with custom section selection and period filtering.

**Request Body (JSON)**

```json
{
  "currency": "EUR",
  "period": { "kind": "rolling", "months": 12 },
  "sections": ["executiveSummary", "cashflowTrend", "categoryBreakdown", "topRecipients", "bankBalances", "rollingAverages"],
  "theme": {
    "primary": "250 84% 60%",
    "accent": "280 84% 60%",
    "success": "120 84% 60%",
    "expense": "0 84% 60%",
    "surface": "0 0% 98%",
    "text": "0 0% 18%",
    "muted": "0 0% 50%",
    "border": "0 0% 92%",
    "chart1": "250 84% 60%",
    "chart2": "280 84% 60%",
    "chart3": "120 84% 60%",
    "chart4": "0 84% 60%",
    "chart5": "180 84% 60%",
    "chart6": "30 84% 60%",
    "chart7": "300 84% 60%",
    "chart8": "60 84% 60%",
    "mode": "light"
  }
}
```

**Request Fields**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `currency` | string | `EUR` | 3-letter ISO currency code (e.g., EUR, USD, GBP) |
| `period` | object | `{ kind: "rolling", months: 12 }` | Period descriptor (see Period Options below) |
| `sections` | array | `[]` (uses defaults) | List of section IDs to include; empty = default sections |
| `theme` | object | `{}` | Theme tokens (HSL values); omit to use defaults |

**Period Options**

- `{ "kind": "ytd" }` — Current calendar year (January 1 to today)
- `{ "kind": "rolling", "months": N }` — Last N months (N = 1 to 60)
- `{ "kind": "custom", "from": "2025-01-01", "to": "2025-12-31" }` — Date range
- `{ "kind": "year", "year": 2025 }` — Specific calendar year

**Available Sections**

| Section ID | Description |
|-----------|-------------|
| `executiveSummary` | KPI grid + per-month table |
| `cashflowTrend` | Grouped bar chart (income vs expenses) + data table |
| `categoryBreakdown` | Horizontal bars of top categories + ranked table |
| `topRecipients` | Top merchants/recipients + month-over-month change badges |
| `bankBalances` | Account balance cards + net position summary |
| `rollingAverages` | 6-month rolling average vs current month pace |
| `plannedOutlook` | Next-month planned transactions grouped by date |

**Default Sections (when `sections` is omitted or empty)**

All sections except `plannedOutlook`.

**Response Headers**

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="vision-financial-YYYY-MM-DD.pdf"
Content-Length: <byte-count>
```

**Response body:** Raw PDF binary stream (A4 page size, portrait orientation).

**Error Response (400)**

```json
{
  "error": "Invalid report request: currency: currency must be a 3-letter ISO code"
}
```

**Example Request**

```javascript
const response = await fetch('/api/reports/financial', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currency: 'EUR',
    period: { kind: 'rolling', months: 12 },
    sections: [],
    theme: { /* theme tokens */ }
  })
});

const blob = await response.blob();
// Trigger download or process binary stream
```

### POST /api/reports/portfolio

Generate a portfolio PDF report (placeholder).

**Request body:** Same schema as `/api/reports/financial`.

**Response:** "Coming soon" placeholder page.

### POST /api/reports/tax

Generate a tax PDF report (placeholder).

**Request body:** Same schema as `/api/reports/financial`.

**Response:** "Coming soon" placeholder page.

### GET /api/reports/financial (Legacy)

Kept for backward compatibility; falls back to legacy PDFKit renderer.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | `EUR` | 3-letter ISO currency code |
| `target_currency` | string | — | Alternative name for currency (accepted for compatibility) |

**Deprecated.** Use POST endpoint instead to access theme customization and section selection.

## Frontend Usage

```typescript
import { downloadFinancialReport } from '@/lib/api/reports';

// Simple download with defaults
await downloadFinancialReport();

// Custom options
await downloadFinancialReport({
  currency: 'USD',
  period: { kind: 'ytd' },
  sections: ['executiveSummary', 'cashflowTrend', 'categoryBreakdown'],
  theme: { /* custom theme tokens */ }
});
```

The frontend helper:
1. Resolves active theme tokens from DOM CSS custom properties
2. Assembles POST body with user selections
3. Fetches as a Blob
4. Creates an object URL and triggers browser download

No `apiRequest` wrapper is used because the response is a binary stream.

## Implementation Notes

### Architecture

- **Dispatcher** (`apps/node-backend/src/services/reports/index.js`): Routes by report type, builds HTML, invokes Puppeteer
- **Data fetcher** (`apps/node-backend/src/services/reports/dataFetcher.js`): Parallel Promise.allSettled loads all data; graceful degradation
- **Section renderers** (`apps/node-backend/src/services/reports/sections/`): Pure functions; each section independent
- **Theme system** (`themeCss.js` + `sectionHelpers.js`): CSS tokens, formatters, SVG chart builders
- **Puppeteer renderer** (`puppeteerRenderer.js`): Headless Chrome → PDF buffer

### Data Sources

All fetched in parallel via Promise.allSettled:
- `computeMonthlySummary()` — per-month totals
- `computeCategoryBreakdown()` — category spending
- `computeRecipientInsights()` — top merchants
- `computeBankBalances()` — account balances
- `computeAverageVsCurrent()` — rolling averages
- `infoRepository.getPlannedExpensesNextMonth()` — planned transactions

### Performance

- **Parallel data loading**: All sources fetched concurrently
- **Graceful degradation**: Failed sources return null; sections skip silently
- **PDF buffering**: Entire report generated before streaming to client
- **Typical size**: 2–10 MB depending on transaction volume

### Dependencies

- **Puppeteer 24.42.0**: Headless Chrome for print-to-PDF (added Phase 3)
- **Zod**: Schema validation for request body

### Shutdown Behavior

Backend gracefully closes Puppeteer browser on SIGINT/SIGTERM via `closePuppeteerBrowser()` exported from `puppeteerRenderer.js`.

## Related

- [[docs/features/pdf-report-export|PDF Report Export feature doc]] — user-facing feature
- [[docs/api/aggregations|Aggregations API]] — source data endpoints
- [[docs/adr/026-unified-api-response-envelope|ADR-026]] — why this route does *not* use the standard envelope
