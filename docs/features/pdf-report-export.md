---
title: PDF Report Export
type: feature
status: active
date: 2026-04-27
tags: [feature, export, reporting, pdf, statistics, phase-3, phase-4, phase-5, phase-6, phase-7, phase-8, puppeteer, export-dialog, ui, pdf-polish, pagination, footer, i18n, filter-exclusions, dual-chart, comparison, white-bar-fix, table-overflow-fix, page-continuation, portfolio, tax]
description: Comprehensive PDF report export for financial, portfolio, and tax data. Cover page, theme-aware styling, modular section renderers. Phase 4 adds ExportDialog UI. Phase 5 adds pagination/footer/print-break polish. Phase 6 adds i18n. Phase 7 adds filter exclusions with dual-chart comparison. Phase 8 implements full portfolio (6 sections) and tax (7 sections) reports with real data fetchers, belgianRulesSummary, and taxProfile/precomputedPIT pass-through.
aliases: [pdf export, financial report, portfolio report, tax report, report download, PDF generation, export dialog, report dialog, pagination, footer]
related_code:
  - apps/node-backend/src/services/reports/
  - apps/node-backend/src/routes/reports.js
  - apps/frontend/src/lib/api/reports.ts
  - apps/frontend/src/components/reports/ExportDialog.tsx
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/pages/TaxOverviewPage.tsx
  - apps/frontend/src/pages/portfolio/StocksPage.tsx
---

# PDF Financial Report Export

> [!abstract] Overview
> Phase 3: Comprehensive PDF financial report generation with Puppeteer rendering, modular section architecture, theme-aware styling, and period filtering.
> 
> Phase 4 (April 2026): Unified ExportDialog UI component for report configuration, deployed to Statistics, Tax Overview, and Stocks pages. Supports report type selection, five period presets (YTD, rolling 3/12, calendar year, custom range), per-type section toggles, and currency selection.
>
> Phase 5 (April 2026): PDF polish improvements — paginated footer with page numbering, theme-aware footer styling, enhanced print break control (`break-inside: avoid` on card elements), and repeating table headers across page breaks.
>
> Phase 7 (April 2026): Filter exclusions with impact comparison view — when categories or recipients are excluded via the ExportDialog, the report now displays a "Filter Impact" comparison table on the cover page showing metrics with and without filters applied, plus delta badges for change visibility.
>
> Phase 8 (April 2026): Full portfolio and tax report implementation — replaces "Coming soon" placeholders with 6 portfolio sections and 7 tax sections using real data fetchers, shared SVG chart infrastructure (`svgLineChart`, `svgGenericGroupedBarChart`), and Belgian tax pass-through (`taxProfile` + `precomputedPIT`). Portfolio export button added to PortfolioOverviewPage.

## Phase 7: Filter Exclusions with Impact Comparison & Dual-Chart Visualization

### Overview

Phase 7 adds category and recipient filter exclusion support to PDF reports with dual-chart side-by-side comparison. When ExportDialog is configured with exclusions (via `exclusionScope: 'everywhere'` or `'statistics'`), the report:

1. **Fetches parallel data**: Computes financial metrics both with filters applied (filtered view) and without filters (all data view)
2. **Renders impact table**: Shows cover page comparison with columns for "With Filters" and "All Data", plus delta badges (↑/↓) for visibility
3. **Dual-chart sections**: `categoryBreakdown` and `topRecipients` sections display side-by-side horizontal bar charts showing "With active filters" vs "All data" for impact visibility
4. **Section banners**: `.filter-notice` banner appears below the dual charts with row count and filter summary
5. **Filtered tables**: Table renders only the filtered rows when exclusions are active, with a note pointing to the "All data" chart for unfiltered context
6. **CSS styling**: New `.chart-pair` and `.chart-pair-label` classes enable two-column chart layout with print-break preservation

### Implementation Details

**Backend (Node.js):**
- `dataFetcher.js` fetches `filteredMonthly` and `exclusions` metadata when exclusion arrays are non-empty
- `generateReport()` passes `excludedCategoryIds` and `excludedRecipientIds` through the pipeline
- `index.js` (`buildCoverHtml`) renders exclusion metadata ("X categories excluded, Y recipients excluded") on cover
- `executiveSummary.js` renders "Filter Impact" comparison table when `data.filteredMonthly` is present
- `categoryBreakdown.js` and `topRecipients.js` now render dual charts using `.chart-pair` layout when exclusions are present

**Frontend (React):**
- `ExportDialog.tsx` reads active exclusions from `useSettings()` context when `exclusionScope` is `'everywhere'` or `'statistics'`
- `postReportDownload()` forwards `excludedCategoryIds` and `excludedRecipientIds` in POST body

