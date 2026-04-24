---
title: ExportDialog Component
type: component
status: active
date: 2026-04-25
tags: [component, export, dialog, reports, pdf, phase-4, ui, configuration]
description: Unified PDF report export configuration dialog. Selects report type (financial/portfolio/tax), period (YTD/rolling/year/custom), sections, and currency before triggering backend PDF generation.
related_code:
  - apps/frontend/src/components/reports/ExportDialog.tsx
  - apps/frontend/src/lib/api/reports.ts
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/pages/TaxOverviewPage.tsx
  - apps/frontend/src/pages/portfolio/StocksPage.tsx
---

# ExportDialog Component

> [!abstract] Overview
> Reusable dialog component for configuring and downloading PDF reports across the Vision app. Supports three report types (financial, portfolio, tax), five period presets (YTD, rolling 3/12, year, custom), per-type section toggles, and currency selection.

## Location

**File:** `apps/frontend/src/components/reports/ExportDialog.tsx`

## Purpose

Provides a unified interface for end-users to configure PDF report parameters before triggering a server-side Puppeteer render. Deployed to three key pages:

- **Statistics Page** — Financial reports (default)
- **Tax Overview Page** — Tax reports
- **Stocks Page** — Portfolio reports

## Props

```typescript
interface ExportDialogProps {
  /**
   * Custom trigger element (optional).
   * If not provided, renders a default "Export PDF" button.
   */
  trigger?: React.ReactNode;

  /**
   * Pre-selected report type when the dialog opens.
   * Defaults to 'financial'.
   * Override with 'portfolio' or 'tax' for contextual pages.
   */
  defaultType?: 'financial' | 'portfolio' | 'tax';
}
```

## Usage Examples

### Default (Financial Report)

```typescript
<ExportDialog />
```

Renders as an "Export PDF" button in the page header. Opens dialog with financial report pre-selected.

### Tax Report Context (TaxOverviewPage)

```typescript
<ExportDialog defaultType="tax" />
```

Pre-selects tax report type; user still configures period, sections, and currency.

### Portfolio Context with Custom Trigger (StocksPage)

```typescript
<ExportDialog
  defaultType="portfolio"
  trigger={
    <Button variant="secondary" size="sm">
      <Download className="h-4 w-4" />
      Download Report
    </Button>
  }
/>
```

## UI Structure

### Report Type Selection

Radio group with three options (financial, portfolio, tax):
- Styled as bordered cards with hover and active states
- Changes the available sections list when toggled
- "Coming soon" notice for unimplemented types (portfolio, tax)

### Period Preset Selection

Radio group with five presets:

| Preset | Backend Period | Label | UI Elements |
|--------|---|---|---|
| `ytd` | `{ kind: 'ytd' }` | Year to Date | None |
| `rolling3` | `{ kind: 'rolling', months: 3 }` | Last 3 Months | None |
| `rolling12` | `{ kind: 'rolling', months: 12 }` | Last 12 Months | None (default) |
| `year` | `{ kind: 'year', year: YYYY }` | Specific Year | Number input (min: 2000, max: current year + 1) |
| `custom` | `{ kind: 'custom', from, to }` | Custom Range | Two date inputs (from, to) |

**Defaults:**
- Period preset: `rolling12` (last 12 months)
- Custom year: current year
- Custom from: `YYYY-01-01` (last year, Jan 1)
- Custom to: today's date

### Sections Selection

- **Header checkbox** ("All") — toggle all sections at once
- **Individual checkboxes** — toggle each section independently
- **All sections default to enabled**

**Financial sections (7):**
1. Executive Summary
2. Cashflow Trend
3. Category Breakdown
4. Top Recipients
5. Bank Balances
6. Rolling Averages
7. Planned Outlook

**Portfolio sections (2, placeholder):**
1. Portfolio Allocation
2. Top Holdings

**Tax sections (1, placeholder):**
1. Tax Breakdown

### Section Behavior Contract

**Critical:** When all sections are selected, the component sends an **empty array** (`[]`) to the backend instead of listing all sections. This signals:

- "Use backend defaults" — ensures backward compatibility
- Backend retains control over default section ordering
- Aligns with the API contract in `[[docs/features/pdf-report-export|PDF Report Export]]`

```typescript
// Component logic
const selectedSections = allSectionsEnabled(sections, sectionDefs) ? [] : [...sections];
// Result: [] when all checked, ["ex", "cf", ...] when some are unchecked
```

