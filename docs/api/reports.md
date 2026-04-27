---
title: Reports API
type: endpoint
status: active
date: 2026-04-27
tags:
  - api
  - reports
  - pdf
  - export
  - phase-3
  - phase-5
  - phase-6
  - phase-7
  - puppeteer
  - theme-aware
  - pagination
  - footer
  - i18n
  - filter-exclusions
  - dual-chart
  - comparison
  - white-bar-fix
  - table-overflow-fix
  - page-continuation
description: PDF report generation endpoints with Puppeteer rendering, modular sections, and theme-aware styling. Phase 5 adds paginated footers with CSS page margin fix and enhanced print breaks. Phase 5 fixes add white bar elimination in page margins and table overflow prevention via page-continuation layout. Phase 6 adds i18n support. Phase 7 adds filter exclusions with dual-chart comparison view and section-level filtering. Three POST endpoints (financial, portfolio, tax) with legacy GET fallback.
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
- **CSS @page Margin Rule**: `@page { margin: 0 0 28px 0; }` ensures Chrome's layout engine respects the 28px footer margin, preventing table overflow into footer
- **Print Break Control**: New CSS rules in `SECTION_CSS` block:
  - `.kpi-card { break-inside: avoid }` — prevents KPI card splits
  - `.account-card { break-inside: avoid }` — keeps account balance cards intact
  - `.stat-row { break-inside: avoid }` — preserves row alignment
  - `.planned-day { break-inside: avoid }` — keeps day groups intact
  - `.data-table thead { display: table-header-group }` — repeats headers on page overflow
- **Table Row Pagination**: `.data-table tr { break-inside: avoid; page-break-inside: avoid; }` prevents rows from splitting; word-break and truncation prevent overflow
- **Section Title Preservation**: `.section-title` and `.section-subtitle` use `break-after: avoid` to keep headers with content
- **Visual Separation**: `.page` border-top changed to `4px solid hsl(var(--primary))`

### Phase 5 Fixes — White Bar & Table Overflow (2026-04-27)

**Fix 1: White Bar in Page Margin Area**
- **Root Cause**: Chromium's footer iframe occupies less vertical space than the 28px bottom `@page` margin. The `html` element's background does not propagate to `@page` margin boxes, leaving a white gap at the bottom of every page in dark mode.
- **Solution**: Two-part approach in `buildBaseCss()`:
  1. **@page rule background (primary fix)**: Added `background: hsl(var(--surface))` to the `@page { margin: 0 0 28px 0; }` rule. This paints the entire page canvas, including margin boxes, eliminating the white strip.
  2. **html and body background (supporting fix)**: Added `background: hsl(var(--surface))` with `print-color-adjust: exact` to both `html` and `body` to ensure surface color propagates through the document tree.
- **Footer template update**: Comment block updated to note that page-bottom surface fill is now owned by `@page { background }`, not the footer template body. Template body remains intentionally minimal (margin:0; padding:0;) to avoid the html-rule leak that previously hid cover/section content. Footer div retains inline `background-color` for the visible footer band.
- **Result**: Surface color now fills the entire page canvas, including margin boxes, eliminating the white bar and providing seamless visual continuity around the footer in both light and dark themes.

**Fix 2: Table Overflow into Footer**
- **Root Cause**: Large tables in `categoryBreakdown` and `topRecipients` sections would overflow rows into the Puppeteer footer zone when page breaks occurred near the table start.
- **Solution**: Split both section renderers into two consecutive divs using new `.page-continuation` CSS class:
  1. **Chart page** (`.page.page-break`): Title, subtitle, and all chart(s); explicit page break
  2. **Table page** (`.page-continuation`): Filter notice, ranked table, and sub-tables (month-over-month); always starts on fresh page
- **CSS Class Added**:
  ```css
  .page-continuation {
    padding: 32px 52px 56px;
    border-top: none;
    page-break-before: always;
  }
  ```
- **Result**: Tables always start at the top of a fresh physical page without row orphaning or overflow into the footer zone. Logical pagination improves readability and reliability.

### Phase 7 — Dual-Chart Comparison Layout (2026-04-27)

- **Dual-Chart CSS Classes**: New `.chart-pair` and `.chart-pair-label` classes enable side-by-side chart comparison when filter exclusions are active
  - `.chart-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; break-inside: avoid; page-break-inside: avoid; }` — two-column layout with print-break protection
  - `.chart-pair-label { break-after: avoid; page-break-after: avoid; }` — keeps labels with their charts
- **Section-Level Filtering**: `categoryBreakdown` and `topRecipients` sections now support dual-chart rendering:
  - **With exclusions**: Displays "With active filters" chart (filtered data) alongside "All data" chart (unfiltered) for impact visibility
  - **Without exclusions**: Single chart rendered in standard `.chart-wrap` layout
- **Filter Notice Banner**: `.filter-notice` div appears below dual charts when exclusions active, showing filtered row count and excluded item count
- **Table Row Filtering**: Table shows only filtered rows when exclusions active; unfiltered rows available in the "All data" chart above
- **Max Item Limits**: Charts limited to top 10 items; tables to top 15–20 rows depending on section

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
  },
  "excludedCategoryIds": [],
  "excludedRecipientIds": []
}
```

**Request Fields**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `currency` | string | `EUR` | 3-letter ISO currency code (e.g., EUR, USD, GBP) |
| `period` | object | `{ kind: "rolling", months: 12 }` | Period descriptor (see Period Options below) |
| `sections` | array | `[]` (uses defaults) | List of section IDs to include; empty = default sections |
| `theme` | object | `{}` | Theme tokens (HSL values); omit to use defaults |
| `excludedCategoryIds` | array | `[]` | Category IDs to exclude from filtered view (generates filter impact comparison) |
| `excludedRecipientIds` | array | `[]` | Recipient IDs to exclude from filtered view (generates filter impact comparison) |

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

**Filter Impact Comparison**

When `excludedCategoryIds` or `excludedRecipientIds` are provided, the report includes a "Filter Impact" section on the cover page showing:

- **With Filters**: Financial metrics (Total Income, Total Expenses, Net Position, Transaction Count) calculated with exclusions applied
- **All Data**: Same metrics without exclusions
- **Delta badges**: Changes between filtered and unfiltered views (↑/↓)

Additionally, `categoryBreakdown` and `topRecipients` sections show a `.filter-notice` banner when relevant exclusions are active.

**Example Request (with filters)**

```javascript
const response = await fetch('/api/reports/financial', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currency: 'EUR',
    period: { kind: 'rolling', months: 12 },
    sections: [],
    theme: { /* theme tokens */ },
    excludedCategoryIds: [5, 7],      // Exclude Travel, Subscriptions
    excludedRecipientIds: [12, 18]    // Exclude Amazon, Netflix
  })
});

const blob = await response.blob();
// Trigger download or process binary stream
```

### POST /api/reports/portfolio

Generate a portfolio PDF report (placeholder).

**Request body:** Same schema as `/api/reports/financial`. (`excludedCategoryIds` and `excludedRecipientIds` are accepted but not used in the placeholder implementation.)

**Response:** "Coming soon" placeholder page.

### POST /api/reports/tax

Generate a tax PDF report (placeholder).

**Request body:** Same schema as `/api/reports/financial`. (`excludedCategoryIds` and `excludedRecipientIds` are accepted but not used in the placeholder implementation.)

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