**CSS:**
- `@page { margin: 0 0 28px 0 }` — Fixed CSS page rule (was `margin: 0`) to align Chrome layout engine with Puppeteer physical 28px footer margin, eliminating table overflow into footer
- `.chart-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; break-inside: avoid; }` — Two-column side-by-side chart layout with print-break protection
- `.chart-pair-label { ... break-after: avoid; }` — Keeps chart labels with their charts across page boundaries
- `.data-table tr { break-inside: avoid; page-break-inside: avoid; }` — Prevents individual rows from splitting across pages (dual fallback for cross-browser support)
- `.data-table thead { display: table-header-group; }` — Repeats table headers on overflow pages
- `.data-table td { word-break: break-word; }` — Allows cell text to wrap rather than overflow layout
- `.data-table td:nth-child(2) { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` — Truncates long category/recipient names in second column

### Database Schema

Migrations (if needed) are handled via existing alembic; no new tables added. Exclusions are passed as query parameters only, not persisted.

---

## Phase 6: i18n (Localization)

### Overview

Phase 6 adds full localization support for the PDF export feature with 32 new translation keys covering:
- Dialog UI labels (title, description, report type, period, sections, currency)
- Period preset labels (YTD, rolling 3/12, calendar year, custom range)
- Section toggle labels (executive summary, cashflow trend, category breakdown, top recipients, bank balances, rolling averages, planned outlook)
- Action buttons and loading states

All keys added to `i18n/source/en.json` and `i18n/source/nl.json`, with generated locale files in `apps/frontend/src/locales/en.ts` and `nl.ts`.

### i18n Key Additions (Phase 6)

**Dialog & Controls:**
- `export.title` — "Export PDF Report"
- `export.description` — "Configure your report, then download it as a PDF."
- `export.openDialog` — "Export PDF"

**Report Type Selection:**
- `export.reportType` — "Report Type"
- `export.reportType.financial` — "Financial"
- `export.reportType.portfolio` — "Portfolio"
- `export.reportType.tax` — "Tax"

**Period Selection:**
- `export.period` — "Period"
- `export.period.ytd` — "Year to Date"
- `export.period.rolling3` — "Last 3 Months"
- `export.period.rolling12` — "Last 12 Months"
- `export.period.year` — "Full Year"
- `export.period.year.label` — "Year"
- `export.period.custom` — "Custom Range"
- `export.period.from` — "From"
- `export.period.to` — "To"

**Section Toggles:**
- `export.sections` — "Sections"
- `export.sections.all` — "All"
- `export.section.executiveSummary` — "Executive Summary"
- `export.section.cashflowTrend` — "Cashflow Trend"
- `export.section.categoryBreakdown` — "Category Breakdown"
- `export.section.topRecipients` — "Top Recipients"
- `export.section.bankBalances` — "Bank Balances"
- `export.section.rollingAverages` — "Rolling Averages"
- `export.section.plannedOutlook` — "Planned Outlook"
- `export.section.portfolioAllocation` — "Portfolio Allocation"
- `export.section.topHoldings` — "Top Holdings"
- `export.section.taxBreakdown` — "Tax Breakdown"

**Currency & Actions:**
- `export.currency` — "Currency"
- `export.download` — "Download PDF"
- `export.downloading` — "Generating…"
- `export.comingSoon` — "This report type is not yet available — a placeholder PDF will be generated."

All keys are in both English (`en.ts`) and Dutch (`nl.ts`) locale files, generated from `i18n/source/en.json` and `i18n/source/nl.json`.

---

## Phase 5: PDF Polish (Pagination, Footer, Print Breaks)

### Overview

Phase 5 adds professional pagination and layout enhancements to PDF reports:

1. **Paginated Footer** — Puppeteer footer template displays "Vision | Confidential | page X / Y" on every page (except cover)
2. **Theme-Aware Footer** — Footer colors (primary, muted, border) interpolated from the report's active theme as HSL literals (because CSS custom properties are unavailable in Puppeteer footer context)
3. **Print Break Control** — CSS `break-inside: avoid` prevents orphaning of `.kpi-card`, `.account-card`, `.stat-row`, `.planned-day` elements across page boundaries
4. **Repeating Table Headers** — `display: table-header-group` on `.data-table thead` ensures table headers repeat on overflow pages
5. **Footer Space Reservation** — Bottom margin of 28px accounts for footer height; CSS variable `--footer-h: 28px` prevents overlap with page content

### Phase 5 Fixes (April 2026): White Bar & Table Overflow

#### Fix 1: White Bar in Page Margin Area

**Problem:** In CSS paged media, the `html` root element's background does not propagate to the `@page` margin boxes. Chromium's footer iframe occupies less vertical space than the 28px bottom margin, leaving a white gap at the bottom of every page in dark mode.

**Solution:** Two-part approach in `buildBaseCss()`:

1. **@page rule background (primary fix):**
   ```css
   @page { 
     size: A4 portrait; 
     margin: 0 0 28px 0; 
     background: hsl(var(--surface));  /* NEW: Paints entire canvas including margin boxes */
   }
   ```
   This fills the complete page canvas, including the margin area where the Puppeteer footer renders, eliminating the white strip.

2. **html and body background (supporting fix):**
   ```css
   html {
     background: hsl(var(--surface));
     -webkit-print-color-adjust: exact;
     print-color-adjust: exact;
   }
   
   body {
     background: hsl(var(--surface));
     -webkit-print-color-adjust: exact;
     print-color-adjust: exact;
   }
   ```
   These ensure the surface color propagates through the entire document tree.

**Footer template comment:** The `buildFooterTemplate()` comment block was updated to note that page-bottom surface fill is now owned by `@page { background }`, not the footer template. The template body remains intentionally minimal (margin:0; padding:0;) to avoid the html-rule leak that previously hid cover/section content. The footer div retains inline `background-color: ${surface}` for the visible footer band itself.

#### Fix 2: Table Overflow into Footer

**Problem:** Large tables in `categoryBreakdown` and `topRecipients` sections would overflow rows into the Puppeteer footer zone when a page break occurred near the table. This caused rows to be cut off or rendered below the footer.

**Solution:** Split both section renderers into two consecutive divs:

1. **First div** (`.page.page-break`):
   - Contains the section title, subtitle, and all chart(s)
   - Ends with explicit page break (`page-break-after: always`)

2. **Second div** (`.page-continuation`):
   - New CSS class: `padding: 32px 52px 56px; border-top: none; page-break-before: always;`
   - Contains filter notice (if active), ranked table, and month-over-month sub-tables
   - Starts on a fresh physical page; tables begin at the top without orphaning rows

**CSS Class Added:**
```css
.page-continuation {
  padding: 32px 52px 56px;
  border-top: none;
  page-break-before: always;
}
```

This ensures:
- Charts render on their own page boundary
- Tables always start at the top of a fresh physical page
- No rows overflow into the footer zone
- Visual continuity maintained (no green top border repeated on continuation pages)

**Affected Sections:**
- `apps/node-backend/src/services/reports/sections/categoryBreakdown.js` — Chart on page 1, table on page 2 (continuation)
- `apps/node-backend/src/services/reports/sections/topRecipients.js` — Charts on page 1, table + month-over-month on page 2+ (continuation)

### Layout Changes

- **Cover page height**: Changed from 297mm to `calc(297mm - var(--footer-h))` to account for footer space
- **Cover page border**: Added 4px solid primary-color top border to content pages (`.page`)
- **Section titles/subtitles**: Added `break-after: avoid` to keep titles with their content
- **Puppeteer options**: `renderHtmlToPdf()` now accepts optional `footerTemplate`, `headerTemplate`, and `margin` parameters

### Footer Template HTML

The footer template is a Puppeteer-isolated HTML fragment (no CSS custom properties from report HTML). Theme colors are interpolated as `hsl()` literals:

```html
<div style="
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 52px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 9px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  color: hsl(var(--muted));
  border-top: 1px solid hsl(var(--border));
">
  <span style="font-weight: 600; color: hsl(var(--primary));">Vision</span>
  <span>Confidential</span>
  <span>
    <span class="pageNumber"></span>&thinsp;/&thinsp;<span class="totalPages"></span>
  </span>
</div>
```

Puppeteer automatically replaces `.pageNumber` and `.totalPages` spans with the actual values on render.

---

## Phase 4: ExportDialog UI Component

### Overview

The `ExportDialog` component provides a unified, reusable interface for configuring and downloading PDF reports across the app. It appears as an "Export PDF" button in key statistics/portfolio pages and opens a modal where users select:

1. **Report Type** — Financial, Portfolio, or Tax (radio group)
2. **Period** — YTD, last 3 months, last 12 months, specific year, or custom date range
3. **Sections** — Per-type toggles for which sections to include; "All" checkbox
4. **Currency** — Dropdown of common currencies (EUR, USD, GBP, CHF, JPY, CAD, AUD, SEK, NOK, DKK, PLN, CZK)

### Component Location

**File:** `apps/frontend/src/components/reports/ExportDialog.tsx`

### Props

```typescript
interface ExportDialogProps {
  /**
   * Custom trigger element (optional).
   * Defaults to an "Export PDF" button if not provided.
   */
  trigger?: React.ReactNode;

  /**
   * Pre-selected report type when the dialog opens.
   * Defaults to 'financial'.
   * Set to 'portfolio' in StocksPage, 'tax' in TaxOverviewPage.
   */
  defaultType?: 'financial' | 'portfolio' | 'tax';
}
```

### Usage