### Currency Selection

Dropdown menu with 12 currencies:
- EUR (default in most regions)
- USD, GBP, CHF, JPY, CAD, AUD, SEK, NOK, DKK, PLN, CZK

Defaults to `appSettings.defaultCurrency` (from `AppSettingsContext`).

## State Management

Internal state (all `useState`):

| State | Type | Default |
|-------|------|---------|
| `open` | boolean | `false` |
| `reportType` | `'financial' \| 'portfolio' \| 'tax'` | `defaultType` prop (or `'financial'`) |
| `periodPreset` | `'ytd' \| 'rolling3' \| 'rolling12' \| 'year' \| 'custom'` | `'rolling12'` |
| `customYear` | string | Current year |
| `customFrom` | string | `YYYY-01-01` (last year) |
| `customTo` | string | Today (`YYYY-MM-DD`) |
| `sections` | `Set<string>` | All sections for selected type |
| `currency` | string | `appSettings.defaultCurrency` |
| `isSubmitting` | boolean | `false` |

## Form Submission

When the user clicks "Download PDF":

1. Validate sections (disabled if empty)
2. Build period object from `periodPreset` + custom values
3. Determine sections array:
   - If all enabled: send `[]` (use backend defaults)
   - If some disabled: send list of selected section IDs
4. Call appropriate download function:
   - `downloadFinancialReport(opts)` if financial
   - `downloadPortfolioReport(opts)` if portfolio
   - `downloadTaxReport(opts)` if tax
5. Show loading state while request is in flight
6. On success: Close dialog + toast "PDF downloaded"
7. On error: Toast with error message + stay open

## Loading and Error Handling

### Submitting State

```typescript
isSubmitting ? (
  <>
    <Loader2 className="h-4 w-4 animate-spin" />
    {t('export.downloading')} // "Generating…"
  </>
) : (
  <>
    <FileDown className="h-4 w-4" />
    {t('export.download')} // "Download PDF"
  </>
)
```

### Disabled Button Conditions

- `isSubmitting === true` — while PDF is rendering
- `sections.size === 0` — when no sections selected

### Success Toast

Uses `statsPage.report.downloadSuccess` i18n key:

```
"PDF report generated and downloaded."
```

Dialog closes automatically.

### Error Toast

Uses `statsPage.report.downloadError` key with error description:

```
toast.error(t('statsPage.report.downloadError'), {
  description: err instanceof Error ? err.message : String(err)
})
```

Dialog remains open; user can adjust settings and retry.

## Internationalization

All labels, descriptions, and button text are i18n-enabled via `useLanguage()` hook.

### i18n Keys (33 total)

**Dialog Header:**
- `export.title` → "Export PDF Report"
- `export.description` → "Configure your report before downloading."

**Report Type:**
- `export.reportType` → "Report Type"
- `export.reportType.financial` → "Financial"
- `export.reportType.portfolio` → "Portfolio"
- `export.reportType.tax` → "Tax"
- `export.comingSoon` → "This report type is not yet available — a placeholder PDF will be generated."

**Period:**
- `export.period` → "Period"
- `export.period.ytd` → "Year to Date"
- `export.period.rolling3` → "Last 3 Months"
- `export.period.rolling12` → "Last 12 Months"
- `export.period.year` → "Specific Year"
- `export.period.year.label` → "Year"
- `export.period.custom` → "Custom Range"
- `export.period.from` → "From"
- `export.period.to` → "To"

**Sections:**
- `export.sections` → "Sections"
- `export.sections.all` → "All"
- `export.section.executiveSummary` → "Executive Summary"
- `export.section.cashflowTrend` → "Cashflow Trend"
- `export.section.categoryBreakdown` → "Category Breakdown"
- `export.section.topRecipients` → "Top Recipients"
- `export.section.bankBalances` → "Bank Balances"
- `export.section.rollingAverages` → "Rolling Averages"
- `export.section.plannedOutlook` → "Planned Outlook"
- `export.section.portfolioAllocation` → "Portfolio Allocation"
- `export.section.topHoldings` → "Top Holdings"
- `export.section.taxBreakdown` → "Tax Breakdown"

**Currency:**
- `export.currency` → "Currency"

**Buttons:**
- `export.openDialog` → "Export PDF"
- `export.download` → "Download PDF"
- `export.downloading` → "Generating…"
- `common.cancel` → "Cancel"

## Design System

Uses shadcn/Radix UI primitives:

- `Dialog` — Modal container
- `DialogTrigger` — Trigger button
- `DialogContent` — Modal content area
- `DialogHeader`, `DialogTitle`, `DialogDescription` — Header section
- `DialogFooter` — Button footer
- `RadioGroup`, `RadioGroupItem` — Report type and period selection
- `Checkbox` — Section toggles
- `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` — Currency dropdown
- `Input` — Year, from/to date inputs
- `Button` — Submit/cancel buttons
- `Separator` — Visual dividers between sections
- `Label` — Form labels

**Colors and spacing:**
- Border-based radio group styling (primary border + background on active)
- Hover states with muted background tints
- Responsive spacing (py-2, px-3, gap-2, etc.)
- `max-w-lg` modal width, `max-h-[90vh]` height with scroll support

## Interactions

### Report Type Change

When user selects a different report type:
1. Update `reportType` state
2. Reset `sections` to default set for that type
3. Keep period and currency unchanged

### Period Preset Toggle

When user selects a different period:
- Update `periodPreset` state
- Conditionally show year input (if `year` selected)
- Conditionally show from/to date inputs (if `custom` selected)

### Section Toggle

Individual checkbox changes update the `sections` Set:
- Add section if checked
- Remove section if unchecked
- Update "All" checkbox state (full, partial, or empty)

### All Sections Toggle

Clicking the "All" header checkbox:
- Checked → Set all sections to enabled
- Unchecked → Set all sections to disabled

## Code Patterns

### Immutability with Sets

Section toggling uses immutable Set patterns:

```typescript
function toggleSection(id: string, checked: boolean) {
  setSections((prev) => {
    const next = new Set(prev);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    return next;
  });
}
```

### Period Builder

Helper function converts UI preset + inputs into API period object:

```typescript
function buildPeriod(
  preset: PeriodPreset,
  customYear: string,
  customFrom: string,
  customTo: string
): ReportPeriod {
  switch (preset) {
    case 'ytd': return { kind: 'ytd' };
    case 'rolling3': return { kind: 'rolling', months: 3 };
    case 'rolling12': return { kind: 'rolling', months: 12 };
    case 'year': return { kind: 'year', year: parseInt(customYear, 10) || new Date().getFullYear() };
    case 'custom': return { kind: 'custom', from: customFrom, to: customTo };
  }
}
```

### Section Enablement Check

Determines whether to send `[]` (defaults) or explicit section list:

```typescript
function allSectionsEnabled(sections: ReadonlySet<string>, defs: SectionDef[]): boolean {
  return defs.every((d) => sections.has(d.id));
}

// Usage
const selectedSections = allSectionsEnabled(sections, sectionDefs) ? [] : [...sections];
```

## Integration Points

### Context Dependencies

- `useLanguage()` — i18n translations
- `useAppSettings()` — default currency

### API Calls

- `downloadFinancialReport(opts)` — POST `/api/reports/financial`
- `downloadPortfolioReport(opts)` — POST `/api/reports/portfolio`
- `downloadTaxReport(opts)` — POST `/api/reports/tax`

See `[[docs/features/pdf-report-export|PDF Report Export]]` for request/response details.

### Toast Notifications

Uses `sonner` toast library:

```typescript
toast.success(t('statsPage.report.downloadSuccess'));
toast.error(t('statsPage.report.downloadError'), { description: '...' });
```

## Deployment Locations

| Page | Path | Report Type | Position |
|------|------|-------------|----------|
| **Statistics** | `apps/frontend/src/pages/StatisticsPage.tsx` (line 117) | financial | Header actions |
| **Tax Overview** | `apps/frontend/src/pages/TaxOverviewPage.tsx` | tax | Header actions |
| **Stocks** | `apps/frontend/src/pages/portfolio/StocksPage.tsx` | portfolio | Header actions |

## Related

- [[docs/features/pdf-report-export|PDF Report Export Feature]] — Backend PDF generation, section renderers, API contracts
- [[docs/api/reports|Reports API]] — Endpoint specifications
- [[docs/components/form-dialogs|Form Dialogs]] — Similar dialog patterns
- [[docs/components/shared-components|Shared Components]] — PageHeader usage

## Future Enhancements

- Portfolio and tax report section renderers (currently placeholder "Coming soon")
- Report templates (e.g., "Quick Summary", "Detailed Analysis")
- Export scheduling (e.g., "Email me monthly reports")
- Custom branding options (logo, footer text)
