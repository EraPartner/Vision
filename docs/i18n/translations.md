---
title: Translations & i18n
type: i18n
status: active
date: 2026-04-27
updated: 2026-06-01
tags: [i18n, translations, localization, internationalization, phase-6, phase-8, phase-f, phase-9, phase-c, phase-d, phase-2, splits, settlement, admin, observability, cash-flow-forecast, pdf-export, portfolio, tax, backup, encrypt, passphrase-modal, accessibility, aria-label, bug-hunt-2026-05-06, chart-aria, screen-reader, plural, tc, intl-plural-rules, planned-page, toast]
description: Internationalization system including supported languages, translation workflow, and usage patterns. Phase 6 adds 32 export keys for PDF report localization. Phase 8 adds 11 additional export.section.* keys for portfolio (6) and tax (7) report sections. Phase C adds 15 cash flow forecast keys. Phase F adds 60 admin observability keys. 2026-05-29 adds 16 chart.aria.* keys (localized chart screen-reader summaries) and 21 aria.* keys (localized icon-button aria-labels). June 2026 adds tc() plural mechanism and plannedPage error-toast keys.
aliases: [i18n, translations, localization, language, nl, en, dutch, english]
related_code: ["apps/frontend/src/locales", "apps/frontend/src/contexts/LanguageContext.tsx", "apps/frontend/src/hooks/useSplits.ts"]
---

# Translations & i18n

Vision supports multiple languages with a comprehensive internationalization (i18n) system.

## Supported Languages

| Language | Code | Status |
|----------|------|--------|
| **English** | `en` | Default |
| **Dutch** | `nl` | Full support |

## Translation Files

### File Structure

```
i18n/
└── source/
    ├── en.json      # English translations
    └── nl.json      # Dutch translations

apps/frontend/src/
└── locales/
    ├── en.ts        # Generated from en.json
    └── nl.ts        # Generated from nl.json
```

### Source Files

Edit source files in `i18n/source/`:
- `i18n/source/en.json` - English (source of truth)
- `i18n/source/nl.json` - Dutch

The frontend imports from `apps/frontend/src/locales/` (generated).

## Usage in Code

### Basic Usage

```tsx
import { useLanguage } from "@/contexts/LanguageContext";

function MyComponent() {
  const { t, language, setLanguage } = useLanguage();
  
  return (
    <div>
      <h1>{t('page.title')}</h1>
      <button onClick={() => setLanguage('nl')}>
        Switch to Dutch
      </button>
    </div>
  );
}
```

### Translation Function

```typescript
// t() function signature — simple key lookup with optional interpolation
t(key: string, params?: Record<string, string | number>): string

// tc() function signature — plural-aware, uses Intl.PluralRules (June 2026)
tc(key: string, count: number, vars?: Record<string, string | number>): string
```

### With Parameters

```tsx
// Translation: "Welcome, {name}!"
// Usage:
t('welcome', { name: 'John' }) // "Welcome, John!"

// Translation: "Add {item}"
// Usage:
t('addItem', { item: 'Investment' }) // "Add Investment"
```

### With Plural Forms — `tc()` (June 2026)

`tc(key, count, vars?)` selects the correct plural form using `Intl.PluralRules` with the active language code. It looks up `key.one` when the count maps to category `"one"` (per CLDR rules), and `key.other` otherwise.

```tsx
// i18n/source/en.json
// "table.items": {
//   "one": "{{count}} item",
//   "other": "{{count}} items"
// }
//
// i18n/source/nl.json
// "table.items": {
//   "one": "{{count}} artikel",
//   "other": "{{count}} artikelen"
// }

const { tc } = useLanguage();
tc('table.items', 1)  // EN: "1 item"    / NL: "1 artikel"
tc('table.items', 5)  // EN: "5 items"   / NL: "5 artikelen"
```

`count` is automatically injected as `{{count}}` in the template unless overridden in `vars`.

**Keys using plural forms (en + nl):**

| Key | one | other |
|-----|-----|-------|
| `table.items` | `{{count}} item` | `{{count}} items` |
| `portfolio.investments` | `{{count}} investment` | `{{count}} investments` |
| `performance.holdings` | `{{count}} holding` | `{{count}} holdings` |

The key `performance.holdingsPlural` (formerly a separate plural key) has been **removed**. Migrate to `tc('performance.holdings', count)`.