```typescript
// Default (financial report)
<ExportDialog />

// With custom default type
<ExportDialog defaultType="tax" />

// With custom trigger
<ExportDialog
  defaultType="portfolio"
  trigger={
    <Button variant="secondary">
      <Download className="h-4 w-4" />
      Download Report
    </Button>
  }
/>
```

### Pages Using ExportDialog

| Page | Path | Default Type | Position |
|------|------|--------------|----------|
| Statistics | `apps/frontend/src/pages/StatisticsPage.tsx` | `financial` | PageHeader actions (left of WidgetVisibilityDialog) |
| Tax Overview | `apps/frontend/src/pages/TaxOverviewPage.tsx` | `tax` | PageHeader actions (alongside TaxProfileDialog) |
| Stocks | `apps/frontend/src/pages/portfolio/StocksPage.tsx` | `portfolio` | PageHeader actions (alongside AddInvestmentDialog) |
| Portfolio Overview | `apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx` | `portfolio` | PageHeader actions (first action slot) |

### Period Presets

| Preset | API Equivalent | UI Label |
|--------|---|---|
| `ytd` | `{ kind: 'ytd' }` | Year to Date |
| `rolling3` | `{ kind: 'rolling', months: 3 }` | Last 3 Months |
| `rolling12` | `{ kind: 'rolling', months: 12 }` | Last 12 Months (default) |
| `year` | `{ kind: 'year', year: YYYY }` | Specific Year (year input) |
| `custom` | `{ kind: 'custom', from: YYYY-MM-DD, to: YYYY-MM-DD }` | Custom Range (from/to inputs) |

### Section Toggles

**Financial Report (7 sections):**
- Executive Summary
- Cashflow Trend
- Category Breakdown
- Top Recipients
- Bank Balances
- Rolling Averages
- Planned Outlook

**Portfolio Report (6 sections):**
- Portfolio Summary
- Portfolio Allocation
- Top Holdings
- Performance Trend
- Asset Class Detail
- Dividend Income

**Tax Report (7 sections):**
- Tax Summary
- Tax Type Breakdown
- Tax by Asset Class
- Monthly Tax Trend
- Top Investments by Cost
- Fee Breakdown
- Belgian Tax Rules

### Section Behavior

- All sections default to **enabled** when the dialog opens
- Users can toggle individual sections on/off via checkboxes
- An "All" checkbox appears in the Sections header for bulk select/deselect
- **Important:** When all sections are selected, the component sends an **empty array** to the backend (`[]`), signaling "use backend defaults." This contract ensures:
  - Backend default ordering is respected
  - Backward compatibility with existing clients
  - Clean API contract (empty sections = defaults)

### Currency Selection

Dropdown of 12 currencies: EUR, USD, GBP, CHF, JPY, CAD, AUD, SEK, NOK, DKK, PLN, CZK.

Defaults to the user's app-wide `defaultCurrency` setting (from `AppSettingsContext`).

### Loading and Error States

- **Submitting:** Shows "Generating…" button text with spinning `Loader2` icon while the backend renders the PDF
- **Disabled:** Download button is disabled if no sections are selected or while submitting
- **Error:** Toast notification with error message from the API response
- **Success:** Dialog closes and "PDF report downloaded" toast appears (using `statsPage.report.downloadSuccess` i18n key)

### i18n Keys

All 33 `export.*` keys are in `apps/frontend/src/locales/en.ts` and `nl.ts`:

```
export.title                          → "Export PDF Report"
export.description                    → "Configure your report before downloading."
export.reportType                     → "Report Type"
export.reportType.financial           → "Financial"
export.reportType.portfolio           → "Portfolio"
export.reportType.tax                 → "Tax"
export.period                         → "Period"
export.period.ytd                     → "Year to Date"
export.period.rolling3                → "Last 3 Months"
export.period.rolling12               → "Last 12 Months"
export.period.year                    → "Specific Year"
export.period.year.label              → "Year"
export.period.custom                  → "Custom Range"
export.period.from                    → "From"
export.period.to                      → "To"
export.sections                       → "Sections"
export.sections.all                   → "All"
export.section.executiveSummary       → "Executive Summary"
export.section.cashflowTrend          → "Cashflow Trend"
export.section.categoryBreakdown      → "Category Breakdown"
export.section.topRecipients          → "Top Recipients"
export.section.bankBalances           → "Bank Balances"
export.section.rollingAverages        → "Rolling Averages"
export.section.plannedOutlook         → "Planned Outlook"
export.section.portfolioAllocation    → "Portfolio Allocation"
export.section.topHoldings            → "Top Holdings"
export.section.taxBreakdown           → "Tax Breakdown"
export.currency                       → "Currency"
export.download                       → "Download PDF"
export.downloading                    → "Generating…"
export.openDialog                     → "Export PDF"
export.comingSoon                     → "This report type is not yet available — a placeholder PDF will be generated."
```

