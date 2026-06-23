---
title: Translations & i18n
type: i18n
status: active
date: 2026-04-27
updated: 2026-06-12
tags: [i18n, translations, localization, internationalization, phase-6, phase-8, phase-f, phase-9, phase-c, phase-d, phase-2, splits, settlement, admin, observability, cash-flow-forecast, pdf-export, portfolio, tax, backup, encrypt, passphrase-modal, accessibility, aria-label, bug-hunt-2026-05-06, chart-aria, screen-reader, plural, tc, intl-plural-rules, planned-page, toast, electron-native, menu, system-accent, suggestion-card, splash, upcoming-count, electron-error-page, backend-watchdog, visual-effects-tiers, auto-adapt-display, june-2026]
description: Internationalization system including supported languages, translation workflow, and usage patterns. Phase 6 adds 32 export keys for PDF report localization. Phase 8 adds 11 additional export.section.* keys for portfolio (6) and tax (7) report sections. Phase C adds 15 cash flow forecast keys. Phase F adds 60 admin observability keys. 2026-05-29 adds 16 chart.aria.* keys (localized chart screen-reader summaries) and 21 aria.* keys (localized icon-button aria-labels). June 2026 adds tc() plural mechanism and plannedPage error-toast keys. June 2026 (ADR-070) adds 5 commandPalette.* keys (en + nl) for the new ⌘K command palette. June 2026 Premium v3 (ADR-071) adds 8 keys: settings.general.enhancedEffects/Hint, shortcuts.title/showHelp/closeDialog/chartScrub, commandPalette.recent/searchTransactions. June 2026 Premium v3 V5-V7 adds 14 keys: contextMenu.* (8 keys), quickLook.* (2 keys), shortcuts table-interaction additions (4 keys). June 2026 V12 (ADR-072) adds 11 keys: menu.edit/file/go/importCsv/keyboardShortcuts/newTransaction/settings/toggleSidebar/view, settings.appearance.systemAccent/systemAccentHint. June 2026 V11 adds 4 keys: dashboard.suggestions, dashboard.widgetDescriptions.suggestions, suggestions.kicker, suggestions.review. June 2026 (startup/UI fixes) adds 5 splash.* keys (en + nl, Electron boot splash narration) + tc()-plural upcoming.count.one/.other; removes upcoming.countSingle/countPlural. 2026-06-11 adds 5 app.* keys (Electron error page + backend-lost watchdog, en + nl). 2026-06-12 (ADR-075) adds 7 settings.appearance.visualEffects*/autoAdaptDisplay* keys; removes settings.general.enhancedEffects + settings.general.enhancedEffectsHint. ADR-075 addendum (same day) adds 2 more contextual-note keys (visualEffectsAutoNote + visualEffectsOverrideNote). Total: 2913 keys (per validate-locales after addendum).
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
//   "one": "{count} item",
//   "other": "{count} items"
// }
//
// i18n/source/nl.json
// "table.items": {
//   "one": "{count} artikel",
//   "other": "{count} artikelen"
// }

const { tc } = useLanguage();
tc('table.items', 1)  // EN: "1 item"    / NL: "1 artikel"
tc('table.items', 5)  // EN: "5 items"   / NL: "5 artikelen"
```

`count` is automatically injected as `{count}` in the template unless overridden in `vars`.

**Keys using plural forms (en + nl):**

| Key | one | other |
|-----|-----|-------|
| `table.items` | `{count} item` | `{count} items` |
| `portfolio.investments` | `{count} investment` | `{count} investments` |
| `performance.holdings` | `{count} holding` | `{count} holdings` |
| `upcoming.count` | `{count} upcoming payment due this week` | `{count} upcoming payments due this week` |

**Removed flat plural keys (migrate to `tc()`):**

| Removed key | Replacement |
|-------------|-------------|
| `performance.holdingsPlural` | `tc('performance.holdings', count)` |
| `upcoming.countSingle` | `tc('upcoming.count', 1)` |
| `upcoming.countPlural` | `tc('upcoming.count', count)` |

`upcoming.countSingle`/`countPlural` were replaced in June 2026 when `SuggestionCard`'s hand-rolled singular/plural logic was migrated to `tc()` for consistency with the rest of the app.

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
| `splash.*` | Electron boot-splash phase labels (main-process only, not rendered in React) | `splash.checkingDocker`, `splash.waitingApp` |
| `app.*` | Electron shell error page and watchdog messages (main-process only, not rendered in React) | `app.errorPageTitle`, `app.backendLost` |

## Adding New Translations

### Step 1: Add to Source Files

Add the key to both `i18n/source/en.json` and `i18n/source/nl.json`:

```json
// i18n/source/en.json
{
  "myComponent.greeting": "Hello!",
  "myComponent.title": "My Component"
}