## Translation Keys

### Naming Convention

Keys use dot notation for hierarchy:

```
# ✅ Good
nav.dashboard
form.addTransaction.title
errors.amount.required

# ❌ Bad
nav-dashboard
addTransactionTitle
```

### Key Structure

```
{component}.{section}.{element}
```

Examples:
- `nav.dashboard` - Navigation → Dashboard
- `form.addTransaction.title` - Form → Add Transaction → Title
- `errors.amount.required` - Errors → Amount → Required

### Categories

| Prefix | Usage | Example |
|--------|-------|---------|
| `nav.*` | Navigation items | `nav.transactions` |
| `form.*` | Form labels | `form.addTransaction.title` |
| `errors.*` | Error messages | `errors.amount.required` |
| `table.*` | Table headers | `table.actions` |
| `dialog.*` | Dialog text | `dialog.confirm` |
| `toast.*` | Toast messages | `toast.success` |
| `settings.*` | Settings labels, tabs, and sections | `settings.language`, `settings.tab.appearance`, `settings.appearance.variant` |
| `aria.*` | Icon-button accessible names | `aria.deleteTransaction`, `aria.save` |
| `chart.aria.*` | Chart screen-reader summary fragments | `chart.aria.kind.bar`, `chart.aria.seriesOther` |

## Adding New Translations

### Step 1: Add to Source Files

Add the key to both `i18n/source/en.json` and `i18n/source/nl.json`:

```json
// i18n/source/en.json
{
  "myComponent": {
    "greeting": "Hello!"
  }
}

// i18n/source/nl.json
{
  "myComponent": {
    "greeting": "Hallo!"
  }
}
```

### Step 2: Generate Locale Files

Run the build to generate TypeScript files:

```bash
bun run build
```

### Recent keys added

#### Plural forms + PlannedPaymentsPage toasts (June 2026)