---

## Feature Overview

The PDF report system is a three-layer architecture:

1. **Report dispatcher** — `apps/node-backend/src/services/reports/index.js` — routes by report type, assembles cover + content, invokes Puppeteer renderer
2. **Modular sections** — `apps/node-backend/src/services/reports/sections/` — seven financial section renderers (executiveSummary, cashflowTrend, categoryBreakdown, topRecipients, bankBalances, plannedOutlook, rollingAverages)
3. **Data fetcher** — `apps/node-backend/src/services/reports/dataFetcher.js` — parallel Promise.allSettled loads all data sources; graceful degradation if any fails
4. **Theme integration** — `apps/node-backend/src/services/reports/themeCss.js` + `sectionHelpers.js` — CSS custom properties, shared formatting utilities (currency, date, percentages), SVG chart builders

The PDF contains:

- **Cover page**: Report title, period, currency, generation timestamp, confidentiality footer
- **Executive Summary**: KPI grid (total income/expenses/net/count) + per-month table (most recent first, up to 24 months)
- **Cashflow Trend**: Grouped bar chart (income vs expenses per month) + monthly table
- **Category Breakdown**: Horizontal bar chart of top categories + ranked detail table
- **Top Recipients**: Horizontal bar chart of top merchants + month-over-month change alerts
- **Bank Balances**: Account balance cards (2-column grid) + net position summary
- **Planned Outlook**: Next-month planned transactions grouped by date
- **Rolling Averages**: 6-month rolling average vs current month pace

## Endpoints

### POST /api/reports/financial

Generate a theme-aware financial PDF report with Puppeteer rendering.

**Request Body (JSON):**

