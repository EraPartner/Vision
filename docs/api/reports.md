---
title: Reports API
type: endpoint
status: active
date: 2026-10-28
updated: 2026-10-28
tags:
  - api
  - reports
  - pdf
  - export
  - phase-3
  - phase-5
  - phase-6
  - phase-7
  - electron-print
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
description: Report endpoints that build print-ready, theme-aware report documents from modular sections; the Electron shell prints them to PDF with its own Chromium (ADR-234). Phase 5 adds paginated footers, white-bar fix, and table-overflow fix. Phase 6 adds i18n. Phase 7 adds filter exclusions with dual-chart comparison. Phase 8 implements full portfolio (6 sections) and tax (7 sections) reports with real data fetchers; tax endpoint accepts optional taxProfile and precomputedPIT for Belgian tax rules. The three POST endpoints (financial, portfolio, tax) return a ReportDocument envelope; legacy GET was removed in ADR-038.
aliases:
  - reports
  - pdf export
  - financial report
  - report download
related_code:
  - apps/node-backend/src/services/reports/index.ts
  - apps/node-backend/src/services/reports/sectionHelpers.ts
  - apps/node-backend/src/services/reports/dataFetcher.ts
  - apps/node-backend/src/services/reports/sections/
  - apps/node-backend/src/routes/reports.ts
  - apps/frontend/src/lib/api/reports.ts
  - packaging/electron/report-pdf.ts
  - packages/types/src/contracts/reports.ts
  - apps/frontend/src/lib/themeTokens.ts
---

# Reports API

The backend builds a **print-ready report document**; it renders no PDF and bundles no browser
([[docs/adr/234-electron-report-pdf-printing|ADR-234]]). Successful responses use the standard
[[docs/adr/026-unified-api-response-envelope|ADR-026 JSON envelope]] with a `ReportDocument`:

```json
{
  "ok": true,
  "data": {
    "filename": "vision-financial-2026-10-20.pdf",
    "html": "<!DOCTYPE html>…",
    "footerTemplate": "<style>…</style><div>…<span class=\"pageNumber\"></span>…</div>"
  }
}
```

`html` is a complete A4 document with inline styles and no scripts. `footerTemplate` is the
Chromium print footer ("Vision | Confidential | page X / Y") for the reserved 28px bottom margin.
The Electron shell prints the document through the `report:print-pdf` invoke channel and the
browser downloads the PDF. In a plain browser (no Electron bridge) the frontend opens the browser
print dialog on the document; the user saves it as PDF there, without the page-number footer.

> [!warning] Breaking change (2026-10-20)
> Until ADR-234 these routes returned raw `application/pdf` bytes with `Content-Disposition` and
> `Content-Length`, rendered by a bundled Chrome Headless Shell through Puppeteer. Clients that
> expected PDF bytes must print the returned document instead. Request bodies are unchanged.

**Key Features:**