**Plural key variants** (`table.items`, `portfolio.investments`, `performance.holdings`) — see [[docs/i18n/translations#with-plural-forms--tc-june-2026|tc() section]] above.

**Removed key:** `performance.holdingsPlural` — migrate callers to `tc('performance.holdings', count)`.

**2 new error-toast keys for `PlannedPaymentsPage`** (native `alert()` replaced with `toast.error`):

| Key | EN | NL |
|-----|----|----|
| `plannedPage.toggleFailed` | "Failed to toggle planned payment" | "Geplande betaling kon niet worden gewijzigd" |
| `plannedPage.deleteFailed` | "Failed to delete planned payment" | "Geplande betaling kon niet worden verwijderd" |

Code link: [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]]

#### `chart.aria` and `aria` namespaces (2026-05-29)

Remediates audit findings [[docs/reference/codebase-audit-2026-05#ux.4|ux.4]] (chart screen-reader labels hardcoded English) and [[docs/reference/codebase-audit-2026-05#ux.5|ux.5]] (~30 aria-labels bypassing `t()`).

**16 new `chart.aria.*` keys** — used by `chartAria.ts` generators (`summarizeSeriesChart`, `summarizeProportionChart`, `summarizeSparkline`). All 6 chart components now call `useLanguage()` and pass `t` + a `kindKey`:

- `chart.aria.kind.bar` — "Bar chart"
- `chart.aria.kind.line` — "Line chart"
- `chart.aria.kind.area` — "Area chart"
- `chart.aria.kind.pie` — "Pie chart"
- `chart.aria.kind.donut` — "Donut chart"
- `chart.aria.kind.stackedBar` — "Stacked bar chart"
- `chart.aria.seriesOne` — `"{kind} with {count} category"`
- `chart.aria.seriesOther` — `"{kind} with {count} categories"`
- `chart.aria.series` — `", series: {names}"`
- `chart.aria.segmentOne` — `"{kind} with {count} segment"`
- `chart.aria.segmentOther` — `"{kind} with {count} segments"`
- `chart.aria.segmentNames` — `": {names}"`
- `chart.aria.andMore` — `", and {count} more"`
- `chart.aria.sparklineEmpty` — "Sparkline, no data"
- `chart.aria.sparklineOne` — `"Sparkline of {count} point, ranging {min} to {max}"`
- `chart.aria.sparklineOther` — `"Sparkline of {count} points, ranging {min} to {max}"`

**21 new `aria.*` keys** — replace hardcoded English `aria-label` attributes across pages/features/shared components:

- `aria.cancel`, `aria.edit`, `aria.save`, `aria.close`
- `aria.clearSearch`, `aria.clearFilter`, `aria.clearSelection`
- `aria.deleteTransaction`, `aria.editTransaction`, `aria.transactionInfo`, `aria.selectAll`
- `aria.deleteCategory`, `aria.deleteRecipient`
- `aria.deleteInvestment`
- `aria.deletePlannedPayment`, `aria.editPlannedPayment`
- `aria.removeEntry`, `aria.removeFromWatchlist`
- `aria.dismiss`
- `aria.toggleSidebar`, `aria.collapseSidebar`

> [!info] Key naming convention
> `chart.aria.*` keys belong exclusively to the chart accessibility layer (`chartAria.ts`). `aria.*` keys are a flat namespace for icon-only interactive element labels across all surfaces. This separates charting-specific accessibility strings from the general interactive-element label set.

**Phase 6 (2026-04-24):**
- `export.title` — "Export PDF Report"
- `export.description` — "Configure your report, then download it as a PDF."
- `export.openDialog` — "Export PDF"
- `export.reportType` — "Report Type"
- `export.reportType.financial` — "Financial"
- `export.reportType.portfolio` — "Portfolio"
- `export.reportType.tax` — "Tax"
- `export.period` — "Period"
- `export.period.ytd` — "Year to Date"
- `export.period.rolling3` — "Last 3 Months"
- `export.period.rolling12` — "Last 12 Months"
- `export.period.year` — "Full Year"
- `export.period.year.label` — "Year"
- `export.period.custom` — "Custom Range"
- `export.period.from` — "From"
- `export.period.to` — "To"
- `export.sections` — "Sections"
- `export.sections.all` — "All"
- `export.section.executiveSummary` — "Executive Summary"
- `export.section.cashflowTrend` — "Cashflow Trend"
- `export.section.categoryBreakdown` — "Category Breakdown"
- `export.section.topRecipients` — "Top Recipients"
- `export.section.bankBalances` — "Bank Balances"
- `export.section.rollingAverages` — "Rolling Averages"
- `export.section.plannedOutlook` — "Planned Outlook"
- `export.section.portfolioExecutiveSummary` — "Portfolio Executive Summary" (Phase 8)
- `export.section.portfolioAllocation` — "Portfolio Allocation"
- `export.section.topHoldings` — "Top Holdings"
- `export.section.performanceTrend` — "Performance Trend" (Phase 8)
- `export.section.assetClassDetail` — "Asset Class Detail" (Phase 8)
- `export.section.dividendIncome` — "Dividend Income" (Phase 8)
- `export.section.taxExecutiveSummary` — "Tax Executive Summary" (Phase 8)
- `export.section.taxTypeBreakdown` — "Tax Type Breakdown" (Phase 8)
- `export.section.taxByAssetClass` — "Tax by Asset Class" (Phase 8)
- `export.section.taxMonthlyTrend` — "Tax Monthly Trend" (Phase 8)
- `export.section.topInvestmentsByCost` — "Top Investments by Cost" (Phase 8)
- `export.section.feeBreakdown` — "Fee Breakdown" (Phase 8)
- `export.section.belgianRulesSummary` — "Belgian Tax Rules" (Phase 8)
- `export.currency` — "Currency"
- `export.download` — "Download PDF"
- `export.downloading` — "Generating…"`

**Phase C (2026-04-25):**
- `cashflow.forecastTitle` — "Cash Flow Forecast" (chart title)
- `cashflow.forecastDesc` — "7-method statistical forecast with confidence bands" (subtitle)
- `cashflow.cumulative` — "Cumulative Balance" (view toggle tab)
- `cashflow.dailyNet` — "Daily Net" (view toggle tab)
- `cashflow.diagnostics` — "Diagnostics" (diagnostics panel button)
- `cashflow.loadError` — "Failed to load forecast data" (error message)
- `cashflow.diagnostics.title` — "Accuracy Metrics"
- `cashflow.diagnostics.mae` — "Mean Absolute Error"
- `cashflow.diagnostics.rmse` — "Root Mean Squared Error"
- `cashflow.diagnostics.mape` — "Mean Absolute % Error"
- `cashflow.diagnostics.rank` — "Rank"
- `cashflow.diagnostics.ensembleWeights` — "Suggested Ensemble Weights"

**Phase 9 (2026-04-20):**
- `settings.tab.appearance` — Appearance settings tab label
- `settings.appearance.variant` — Theme variant label
- `settings.appearance.variantHint` — Theme variant selector hint text
- `settings.appearance.variants.default` — "Default (Emerald)" variant name
- `settings.appearance.variants.dracula` — "Dracula" variant name
- `settings.appearance.variants.solarized` — "Solarized" variant name
- `settings.appearance.variants.nord` — "Nord" variant name
- `settings.appearance.variants.highContrast` — "High Contrast" variant name
- `settings.appearance.variantsDesc.default` — Description: "Apple-inspired liquid glass with emerald and gold"
- `settings.appearance.variantsDesc.dracula` — Description: "Dark-optimized moody palette"
- `settings.appearance.variantsDesc.solarized` — Description: "High contrast, reading-friendly"
- `settings.appearance.variantsDesc.nord` — Description: "Arctic-inspired calm colors"
- `settings.appearance.variantsDesc.highContrast` — Description: "WCAG AAA accessibility-focused"
- `settings.appearance.mode` — Theme mode label
- `settings.appearance.modeHint` — Theme mode selector hint text
- `settings.appearance.modes.light` — "Always Light" mode label
- `settings.appearance.modes.dark` — "Always Dark" mode label
- `settings.appearance.modes.system` — "Follow System" mode label
- `settings.appearance.modes.schedule` — "Schedule (Custom Times)" mode label
- `settings.appearance.lightFrom` — "Light theme from" time input label
- `settings.appearance.darkFrom` — "Dark theme from" time input label

**Phase 9 (2026-04-19):**
- `onboarding.persist.failed` — Error toast shown when onboarding state fails to persist

**Portfolio Performance Period (2026-04-25):**
- `performance.period.5d` — "5 Days" (short-period chart view for daily data inspection)

**Splits Settlement (2026-04-27):**
- `splits.settled` — "Splits settled" (en) / "Splits verrekend" (nl) — Success toast shown when `useSettleSplit()` completes
- `splits.settledFailed` — "Failed to settle splits" (en) / "Splits verrekenen mislukt" (nl) — Error toast shown when `useSettleSplit()` fails

**Phase C Bug Fixes (2026-05-06):**
- `txPage.deleteAttachment` — "Delete attachment" (en) / "Bijlage verwijderen" (nl) — Accessibility label for delete button
- `upcoming.dismissAll` — "Dismiss all" (en) / "Alles negeren" (nl) — Accessibility label for dismiss-all button in upcoming payments notification

**Encrypted Backup Restore Modal (2026-04-27, Phase 2):**
- `settings.restore.passphraseTitle` — "Backup is encrypted" (modal header) — Shown when user attempts to restore encrypted `.visionbak.enc` file
- `settings.restore.passphraseDesc` — "This backup was encrypted with a passphrase. Enter it to continue." (modal description)
- `settings.restore.passphraseLabel` — "Passphrase" (input label)
- `settings.restore.passphraseSubmit` — "Restore" (submit button text)
- `settings.restore.passphraseInvalid` — "Incorrect passphrase. Try again." (error message shown on wrong passphrase with retry prompt)
- `settings.restore.passphraseRequired` — "This backup is encrypted. Enter the passphrase to continue." (error when no passphrase provided)

**Dutch i18n Bug Fixes (2026-04-28):**
- Fixed corrupted `watchlist.empty` Dutch translation: contained ~80 escaped backslashes instead of newline character
  - Affected files: `i18n/source/nl.json`, `apps/frontend/src/locales/nl.ts`, `packaging/electron/i18n/nl.json`
- Added missing Dutch translations:
  - `portfolio.refreshPricesFailedTitle` → "Bijwerken van koersen mislukt"
  - `portfolio.recordTxnFailedTitle` → "Registreren van portfoliotransactie mislukt"
- Note: Additional `*FailedTitle` keys in categories, recipients, and transactions remain untranslated as English fallback (known follow-up work)

**Earlier phases:**
- `addInv.desc.metals`
- `addWatchlist.metals`
- `metals.title`
- `metals.noMetals`
- `metals.noMetalsDesc`
- `nav.metals`
- `portfolio.assetClass.metals`
- `portfolio.assetGroup.metals`
- `addInv.provider.hint.kinesis`
- `plannedPage.link.pickDate`

All keys were added in `i18n/source/en.json` and `i18n/source/nl.json`, then regenerated into `apps/frontend/src/locales/en.ts` and `apps/frontend/src/locales/nl.ts`.

Code links: [[i18n/source/en.json]], [[i18n/source/nl.json]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]], [[apps/frontend/src/components/onboarding/OnboardingWizard.tsx]]

### Step 3: Use in Component

```tsx
const { t } = useLanguage();

return <h1>{t('myComponent.greeting')}</h1>;
```

## Language Context

### LanguageContext API

```typescript
interface LanguageContextType {
  language: string;       // Current language code
  setLanguage: (lang: string) => void;
  t: (key: string, params?: object) => string;
}
```

### Setting Language

```tsx
// Set to Dutch
setLanguage('nl');

// Set to English
setLanguage('en');
```

## Supported Parameters

### Common Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `{count}` | number | Count for plurals |
| `{name}` | string | User/entity name |
| `{amount}` | number | Currency amounts |
| `{date}` | string | Date values |

### Pluralization

Many languages need different forms for singular/plural:

```json
{
  "item": "{{count}} item",
  "item_plural": "{{count}} items"
}
```

## Translation Coverage

### Checking Coverage

The English file (`en.json`) is the source of truth. All keys should exist in English.

### Missing Translations

If a translation is missing, the English text is displayed as fallback.

## UI Components with i18n

### Buttons

```tsx
<Button>{t('form.submit')}</Button>
```

### Forms

```tsx
<Label>{t('form.amount')}</Label>
<Input placeholder={t('form.amountPlaceholder')} />
```

### Tables

```tsx
<TableHead>{t('table.date')}</TableHead>
<TableHead>{t('table.amount')}</TableHead>
```

### Dialogs

```tsx
<DialogTitle>{t('dialog.confirmTitle')}</DialogTitle>
<DialogDescription>{t('dialog.confirmDesc')}</DialogDescription>
```

### Toasts

```tsx
toast.success(t('toast.saved'));
toast.error(t('toast.error'));
```

## Currency & Number Formatting

### Number Format

Numbers are formatted based on locale:

```tsx
import { numberFormatToLocale } from "@/utils/currency";

const locale = numberFormatToLocale('en');
new Intl.NumberFormat(locale, { 
  style: 'currency', 
  currency: 'EUR' 
}).format(1000.50);
// "€1,000.50"
```

### Date Formatting

Vision uses native `Intl.DateTimeFormat` for date formatting (Phase 5 slim-down removed date-fns). The `dateUtils.ts` helper module provides thin wrappers for common patterns:

```tsx
import { formatDate, formatDateTime } from '@/lib/dateUtils';

// Format a date in the current locale
formatDate(new Date()); 
// English: "3/18/2025"
// Dutch: "18-3-2025"

// Format with day name
formatDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' });
// English: "March 18, 2025"
// Dutch: "18 maart 2025"
```

## Best Practices

### 1. Use Translation Keys, Not Hardcoded Text

```tsx
// ✅ Good
<h1>{t('page.title')}</h1>

// ❌ Bad
<h1>Dashboard</h1>
```

### 2. Parameterize Dynamic Values

```tsx
// ✅ Good
<p>{t('welcome', { name: user.name })}</p>

// ❌ Bad
<p>Welcome {user.name}</p>
```

### 3. Keep Keys Consistent

```tsx
// ✅ Consistent
t('form.addTransaction.title')
t('form.addCategory.title')

// ❌ Inconsistent
t('form.addTransaction')
t('addCategoryTitle')
```

### 4. Test Both Languages

When adding new UI, verify both English and Dutch displays correctly.

## Translation Workflow

```
1. Developer adds English text to UI
   ↓
2. Run translation script to extract keys
   ↓
3. Add keys to en.json (source of truth)
   ↓
4. Add corresponding nl.json translations
   ↓
5. Build to generate .ts files
   ↓
6. Verify in application
```

## Related Documentation

- [[docs/i18n/index]] - i18n Index
- [[docs/components/index]] - Components using translations
- [MDN Intl.DateTimeFormat docs](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat)