```json
{
  "currency": "EUR",
  "period": { "kind": "rolling", "months": 12 },
  "sections": ["executiveSummary", "cashflowTrend", "categoryBreakdown", "topRecipients", "bankBalances", "rollingAverages", "plannedOutlook"],
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

**Period Options:**

- `{ "kind": "ytd" }` — Year to date
- `{ "kind": "rolling", "months": N }` — Last N months (1–60)
- `{ "kind": "custom", "from": "2025-01-01", "to": "2025-12-31" }` — Date range
- `{ "kind": "year", "year": 2025 }` — Calendar year

**Sections:**

- `executiveSummary` — KPI grid + per-month table
- `cashflowTrend` — Grouped bar chart + monthly table
- `categoryBreakdown` — Horizontal bar chart + category table
- `topRecipients` — Top merchants + MoM alerts
- `bankBalances` — Account cards + net position
- `plannedOutlook` — Next-month planned transactions
- `rollingAverages` — 6-month rolling vs current

Omit `sections` or pass empty array to use `DEFAULT_FINANCIAL_SECTIONS` (all except plannedOutlook by default).

**Response:**

- **Content-Type**: `application/pdf`
- **Headers**: `Content-Disposition: attachment; filename="vision-financial-{YYYY-MM-DD}.pdf"`
- **Body**: Binary PDF stream

**Error Response (400):**

```json
{
  "error": "Invalid report request: currency: currency must be a 3-letter ISO code"
}
```

### POST /api/reports/portfolio

Generate a portfolio PDF report with 6 data-backed sections. Accepts the same base body as `/api/reports/financial`. `excludedCategoryIds` and `excludedRecipientIds` are accepted but no-op (portfolio data has no category/recipient join).

**Available Sections:** `portfolioExecutiveSummary`, `portfolioAllocation`, `topHoldings`, `performanceTrend`, `assetClassDetail`, `dividendIncome`

### POST /api/reports/tax

Generate a tax PDF report with 7 data-backed sections. Extends the base schema with optional `taxProfile` and `precomputedPIT` fields forwarded from the Belgian tax context in the frontend.

**Available Sections:** `taxExecutiveSummary`, `taxTypeBreakdown`, `taxByAssetClass`, `taxMonthlyTrend`, `topInvestmentsByCost`, `feeBreakdown`, `belgianRulesSummary`

**Additional Request Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `taxProfile` | object (optional) | `{ filingStatus?, region?, taxYear? }` — Belgian tax profile; echoed into `belgianRulesSummary` |
| `precomputedPIT` | object (optional) | `{ taxableIncome?, totalTax?, brackets?: { label?, rate?, taxableIncome?, taxAmount? }[] }` — PIT calculation from frontend; rendered as bracket table in `belgianRulesSummary` |

When `taxProfile` is omitted, the `belgianRulesSummary` section renders only the static bracket tables without a PIT block.

### GET /api/reports/financial (Legacy)

Kept for backward compatibility; uses legacy PDFKit renderer. Redirects to POST with default parameters.

## Backend Architecture

### Phase 5: Puppeteer Footer Template

The `generateReport()` function now:

1. Calls `buildFooterTemplate(theme)` to generate Puppeteer footer HTML with theme colors
2. Passes footer template and bottom margin (28px) to `renderHtmlToPdf()`
3. The footer appears on all content pages (not on cover)

**Function signature:**

```javascript
renderHtmlToPdf(html, {
  footerTemplate?: string;
  headerTemplate?: string;
  margin?: { top, right, bottom, left };
})
```

**Example usage:**

```javascript
const footerTemplate = buildFooterTemplate(theme);
const pdf = await renderHtmlToPdf(html, {
  footerTemplate,
  margin: { top: '0', right: '0', bottom: '28px', left: '0' },
});
```

### Phase 3: Puppeteer Rendering + Modular Sections

**Rendering Pipeline:**

1. **Dispatcher** (`apps/node-backend/src/services/reports/index.js`)
   - Validates report type + period + sections
   - Builds HTML document from theme tokens + CSS + body sections
   - Invokes Puppeteer renderer → PDF buffer
   - Streams to HTTP response

2. **Data Fetcher** (`apps/node-backend/src/services/reports/dataFetcher.js`)
   - Parallel `Promise.allSettled` loads all data in parallel
   - Gracefully handles failures (returns null for failed sources)
   - Wraps aggregation results + repository data
   - Exports `filterMonthsByPeriod()` utility for section renderers

3. **Section Renderers** (`apps/node-backend/src/services/reports/sections/`)
   - Each renderer is a pure function: `(data, { currency, period }) → HTML string`
   - All renderers imported in dispatcher's `FINANCIAL_SECTION_RENDERERS` map
   - Default sections list: all except plannedOutlook (customizable)
   - Each section uses shared helpers (formatters, SVG chart builders)

4. **Theme System** (`apps/node-backend/src/services/reports/themeCss.js` + `sectionHelpers.js`)
   - CSS custom properties (HSL) resolved from frontend theme tokens
   - Built-in CSS classes: `.kpi-grid`, `.data-table`, `.account-grid`, etc.
   - Shared formatters: `fmtCurrency()`, `fmtDate()`, `fmtPct()`, `fmtMonthLabel()`
   - SVG chart builders: `svgGroupedBarChart()`, `svgHorizontalBars()`

5. **Puppeteer Renderer** (`apps/node-backend/src/services/reports/puppeteerRenderer.js`)
   - `renderHtmlToPdf(html, opts)` → Promise<Buffer>
   - Accepts optional `opts.footerTemplate`, `opts.headerTemplate`, `opts.margin` (Phase 5)
   - Uses Puppeteer headless Chrome with print-to-PDF
   - Singleton browser instance for efficiency

### Report Types

| Type | Status | Sections |
|------|--------|----------|
| `financial` | Implemented (Phase 3) | 7 renderers complete |
| `portfolio` | Implemented (Phase 8) | 6 renderers (executive summary, allocation, top holdings, performance trend, asset class detail, dividend income) |
| `tax` | Implemented (Phase 8) | 7 renderers (executive summary, type breakdown, by asset class, monthly trend, top investments by cost, fee breakdown, Belgian rules summary) |

### Default Section Order

```javascript
const DEFAULT_FINANCIAL_SECTIONS = [
  'executiveSummary',       // KPI + per-month table
  'cashflowTrend',          // Grouped bars + data
  'categoryBreakdown',      // Horizontal bars + table
  'topRecipients',          // Top merchants + MoM
  'bankBalances',           // Account cards + summary
  'rollingAverages',        // 6-month trend
  'plannedOutlook',         // Next month planned
];
```

### Period Filtering

`filterMonthsByPeriod(months, period)` utility:

- **ytd**: Current calendar year only
- **rolling**: Last N months (e.g., rolling 12 = last 12 months)
- **custom**: Date range (from ≤ month end, to ≥ month start)
- **year**: Specific year (e.g., year: 2025)

## Frontend Implementation

### API Client

**Location:** `apps/frontend/src/lib/api/reports.ts`

The frontend client assembles the POST request with:
- Selected currency
- Report type and period
- Section selections (or empty for defaults)
- Current theme tokens (HSL values)

Example:

```typescript
const response = await fetch(`${API_BASE}/reports/financial`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currency: 'EUR',
    period: { kind: 'rolling', months: 12 },
    sections: [], // Empty = use defaults
    theme: {
      primary: '250 84% 60%',
      surface: '0 0% 98%',
      text: '0 0% 18%',
      // ... other tokens
    }
  })
});