- **Modular sections**: 7 financial section renderers (executive summary, cashflow, categories, recipients, bank balances, rolling averages, planned outlook)
- **Theme-aware styling**: CSS custom properties (HSL) from frontend theme tokens
- **Period filtering**: YTD, rolling N months, custom date range, or specific year
- **Paginated footers** (Phase 5): "Vision | Confidential | page X / Y" on all content pages; theme colors interpolated as HSL literals
- **Enhanced print breaks** (Phase 5): `break-inside: avoid` prevents card/row orphaning; `display: table-header-group` repeats table headers across pages
- **Full i18n support** (Phase 6): 32 translation keys for dialog UI, period labels, section toggles, and actions (en/nl)
- **Source failures**: Any requested source failure aborts export; successful empty results remain distinct from unavailable data (see [[#Performance]])
- **Three report types**: Financial (complete), Portfolio (Phase 8 — 6 sections), Tax (Phase 8 — 7 sections + Belgian tax pass-through)

## Phase Updates

### Phase 8 — Portfolio & Tax Report Implementation (2026-04-27)

- **Portfolio report**: 6 data-backed sections replacing "Coming soon" stub. New `dataFetcherPortfolio.ts` fetches portfolio snapshots, investment summaries, dividends, and asset-class aggregations in parallel. New `svgLineChart` helper added to `sectionHelpers.ts` for performance trend overlay (value vs invested vs inflation-adjusted).
- **Tax report**: 7 data-backed sections replacing "Coming soon" stub. New `dataFetcherTax.ts` aggregates `portfolio_transactions` filtered to tax-year window, producing `totals`, `byMonth`, `byAssetClass`, and `byInvestment` payloads.
- **Belgian tax pass-through**: `/api/reports/tax` now accepts optional `taxProfile` (`filingStatus`, `region`, `taxYear`) and `precomputedPIT` (`taxableIncome`, `totalTax`, `brackets[]`) in the POST body. `belgianTaxTables.ts` provides static bracket/rate data; no server-side PIT computation.
- **`svgGenericGroupedBarChart`**: New flexible chart helper in `sectionHelpers.ts` accepting configurable `seriesDefs: { key, color, label }[]`; used by tax and portfolio section renderers.
- **ExportDialog**: Removed `isImplemented` guard and "coming soon" notice. All 3 report types are now fully operational. Portfolio section list expanded from 2 → 6 entries; tax from 1 → 7 entries. Tax download resolves `taxProfile` + `precomputedPIT` from `BelgianTaxProfileContext` before sending.
- **PortfolioOverviewPage**: `<ExportDialog defaultType="portfolio" />` added to PageHeader actions.
- **i18n**: 11 new `export.section.*` keys added to all 6 locale files (`en.ts`, `nl.ts`, `i18n/source/en.json`, `i18n/source/nl.json`, `packaging/electron/i18n/en.json`, `packaging/electron/i18n/nl.json`).

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
  - Sections: `export.sections`, `export.section.{7 financial + 6 portfolio + 7 tax}` (Phase 8 complete, no placeholders)
  - Actions: `export.{currency,download,downloading,comingSoon}`
- **Generated Artifacts**: Keys regenerated into `apps/frontend/src/locales/en.ts` and `nl.ts` via build system
- **Validation**: All keys pass parity checks, placeholder consistency, type safety, and drift detection

## Rate Limiting

All `/api/reports/*` endpoints are subject to a 30 req/min route-group limiter (`reportRateLimiter`; bypassed in development). Every POST runs report aggregation queries and builds a full HTML document, so the limit keeps one client from monopolising the database. See [[docs/security/rate-limiting|Rate Limiting]] for details.

## CSS Injection Hardening (2026-05-29)

Report theme tokens (e.g. `primary`, `surface`, `text`) are passed from the frontend as HSL component strings and interpolated verbatim into a `:root {}` CSS block that Chromium prints. An unconstrained string at this point is a CSS injection / `url()` exfiltration vector. The Electron print window also blocks all network access and serves the document with `default-src 'none'`.

**Current protection (defense-in-depth):**

1. **Route boundary (Zod):** Each theme token field is validated against `HSL_COMPONENT_RE` before the request body is accepted:

   ```
   ^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$
   ```

   Example of a valid value: `"250 84% 60%"` (hue degrees, saturation %, lightness %).

2. **Sink-level guard (`themeCss.ts`):** The same regex is re-applied in `buildThemeCss()` before interpolation. Invalid tokens silently fall back to the mode default (light or dark) rather than propagating the raw value. The fallback palette comes from `@vision/types/reportThemeDefaults`, which is also used by the frontend's default theme. This keeps a partial or rejected report palette aligned with the application's default light and dark palettes.

Both guards are exported (`HSL_COMPONENT_RE`) and covered by [[apps/node-backend/tests/themeCss.test.ts]].

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
  "sections": [
    "executiveSummary",
    "cashflowTrend",
    "categoryBreakdown",
    "topRecipients",
    "bankBalances",
    "rollingAverages"
  ],
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

| Field                  | Type          | Default                           | Description                                                                                                                                   |
| ---------------------- | ------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency`             | string        | `EUR`                             | 3-letter ISO currency code (e.g., EUR, USD, GBP)                                                                                              |
| `period`               | object        | `{ kind: "rolling", months: 12 }` | Period descriptor (see Period Options below)                                                                                                  |
| `sections`             | array         | `[]` (uses defaults)              | List of section IDs to include; empty = default sections                                                                                      |
| `theme`                | object        | `{ mode: "light" }`                              | Theme tokens (HSL values); omit to use defaults                                                                                               |
| `excludedCategoryIds`  | integer array | `[]`                              | Category IDs to exclude from filtered view; each ID must be in PostgreSQL `int4` range 1..2,147,483,647 (generates filter impact comparison)  |
| `excludedRecipientIds` | integer array | `[]`                              | Recipient IDs to exclude from filtered view; each ID must be in PostgreSQL `int4` range 1..2,147,483,647 (generates filter impact comparison) |

**Validation and defaults**

An empty JSON object is valid and receives the defaults above. An omitted body is invalid. Currency
must match `^[A-Z]{3}$`; this checks the uppercase shape, not membership in an ISO currency registry.
All fields are optional, but `null` is rejected. Unknown top-level and known nested-object fields
are stripped. `start_date`, `end_date`, and top-level `year` are ignored; use `period`.
Theme colors must match the source HSL component shape (for example `158 62% 32%`), without
`hsl()` wrappers or CSS declarations; the route does not impose additional numeric bounds.
Section IDs are strings; the route does not enforce an enum. Tax-context fields are validated
by all three routes, but only the tax route forwards them to rendering.

**Period Options**

- `{ "kind": "ytd" }` — Current calendar year (January 1 to today)
- `{ "kind": "rolling", "months": N }` — Last N months (N = 1 to 60)
- `{ "kind": "custom", "from": "2025-01-01", "to": "2025-12-31" }` — Date range; the route checks `YYYY-MM-DD` shape, not calendar validity or ordering
- `{ "kind": "year", "year": 2025 }` — Integer calendar year from 2000 through 2100

**Available Sections**

| Section ID          | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `executiveSummary`  | KPI grid + per-month table                                |
| `cashflowTrend`     | Grouped bar chart (income vs expenses) + data table       |
| `categoryBreakdown` | Horizontal bars of top categories + ranked table          |
| `topRecipients`     | Top merchants/recipients + month-over-month change badges |
| `bankBalances`      | Account balance cards + net position summary              |
| `rollingAverages`   | 6-month rolling average vs current month pace             |
| `plannedOutlook`    | Next-month planned transactions grouped by date           |

**Default Sections (when `sections` is omitted or empty)**

All sections except `plannedOutlook`.

**Response body:** `{ "ok": true, "data": ReportDocument }` with `filename`
`vision-financial-YYYY-MM-DD.pdf`, the script-free A4 portrait `html` document and its
`footerTemplate`. The Electron shell prints it to PDF.

**Error Response (400)**

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid report request: currency: currency must be a 3-letter ISO code"
  }
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
const response = await fetch("/api/reports/financial", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    currency: "EUR",
    period: { kind: "rolling", months: 12 },
    sections: [],
    theme: {/* theme tokens */},
    excludedCategoryIds: [5, 7], // Exclude Travel, Subscriptions
    excludedRecipientIds: [12, 18], // Exclude Amazon, Netflix
  }),
});

const { data } = await response.json();
// data.html is printed to PDF by window.electronReports.printToPdf in the desktop app
```

### POST /api/reports/portfolio

Generate a portfolio PDF report with 6 data-backed sections (Phase 8).

**Request body:** Same schema as `/api/reports/financial`. `excludedCategoryIds` and `excludedRecipientIds` are accepted but are no-op (portfolio data has no category/recipient join).

**Available Sections:**

| Section ID                  | Description                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `portfolioExecutiveSummary` | KPI grid: total value, invested, unrealised P/L, realised P/L, dividends YTD, return %  |
| `portfolioAllocation`       | Asset-class breakdown (stocks/ETFs, crypto, metals, cash) via horizontal bars + table   |
| `topHoldings`               | Top 10 holdings by current value                                                        |
| `performanceTrend`          | Line chart overlaying portfolio value vs invested + inflation-adjusted; per-month table |
| `assetClassDetail`          | Grouped bar chart (invested vs value) per asset class + P/L summary                     |
| `dividendIncome`            | Monthly dividend bar chart + top dividend-paying investments                            |

### POST /api/reports/tax

Generate a tax PDF report with 7 data-backed sections (Phase 8).

**Request body:** Extends the base schema with four optional fields (`taxProfile`, `precomputedPIT`, and since 2026-10-11 `household` and `precomputedHousehold`):

```json
{
  "currency": "EUR",
  "period": { "kind": "year", "year": 2024 },
  "sections": [],
  "theme": { "mode": "light" },
  "taxProfile": {
    "filingStatus": "employed",
    "region": "belgium",
    "taxYear": 2024
  },
  "precomputedPIT": {
    "taxableIncome": 45000,
    "totalTax": 12300,
    "brackets": [
      {
        "label": "25%",
        "rate": 25,
        "taxableIncome": 15200,
        "taxAmount": 3800
      }
    ]
  }
}
```

| Field            | Type              | Description                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taxProfile`     | object (optional) | `{ filingStatus?, region?, taxYear? }` — Belgian filing context; echoed into `belgianRulesSummary`                                                                                                                                                                                                                                                                            |
| `household`      | object (optional) | The year's Belgian tax household (2026-10-11, additive), validated by `belgianTaxHouseholdV2Schema` (`routes/belgianTaxSettingsSchemas.ts`); only partner display names are rendered                                                                                                                                                                                         |
| `precomputedHousehold` | object (optional) | `{ assessmentMode, legalBasis?, quotient?, partners[] }` (2026-10-11, additive) — per-partner `grossIncome`, `taxableIncome`, `totalPIT` from the frontend household engine; partner ids must be unique (400 otherwise). With two partners, `belgianRulesSummary` adds a Per Partner table with the household total, the assessment and the marital quotient; with one partner nothing changes                         |
| `precomputedPIT` | object (optional) | `{ taxableIncome?, totalTax?, brackets? }` — PIT calculation from the frontend Belgian tax engine; rendered as a bracket table in `belgianRulesSummary`. If omitted, the section renders only the static bracket/rate tables. **`brackets[].rate` is in PERCENT units** (`25` = 25%), unlike the server-side `belgianTaxTables.ts` rates, which are fractions (`0.30` = 30%). |

**Available Sections:**

| Section ID             | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `taxExecutiveSummary`  | KPI grid: total taxes paid, fees, net cost, dividend WHT, TOB, effective rate              |
| `taxTypeBreakdown`     | Horizontal bars of tax components (TOB, dividend WHT, sell tax, fees, other)               |
| `taxByAssetClass`      | Grouped bar chart (taxes vs fees) per asset class                                          |
| `taxMonthlyTrend`      | Monthly grouped bars (taxes and fees)                                                      |
| `topInvestmentsByCost` | Top 15 investments ranked by total taxes + fees                                            |
| `feeBreakdown`         | Fee aggregation by asset class                                                             |
| `belgianRulesSummary`  | Static bracket/exemption/TOB-rate tables; PIT summary block when `precomputedPIT` supplied |

**Period and tax-year normalisation:**

- `kind: 'year'` → that calendar year
- `kind: 'ytd'` → current calendar year
- `kind: 'rolling'` → current calendar year (note on cover)
- `kind: 'custom'` → respects date range; bracket lookup uses year of `period.from`

### Removed legacy endpoint

The former `GET /api/reports/financial` PDFKit endpoint was removed in [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038]]. It is not an available fallback. Use one of the three POST endpoints above.

## Frontend Usage

```typescript
import { downloadFinancialReport } from "@/lib/api/reports";

// Simple download with defaults
await downloadFinancialReport();

// Custom options
await downloadFinancialReport({
  currency: "USD",
  period: { kind: "ytd" },
  sections: ["executiveSummary", "cashflowTrend", "categoryBreakdown"],
  theme: {/* custom theme tokens */},
});
```

The frontend helper:

1. Resolves active theme tokens from DOM CSS custom properties
2. Assembles POST body with user selections
3. Reads the envelope and checks it against `ReportDocumentSchema` (`@vision/types/contracts`)
4. In Electron, calls `window.electronReports.printToPdf({ html, footerTemplate })` and downloads
   the returned PDF bytes as `filename`; it resolves `"downloaded"`
5. In a plain browser, prints the document from a hidden `srcdoc` frame (the browser print dialog)
   and resolves `"print-dialog"`; the export dialog then skips its "Report downloaded" toast

It uses `fetch` directly rather than `apiRequest`, so no short client timeout is added to a
queued report.

## Implementation Notes

### Architecture

- **Dispatcher** (`apps/node-backend/src/services/reports/index.ts`): Routes by report type, builds the HTML document and footer template
- **HTTP route** (`apps/node-backend/src/routes/reports.ts`): Receives `{ filename, html, footerTemplate }` from the dispatcher and sends it with `res.ok`
- **Data fetcher** (`apps/node-backend/src/services/reports/dataFetcher.ts`): Parallel Promise.allSettled loads selected sources; requested source failures reject the export
- **Section renderers** (`apps/node-backend/src/services/reports/sections/`): Pure functions; each section independent
- **Theme system** (`themeCss.ts` + `sectionHelpers.ts`): CSS tokens, formatters, SVG chart builders
- **Electron printer** (`packaging/electron/report-pdf.ts`): Hidden, sandboxed, script-free window on an in-memory session → `webContents.printToPDF` (A4, backgrounds, 28px footer margin); one print at a time with a 60 s timeout

### Data Sources

All fetched in parallel via Promise.allSettled:

- `computeMonthlySummary()` — per-month totals
- `computeCategoryBreakdown()` — category spending
- `computeRecipientInsights()` — top merchants
- `computeBankBalances()` — account balances
- `computeAverageVsCurrent()` — rolling averages
- `infoRepository.getPlannedExpensesNextMonth()` — planned transactions

### Period, valuation and capacity contracts

Financial monthly, category and recipient totals apply inclusive start/end dates before aggregation,
including partial months in custom ranges. Both category and recipient exclusions apply in the
filtered category and recipient aggregates; the comparison chart retains an explicitly unfiltered
aggregate for the same dates. Category ancestry and primary-recipient identity follow the shared
filter builder. Account balances, rolling averages and planned outlook keep their labelled
current/rolling/future meaning.

The portfolio overview takes value, invested capital, gain/loss, return and inflation-adjusted
value from one selected historical snapshot when available, with its valuation date. Current
holdings remain a separately labelled table. Without a snapshot, current totals are used and
inflation-adjusted value is unavailable. Allocation-only exports skip snapshots and dividends.

A dividend or recorded tax whose currency has no stored exchange rate is left out of the report
figures, never added 1:1 (2026-10-19, [[docs/adr/216-server-owned-domain-calculations|ADR-216]]).
The Dividend Income section and the tax executive summary then show an "Incomplete" warning that
names the currencies and the number of transactions left out.

Annual client PIT is included only for an explicit calendar-year report whose `taxProfile.taxYear`
matches. The frontend requires that year to be the live profile year or have its own saved
snapshot, and uses the frozen display calculation when present. A missing historical profile is
never replaced by a relabelled live profile. Partial, rolling and YTD reports omit annual PIT. The
rules section explains why annual PIT is omitted. PIT and statutory Belgian amounts remain EUR even when
portfolio transaction totals use another report currency. This changes no tax-law calculation.

`reportConcurrency.ts` admits two active reports and up to eight waiting requests before database
fetches or HTML allocation. Further requests receive HTTP 503 with the standard error envelope;
clients can retry later. A disconnected queued request is removed. An active disconnected request
keeps its slot until its source work settles. Cancellation is checked before the document is
assembled; the route does not write a document or forward a cancellation error to a disconnected
response. There is no short client timeout added. PDF printing happens afterwards in the Electron
main process, which prints one report at a time.
See [[docs/adr/208-bounded-report-pipeline|ADR-208]].

### Performance

- **Parallel data loading**: Only sources needed by selected sections are fetched concurrently
- **Failure semantics**: Financial, portfolio and tax reports reject a failed requested source,
  including row-contract violations. Only deliberately skipped sources are null. Successful empty
  results remain empty: zero tax/dividend totals can describe no activity, but never a failed query.
  A failed snapshot request cannot fall back to current holdings.
- **Document buffering**: The entire report document is generated before the route sends it
- **Typical size**: 2–10 MB depending on transaction volume

### Dependencies

- **Electron `webContents.printToPDF`**: the desktop shell's own Chromium prints the document
  (ADR-234; Puppeteer and the bundled Chrome Headless Shell were removed)
- **Zod**: Schema validation for request body

### Shutdown Behavior

The backend holds no browser process; shutdown closes only its database pools.

## Related

- [[docs/api/index|API index]] — available operation groups
- [[docs/reference/api-endpoint-matrix|Endpoint matrix]] — operation inventory and contract correction
- [[docs/features/pdf-report-export|PDF Report Export feature doc]] — user-facing feature
- [[docs/adr/234-electron-report-pdf-printing|ADR-234]] — Electron prints report PDFs
- [[docs/api/aggregations|Aggregations API]] — source data endpoints
- [[docs/adr/026-unified-api-response-envelope|ADR-026]] — why this route does _not_ use the standard envelope