// i18n/source/nl.json
{
  "myComponent.greeting": "Hallo!",
  "myComponent.title": "Mijn component"
}
```

### Step 2: Generate Locale Files

Run the generate-locales script to produce TypeScript files:

```bash
bun run generate-locales
```

### Recent keys added

#### Visual-effects tiers (2026-06-12, ADR-075 + addendum)

9 new keys added, 2 removed. `bun run generate-locales` + `validate-locales` clean (2,913 keys parity). Keys also flow to `packaging/electron/i18n/` via `generate-locales`.

**7 new `settings.appearance.*` keys** — visual effects tier Select + auto-adapt Switch (ADR-075 original):

| Key | EN |
|-----|----|
| `settings.appearance.visualEffects` | "Visual effects" |
| `settings.appearance.visualEffects.reduced` | "Reduced" |
| `settings.appearance.visualEffects.standard` | "Standard" |
| `settings.appearance.visualEffects.enhanced` | "Enhanced" |
| `settings.appearance.visualEffectsHint` | Hint describing the three tiers |
| `settings.appearance.autoAdaptDisplay` | "Auto-adapt to display" |
| `settings.appearance.autoAdaptDisplayHint` | Hint describing the large-display heuristic |

**2 new `settings.appearance.*` keys** — contextual notes under the Select (ADR-075 addendum, same day):

| Key | EN | Shown when |
|-----|----|------------|
| `settings.appearance.visualEffectsAutoNote` | "Reduced automatically for this large display…" (styled `text-primary`) | `autoAdaptDisplay && isLargeDisplay` and no session override active |
| `settings.appearance.visualEffectsOverrideNote` | "Session override for this device — automatic reduction resumes after the next launch" (styled `text-warning`) | Session override active |

**2 removed keys** — replaced by the tier model above:
- `settings.general.enhancedEffects`
- `settings.general.enhancedEffectsHint`

> [!info] Migration note
> Stored `AppSettings` blobs that contain `enhancedEffects: true` are silently migrated to `visualEffects: 'enhanced'` at hydration by `migrateAppSettings` in `settingsStore.ts`; `enhancedEffects: false` becomes `visualEffects: 'standard'`. The legacy key is stripped on the next debounced persist. No backend change needed.

Code links: [[apps/frontend/src/stores/settingsStore.ts]], [[apps/frontend/src/components/settings/AppearanceTab.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]], [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]]

---

#### Startup/UI fix batch (June 2026)

7 new keys, 2 removed. `bun run generate-locales` + `validate-locales` clean. Keys also flow to `packaging/electron/i18n/` via `generate-locales`.

**5 new `splash.*` keys** — Electron boot-splash phase narration:

| Key | EN |
|-----|----|
| `splash.checkingDocker` | `Checking Docker...` |
| `splash.downloading` | `Downloading components...` |
| `splash.starting` | `Starting Vision...` |
| `splash.startingServices` | `Starting services...` |
| `splash.waitingApp` | `Almost ready...` |

These are used only in the Electron main process (`setSplashStatus()`); they are not rendered inside React. They require the Electron i18n file to be regenerated via `generate-locales`.

**2 new `upcoming.count` plural keys** (replace 2 removed):

| Key | one | other |
|-----|----|-------|
| `upcoming.count.one` | `{count} upcoming payment due this week` | — |
| `upcoming.count.other` | — | `{count} upcoming payments due this week` |

**2 removed keys** — replaced by `tc('upcoming.count', count)`:
- `upcoming.countSingle`
- `upcoming.countPlural`

#### Electron error page + backend-lost watchdog (2026-06-11)

5 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Keys also flow to `packaging/electron/i18n/en.json` + `nl.json` via `generate-locales`. Total after this batch: **2896 keys**.

**5 new `app.*` keys** — Electron startup error page and runtime backend-lost watchdog (main process only, not rendered in React):

| Key | EN | NL |
|-----|----|----|
| `app.errorPageTitle` | "Vision couldn't start" | "Vision kon niet starten" |
| `app.errorPageMessage` | "Vision couldn't reach its backend. Try again, or check the logs to see what happened." | "Vision kon de backend niet bereiken. Probeer het opnieuw of bekijk de logboeken om te zien wat er gebeurde." |
| `app.errorPageRetry` | "Try again" | "Opnieuw proberen" |
| `app.errorPageOpenLogs` | "Open logs" | "Logboeken openen" |
| `app.backendLost` | "Connection to the Vision backend was lost. Reconnecting…" | "Verbinding met de Vision-backend verbroken. Opnieuw verbinden…" |

> [!info] Implementation gap corrected
> ADR-022 (section 6) documented these five keys at acceptance time but they were never committed to `i18n/source/`. From ADR-022's merge until today, `packaging/electron/main.js` called `t('app.errorPageTitle')` etc. and received the raw key name back as a fallback string (e.g., the error page title appeared as `"app.errorPageTitle"`). The gap went unnoticed because the error page only appears when the startup health poll times out. This batch closes the gap. See the correction note appended to [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]] for full details.

Code links: [[packaging/electron/main.js]], [[i18n/source/en.json]], [[i18n/source/nl.json]], [[packaging/electron/i18n/en.json]], [[packaging/electron/i18n/nl.json]]

---

#### Premium v3 V8-V11 batch (June 2026, ADR-071)

4 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2891 keys**.

**4 new `dashboard.*` / `suggestions.*` keys** — SuggestionCard widget (V11):

| Key | EN |
|-----|----|
| `dashboard.suggestions` | "Suggestions" (widget label in visibility dialog) |
| `dashboard.widgetDescriptions.suggestions` | Widget description |
| `suggestions.kicker` | "Suggested for you" |
| `suggestions.review` | "Review" |

> [!note] No new keys for V8, V9, V10
> V8 (icon bounce) and V9 (sparkline scrub) are purely CSS/JS with no user-visible new strings. V10 (genie dialog exit) is also CSS/JS-only. Only V11's `SuggestionCard` introduced new i18n keys.

Code links: [[apps/frontend/src/components/dashboard/SuggestionCard.tsx]], [[apps/frontend/src/hooks/useUpcomingPlannedPayments.ts]], [[apps/frontend/src/pages/DashboardPage.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Electron-Native Desktop Integration (June 2026, ADR-072)

11 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Source total stays **2887 keys** — the V5-V7 count below was a working-tree snapshot that already included these 11 (then-uncommitted) V12 keys; the V5-V7 *commit* carried 2876.

**9 new `menu.*` keys** — native macOS application menu labels:

| Key | EN |
|-----|----|
| `menu.settings` | "Settings…" |
| `menu.file` | "File" |
| `menu.newTransaction` | "New Transaction" |
| `menu.importCsv` | "Import CSV…" |
| `menu.edit` | "Edit" |
| `menu.view` | "View" |
| `menu.toggleSidebar` | "Toggle Sidebar" |
| `menu.go` | "Go" |
| `menu.keyboardShortcuts` | "Keyboard Shortcuts" |

**2 new `settings.appearance.*` keys** — system accent color toggle:

| Key | EN | NL |
|-----|----|----|
| `settings.appearance.systemAccent` | "Use system accent color" | (Dutch equivalent) |
| `settings.appearance.systemAccentHint` | "Match buttons and highlights to your macOS accent color" | (Dutch equivalent) |

**1 key reworded** — `settings.general.enhancedEffectsHint` updated to mention window translucency in addition to the WebGL aurora (en + nl). Note: this key was subsequently **removed** by ADR-075 (2026-06-12) along with `settings.general.enhancedEffects`.

Code links: [[packaging/electron/main.js]], [[apps/frontend/src/components/settings/AppearanceTab.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Premium v3 V5-V7 batch (June 2026, ADR-071)

14 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2887 keys** (working-tree snapshot incl. 11 uncommitted V12 keys; 2876 committed).

**8 new `contextMenu.*` keys** — transaction row right-click menu:

| Key | EN |
|-----|----|
| `contextMenu.info` | "Show details" |
| `contextMenu.quickLook` | "Quick Look" |
| `contextMenu.editInline` | "Edit in row" |
| `contextMenu.duplicate` | "Duplicate" |
| `contextMenu.showAllFromRecipient` | "Show all from {name}" |
| `contextMenu.markActive` | "Mark as active" |
| `contextMenu.markInactive` | "Mark as inactive" |
| `contextMenu.delete` | "Delete…" |

**2 new `quickLook.*` keys** — Quick Look dialog:

| Key | EN |
|-----|----|
| `quickLook.title` | "Quick Look" |
| `quickLook.hint` | "Press Space to close" |

**4 new `shortcuts.*` keys** — ShortcutsOverlay table-interaction rows:

| Key | EN |
|-----|----|
| `shortcuts.tableNav` | "Move between table rows" |
| `shortcuts.tableOpen` | "Open transaction details" |
| `shortcuts.quickLook` | "Quick Look the focused row" |
| `shortcuts.rowMenu` | "Tip: right-click a transaction row for quick actions." |

Code links: [[apps/frontend/src/features/transactions/components/TransactionsTable.tsx]], [[apps/frontend/src/features/transactions/components/TransactionQuickLook.tsx]], [[apps/frontend/src/components/shared/ShortcutsOverlay.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Premium v3 batch (June 2026, ADR-071)

8 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2854 keys**.

**2 `settings.general.*` keys** — Enhanced visual effects toggle (original ADR-071 batch; **removed by ADR-075 on 2026-06-12** — replaced by `settings.appearance.visualEffects*` / `autoAdaptDisplay*`):

| Key | EN | NL | Status |
|-----|----|----|--------|
| `settings.general.enhancedEffects` | "Enhanced visual effects" | (Dutch equivalent) | Removed 2026-06-12 |
| `settings.general.enhancedEffectsHint` | "Enable WebGL aurora background (may increase GPU usage)" | (Dutch equivalent) | Removed 2026-06-12 |

**4 new `shortcuts.*` keys** — ShortcutsOverlay (`?` key dialog):

| Key | EN |
|-----|----|
| `shortcuts.title` | "Keyboard Shortcuts" |
| `shortcuts.showHelp` | "Show keyboard shortcuts" |
| `shortcuts.closeDialog` | "Close dialog" |
| `shortcuts.chartScrub` | "Drag on a chart to compare a range" |

**2 new `commandPalette.*` keys** — Palette v2 additions:

| Key | EN |
|-----|----|
| `commandPalette.recent` | "Recent" |
| `commandPalette.searchTransactions` | "Search transactions for…" |

Code links: [[apps/frontend/src/components/shared/ShortcutsOverlay.tsx]], [[apps/frontend/src/components/settings/tabs/GeneralTab.tsx]], [[apps/frontend/src/components/shared/CommandPalette.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

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
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  tc: (key: string, count: number, vars?: Record<string, string | number>) => string;
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
2. Add keys to en.json (source of truth)
   ↓
3. Add corresponding nl.json translations
   ↓
4. Run bun run generate-locales to produce .ts files
   ↓
5. Verify in application
```

## Related Documentation

- [[docs/i18n/index]] - i18n Index
- [[docs/components/index]] - Components using translations
- [MDN Intl.DateTimeFormat docs](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat)