const blob = await response.blob();
// Trigger download...
```

### Theme Integration

The report preview or export dialog passes the app's current theme tokens to the POST body, ensuring the PDF matches the user's selected theme (light/dark mode + color palette).

### Usage Notes

- **Theme tokens** must be HSL strings (e.g., `"250 84% 60%"`) matching CSS custom property values
- **Sections** can be omitted or empty to use the default set
- **Period** defaults to `{ kind: 'rolling', months: 12 }` if not provided
- **Currency** must be a valid 3-letter ISO code (e.g., EUR, USD, GBP)

## Layout and Styling

### Cover Page

- **Format**: A4 portrait (210 × 297 mm) minus footer height (28px)
- **Calculated height**: `calc(297mm - var(--footer-h))`
- **Header band**: 8px accent color stripe
- **Title**: 40px, bold, report type name
- **Metadata**: Period, currency, generation date
- **Footer**: Brand + confidentiality notice

### Content Pages

- **Margins**: 40px padding (52px in original units) + 28px bottom margin for Puppeteer footer
- **Page border**: 4px solid primary-color top border (visual separation)
- **Section break**: Always new page per section
- **Typography**: System fonts (Apple System, Segoe UI)
- **Print colors**: Exact color reproduction enabled
- **Section titles/subtitles**: `break-after: avoid` prevents orphaning from content

### Page Break Control (Phase 5)

CSS `break-inside: avoid` prevents orphaning of cards and rows across page boundaries:

| Element | CSS Property | Purpose |
|---------|--------------|---------|
| `.kpi-card` | `break-inside: avoid` | Prevents KPI card split across pages |
| `.account-card` | `break-inside: avoid` | Keeps account balance cards intact |
| `.stat-row` | `break-inside: avoid` | Keeps individual stat rows together |
| `.planned-day` | `break-inside: avoid` | Keeps planned transaction day groups intact |
| `.data-table thead` | `display: table-header-group` | Repeats table headers on every page (CSS fallback for `thead` visibility) |

### Styling System

All sections inherit:

- **Color tokens**: Primary, accent, success, expense, surface, text, muted, border (8 chart colors)
- **Light/dark modes**: CSS class `dark` on root; theme colors adjust per mode
- **Chart colors**: Automated cycling through 8 distinct palette colors
- **Responsive sizing**: A4-fixed width; text scales for readability
- **Footer spacing**: CSS variable `--footer-h: 28px` reserves bottom margin space for Puppeteer footer

### Print CSS Enhancements (Phase 5 & Phase 7)

**Base CSS** (`apps/node-backend/src/services/reports/index.js`):
- `html { background: hsl(var(--surface)); -webkit-print-color-adjust: exact; print-color-adjust: exact; }` — Ensures surface color fills the entire page canvas including `@page` margin boxes, eliminating the white bar above the Puppeteer footer (Phase 5 fix).
- `@page { margin: 0 0 28px 0; }` — Fixed CSS page rule to align Chrome layout engine with Puppeteer physical 28px footer margin, reserving explicit space for footer without content overflow.
- `.cover` height: `calc(297mm - var(--footer-h))` reserves footer space on cover
- `.page` top border: `4px solid hsl(var(--primary))` for visual page separation
- `.page-continuation` — New class for logical continuation pages: `padding: 32px 52px 56px; border-top: none; page-break-before: always;` used for tables following charts to ensure tables always start at the top of a fresh page
- `.section-title` and `.section-subtitle`: `break-after: avoid` prevents orphaning section headers from their content

**Section CSS module** (`apps/node-backend/src/services/reports/sectionHelpers.js`):

```css
/* Print break control — prevent orphaning across pages */
.kpi-card     { break-inside: avoid; }
.account-card { break-inside: avoid; }
.stat-row     { break-inside: avoid; }
.planned-day  { break-inside: avoid; }

/* Table pagination across pages */
.data-table thead { display: table-header-group; }           /* Repeat headers on overflow pages */
.data-table tr { break-inside: avoid; page-break-inside: avoid; }  /* Dual fallback: CSS and legacy */
.data-table td { word-break: break-word; }                    /* Wrap text instead of overflow */
.data-table td:nth-child(2) { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Dual-chart comparison pair (Phase 7) */
.chart-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; break-inside: avoid; page-break-inside: avoid; }
.chart-pair-label { break-after: avoid; page-break-after: avoid; }
```

These rules ensure:
- Cards and rows stay on the same page (no orphaning)
- Tables repeat their header on every page when content overflows
- Dual charts remain side-by-side across page boundaries (no orphaning of chart pairs)
- Text readability is maintained across page boundaries
- Long category/recipient names truncate cleanly without breaking layout
- Footer space is properly reserved and does not overlap with table content

### SVG Charts

- **Grouped bar chart** (`svgGroupedBarChart`): Income (green) vs Spending (red) side-by-side; labels auto-thinned for large datasets
- **Horizontal bar chart** (`svgHorizontalBars`): Top items ranked; auto-truncates labels; values right-aligned

## Data Sources

The report fetches all data in parallel via `fetchFinancialData()`:

| Component | Source |
|-----------|--------|
| Executive Summary | `computeMonthlySummary()` → per-month totals |
| Cashflow Trend | Same as above |
| Categories | `computeCategoryBreakdown()` → top category breakdown |
| Recipients | `computeRecipientInsights()` → top merchants + MoM |
| Bank Balances | `computeBankBalances()` → account balances |
| Rolling Averages | `computeAverageVsCurrent()` → 6-month rolling trend |
| Planned Outlook | `infoRepository.getPlannedExpensesNextMonth()` → next-month transactions |

## Performance

- **Parallel loading**: All 7 data sources fetched concurrently via Promise.allSettled
- **Graceful degradation**: Any failed source logs warning; report continues with remaining data
- **Puppeteer rendering**: Chrome headless print-to-PDF (memory-efficient)
- **No streaming chunking**: Entire PDF buffered; suitable for typical reports (< 20 pages)

## Section Details

### Executive Summary

- **KPI Grid**: Income, Expenses, Net Position, Transaction Count (4 cards)
- **Averages Grid**: Avg Monthly Income, Avg Monthly Expenses, Avg Monthly Net (3 cards)
- **Monthly Table**: Up to 24 months (most recent first); columns: Month, Income, Expenses, Net, Count

### Cashflow Trend

- **Chart**: Grouped bar (income green, spending red) per month
- **Data Table**: Same as executive summary table
- **Auto-scale**: Handles 1–60+ months; labels thinned if > 12 months

### Category Breakdown

- **Chart**: Horizontal bars showing top N categories
  - **Single chart (no filters)**: Standard layout showing top 10 categories (rendered on `.page.page-break`)
  - **Dual-chart comparison (with exclusions)**: Side-by-side charts labeled "With active filters" and "All data" for impact visibility (rendered on `.page.page-break`)
- **Table section** (rendered on `.page-continuation` — forced page break):
  - **Filter notice** (when exclusions active): Banner showing filtered row count and excluded count, with reference to "All data" chart
  - **Table**: Ranked categories; shows only filtered rows when exclusions active
  - **Max rows**: Top 10 in chart, top 20 in table
- **Benefit**: Charts and table are logically separated across page boundaries, ensuring tables always start at the top of a fresh physical page without row overflow into footer zone

### Top Recipients

- **Chart**: Horizontal bars of top merchants/recipients
  - **Single chart (no filters)**: Standard layout showing top 10 recipients (rendered on `.page.page-break`)
  - **Dual-chart comparison (with exclusions)**: Side-by-side charts labeled "With active filters" and "All data" for impact visibility (rendered on `.page.page-break`)
- **Table section** (rendered on `.page-continuation` — forced page break):
  - **Filter notice** (when exclusions active): Banner showing filtered row count and excluded count, with reference to "All data" chart
  - **Table**: Ranked recipients with spend, transaction count, average; shows only filtered rows when exclusions active
  - **Month-over-month alerts**: Optional sub-section showing spending deltas (↑ increase, ↓ decrease); renders below main table
  - **Max rows**: Top 10 in chart, top 15 in table
- **Benefit**: Charts and tables are logically separated across page boundaries, ensuring tables always start at the top of a fresh physical page without row overflow into footer zone

### Bank Balances

- **Cards**: 2-column grid of account balances (name, current balance, last updated)
- **Summary**: Net position across all accounts

### Planned Outlook

- **Grouping**: Next-month planned transactions grouped by date
- **Format**: Date header + list of transactions with category and amount
- **Empty state**: Shows if no planned transactions for next month

### Rolling Averages

- **Data**: 6-month rolling average vs current month YTD pace
- **Comparison**: Variance % (↑ if pace exceeds rolling avg, ↓ if below)

## Related Features

- [[docs/features/statistics|Statistics Feature]] — Primary host page for export dialog
- [[docs/features/belgian-tax|Tax Overview]] — Uses ExportDialog with tax reports
- [[docs/features/portfolio|Portfolio Feature]] — Stocks page uses ExportDialog for portfolio reports
- [[docs/features/transactions|Transactions]] — Underlying transaction data for financial reports

## Architecture Patterns

- **Modular sections**: Add new report section by creating a renderer in `sections/`, exporting it, and adding to `FINANCIAL_SECTION_RENDERERS` map
- **Data separation**: Section renderers are pure functions; all state fetched once in `dataFetcher.js`
- **Period filtering**: `filterMonthsByPeriod()` is reusable utility; applies to any months array
- **Graceful degradation**: Promise.allSettled ensures one data source failure doesn't crash entire report

## Related

- [[docs/api/index|API Documentation]]
- [[docs/features/statistics|Statistics Feature]]
- [[docs/api/reports|Reports API]]
