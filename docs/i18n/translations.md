---
title: Translations & i18n
type: i18n
status: active
date: 2026-04-27
updated: 2026-08-27
tags: [i18n, translations, localization, internationalization, phase-6, phase-8, phase-f, phase-9, phase-c, phase-d, phase-2, splits, settlement, admin, observability, cash-flow-forecast, pdf-export, portfolio, tax, backup, encrypt, passphrase-modal, accessibility, aria-label, bug-hunt-2026-05-06, chart-aria, screen-reader, plural, tc, intl-plural-rules, planned-page, toast, electron-native, menu, system-accent, splash, upcoming-count, electron-error-page, backend-watchdog, visual-effects-tiers, auto-adapt-display, colorblind, gain-loss, june-2026, combobox-tags, tag-filter-combobox, validate-locales, source-key-usage, placeholder-bug-fix, url-state, destructive-confirm]
description: Internationalization system including supported languages, translation workflow, and usage patterns. Phase 6 adds 32 export keys for PDF report localization. Phase 8 adds 11 additional export.section.* keys for portfolio (6) and tax (7) report sections. Phase C adds 15 cash flow forecast keys. Phase F adds 60 admin observability keys. 2026-05-29 adds 16 chart.aria.* keys (localized chart screen-reader summaries) and 21 aria.* keys (localized icon-button aria-labels). June 2026 adds tc() plural mechanism and plannedPage error-toast keys. June 2026 (ADR-070) adds 5 commandPalette.* keys (en + nl) for the new ⌘K command palette. June 2026 Premium v3 (ADR-071) adds 8 keys: settings.general.enhancedEffects/Hint, shortcuts.title/showHelp/closeDialog/chartScrub, commandPalette.recent/searchTransactions. June 2026 Premium v3 V5-V7 adds 14 keys: contextMenu.* (8 keys), quickLook.* (2 keys), shortcuts table-interaction additions (4 keys). June 2026 V12 (ADR-072) adds 11 keys: menu.edit/file/go/importCsv/keyboardShortcuts/newTransaction/settings/toggleSidebar/view, settings.appearance.systemAccent/systemAccentHint. June 2026 V11 adds 4 keys: dashboard.suggestions, dashboard.widgetDescriptions.suggestions, suggestions.kicker, suggestions.review. June 2026 (startup/UI fixes) adds 5 splash.* keys (en + nl, Electron boot splash narration) + tc()-plural upcoming.count.one/.other; removes upcoming.countSingle/countPlural. 2026-06-11 adds 5 app.* keys (Electron error page + backend-lost watchdog, en + nl). 2026-06-12 (ADR-075) adds 7 settings.appearance.visualEffects*/autoAdaptDisplay* keys; removes settings.general.enhancedEffects + settings.general.enhancedEffectsHint. ADR-075 addendum (same day) adds 2 more contextual-note keys (visualEffectsAutoNote + visualEffectsOverrideNote). 2026-06-24 adds 5 Accessibility group keys (settings.group.accessibility, settings.appearance.gainLossColors, settings.appearance.gainLossColorsHint, settings.appearance.gainLossColors.colorblind, settings.appearance.gainLossColors.classic). 2026-06-26 adds 3 combobox.tags.* keys (combobox.tags.empty, combobox.tags.nSelected, combobox.tags.search) for TagFilterCombobox i18n (bulk-tag and filter-toolbar combobox). 2026-06-26 — validate-locales gains source key-usage checks (key-existence, dropped-vars, value-shape); closes 10 missing keys and fixes placeholder mismatches. 2026-08-10 (PR #156) adds 11 keys: txPage.loadMoreFailed/loadMoreFailedDesc/deleteAttachmentError (3), watchlist.removeTitle/removeDesc/removeConfirm (3), research.mapping.removeDesc, importReview.recipientPickerLabel, dbEditor.discardNewRow/nextPage/prevPage (3). Total key count last verified 2026-06-26 (3495); not re-verified since — run `bun run validate-locales` (see [[docs/reference/scripts|Scripts Reference]]) for a current count.
aliases: [i18n, translations, localization, language, nl, en, dutch, english]
related_code: ["apps/frontend/src/locales", "apps/frontend/src/contexts/LanguageContext.tsx", "apps/frontend/src/hooks/useSplits.ts"]
---

# Translations & i18n

Vision supports multiple languages with a comprehensive internationalization (i18n) system.

## Supported Languages

| Language    | Code | Status       |
| ----------- | ---- | ------------ |
| **English** | `en` | Default      |
| **Dutch**   | `nl` | Full support |

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
      <h1>{t("page.title")}</h1>
      <button onClick={() => setLanguage("nl")}>Switch to Dutch</button>
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
t("welcome", { name: "John" }); // "Welcome, John!"

// Translation: "Add {item}"
// Usage:
t("addItem", { item: "Investment" }); // "Add Investment"
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
tc("table.items", 1); // EN: "1 item"    / NL: "1 artikel"
tc("table.items", 5); // EN: "5 items"   / NL: "5 artikelen"
```

`count` is automatically injected as `{count}` in the template unless overridden in `vars`.

**Keys using plural forms (en + nl):**

| Key                     | one                                      | other                                     |
| ----------------------- | ---------------------------------------- | ----------------------------------------- |
| `table.items`           | `{count} item`                           | `{count} items`                           |
| `portfolio.investments` | `{count} investment`                     | `{count} investments`                     |
| `performance.holdings`  | `{count} holding`                        | `{count} holdings`                        |
| `upcoming.count`        | `{count} upcoming payment due this week` | `{count} upcoming payments due this week` |

**Removed flat plural keys (migrate to `tc()`):**

| Removed key                  | Replacement                         |
| ---------------------------- | ----------------------------------- |
| `performance.holdingsPlural` | `tc('performance.holdings', count)` |
| `upcoming.countSingle`       | `tc('upcoming.count', 1)`           |
| `upcoming.countPlural`       | `tc('upcoming.count', count)`       |

`upcoming.countSingle`/`countPlural` were replaced in June 2026 when the upcoming-payments banner's hand-rolled singular/plural logic was migrated to `tc()` for consistency with the rest of the app (at the time this was used by `SuggestionCard`, which has since been deleted; the `tc()` migration is retained).

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

| Prefix         | Usage                                                                                      | Example                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `nav.*`        | Navigation items                                                                           | `nav.transactions`                                                            |
| `form.*`       | Form labels                                                                                | `form.addTransaction.title`                                                   |
| `errors.*`     | Error messages                                                                             | `errors.amount.required`                                                      |
| `table.*`      | Table headers                                                                              | `table.actions`                                                               |
| `dialog.*`     | Dialog text                                                                                | `dialog.confirm`                                                              |
| `toast.*`      | Toast messages                                                                             | `toast.success`                                                               |
| `settings.*`   | Settings labels, tabs, and sections                                                        | `settings.language`, `settings.tab.appearance`, `settings.appearance.variant` |
| `aria.*`       | Icon-button accessible names                                                               | `aria.deleteTransaction`, `aria.save`                                         |
| `chart.aria.*` | Chart screen-reader summary fragments                                                      | `chart.aria.kind.bar`, `chart.aria.seriesOther`                               |
| `splash.*`     | Electron boot-splash phase labels (main-process only, not rendered in React)               | `splash.checkingDocker`, `splash.waitingApp`                                  |
| `app.*`        | Electron shell error page and watchdog messages (main-process only, not rendered in React) | `app.errorPageTitle`, `app.backendLost`                                       |

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

#### Placeholder and empty-state copy convention (2026-08-25)

No keys were added. Four generic input placeholders now show a concrete example or action, and
short standalone empty-state labels omit terminal periods in both English and Dutch. Longer empty
state explanations keep sentence punctuation.

The Dashboard, Transactions, and Planned Payments subtitles now describe the page's purpose instead
of repeating its navigation label. The Dutch copy was rewritten alongside the English source.

#### URL-state / feedback / accessibility batch (2026-08-10, PR #156)

New keys added in en + nl (no existing keys changed):

| Key                                                                          | Used for                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `txPage.loadMoreFailed` / `txPage.loadMoreFailedDesc`                        | Toast title/description when infinite-scroll load-more fails on Transactions; toast carries a `common.retry` action                |
| `txPage.deleteAttachmentError`                                               | Toast shown when `AttachmentPanel`'s delete mutation fails                                                                         |
| `watchlist.removeTitle` / `watchlist.removeDesc` / `watchlist.removeConfirm` | `useConfirmDialog` copy for the new destructive confirm on watchlist item removal                                                  |
| `research.mapping.removeDesc`                                                | `useConfirmDialog` description for the new destructive confirm on `ResearchMappingDialog` mapping removal                          |
| `importReview.recipientPickerLabel`                                          | Accessible name for the per-group recipient combobox on `ImportReviewPage` (now rendered via `AccordionTrigger`'s `trailing` prop) |
| `dbEditor.discardNewRow`, `dbEditor.nextPage`, `dbEditor.prevPage`           | `aria-label`s added to previously unlabeled icon-only buttons on `TableDataEditorPage`                                             |

Also see [[docs/features/transactions#url-backed-search--sort-and-load-moreattachment-delete-failure-toasts-aug-2026|Transactions: URL-Backed Search + Sort]], [[docs/features/watchlist|Watchlist]], [[docs/features/research#isin-anchored-symbol-mapping|Research: Symbol Mapping]], [[docs/features/import#4-commit-commitbatch|Import: Commit]].

#### i18n bug-fix batch — missing keys, placeholder fixes (2026-06-26)

Motivated by the new source key-usage checks added to `validate-locales` (see [[docs/i18n/translations#validation--validate-locales-checks|Validation section]]). Three classes of pre-existing leaks were closed.

**10 missing keys added to `en.json` + `nl.json`** (previously `t()` returned the raw key string at these call sites):

| Key                            | Used for                                                |
| ------------------------------ | ------------------------------------------------------- |
| `portfolio.addTransaction`     | "Add transaction" button in portfolio investment detail |
| `settings.app.updateAutoApply` | "Auto-apply updates" toggle in app settings             |
| `importPage.resultSummary`     | Import result summary line on the import page           |
| `accounts.updateFailedTitle`   | Error toast title when an account update fails          |
| `splits.createFailed`          | Error toast when split creation fails                   |
| `splits.paymentRecorded`       | Success toast when a split payment is recorded          |
| `splits.paymentFailed`         | Error toast when recording a split payment fails        |
| `splits.removeFailed`          | Error toast when removing a split fails                 |
| `tags.createFailed`            | Error toast when tag creation fails                     |
| `common.applied`               | Generic "Applied" confirmation label                    |

**Placeholder fixes — missing `{var}` tokens added to locale strings (value was rendered blank at runtime):**

| Key                                  | Token added | Component/context                |
| ------------------------------------ | ----------- | -------------------------------- |
| `invDetail.fee`                      | `{amount}`  | Investment detail fee display    |
| `invDetail.tax`                      | `{amount}`  | Investment detail tax display    |
| `tax.card.totalWithPropertyEstimate` | `{year}`    | Tax card property estimate total |

**Placeholder fixes — unfilled `{var}` tokens removed from locale strings (literal `{x}` was visible in UI):**

| Key                                  | Token removed       | Fix detail                                                    |
| ------------------------------------ | ------------------- | ------------------------------------------------------------- |
| `charts.deleteFailed`                | `{msg}`             | Error shown via toast description; `{msg}` was never passed   |
| `charts.saveFailed`                  | `{msg}`             | Same; `WatchlistChartDialog.tsx` updated to capture error     |
| `charts.updateFailed`                | `{msg}`             | Same                                                          |
| `watchlist.updateFailed`             | `{msg}`             | Same; `WatchlistChartDialog.tsx` now captures the catch error |
| `cashflow.diagnostics.backtestNote`  | `{n}`, `{currency}` | Now filled at the call site                                   |
| `statsPage.incomeAvg`                | `{n}`               | Now filled at the call site                                   |
| `statsPage.spendingAvg`              | `{n}`               | Now filled at the call site                                   |
| `tax.historical.filedLock.unfileCta` | `{year}`            | Now filled at the call site                                   |

Code links: [[scripts/validate-locales.js]], [[i18n/source/en.json]], [[i18n/source/nl.json]], [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]]

---

#### TagFilterCombobox i18n — bulk-tag and filter-toolbar combobox keys (2026-06-26)

3 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **3495 keys**.

**3 new `combobox.tags.*` keys** — used by `TagFilterCombobox` in the transaction-list filter toolbar and in the bulk-edit "Apply tags" dialog (`BulkTagDialog`):

| Key                       | EN               | NL                   |
| ------------------------- | ---------------- | -------------------- |
| `combobox.tags.empty`     | "No tags found"  | "Geen tags gevonden" |
| `combobox.tags.nSelected` | "{n} tags"       | "{n} tags"           |
| `combobox.tags.search`    | "Search tags..." | "Tags zoeken..."     |

Before this batch, `TagFilterCombobox` fell back to the raw key name as its display string (e.g., the search placeholder showed `"combobox.tags.search"` literally) because the keys never existed in either locale file. The component had always called `t('combobox.tags.*')` but the corresponding source entries were never committed.

> [!info] Key count note
> The total climbed from 2918 (recorded 2026-06-24) to 3495 after this batch. The gap includes keys added by intermediate commits (chart series labels, tag palette labels, and related features) that were not individually recorded in this changelog. The 3495 figure is the verified output of `bun run generate-locales` after adding these three keys.

Code links: [[apps/frontend/src/components/shared/TagFilterCombobox.tsx]], [[apps/frontend/src/features/transactions/components/bulk/BulkTagDialog.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Visual-effects tiers (2026-06-12, ADR-075 + addendum)

9 new keys added, 2 removed. `bun run generate-locales` + `validate-locales` clean (2,913 keys parity). Keys also flow to `packaging/electron/i18n/` via `generate-locales`.

**7 new `settings.appearance.*` keys** — visual effects tier Select + auto-adapt Switch (ADR-075 original):

| Key                                          | EN                                          |
| -------------------------------------------- | ------------------------------------------- |
| `settings.appearance.visualEffects`          | "Visual effects"                            |
| `settings.appearance.visualEffects.reduced`  | "Reduced"                                   |
| `settings.appearance.visualEffects.standard` | "Standard"                                  |
| `settings.appearance.visualEffects.enhanced` | "Enhanced"                                  |
| `settings.appearance.visualEffectsHint`      | Hint describing the three tiers             |
| `settings.appearance.autoAdaptDisplay`       | "Auto-adapt to display"                     |
| `settings.appearance.autoAdaptDisplayHint`   | Hint describing the large-display heuristic |

**2 new `settings.appearance.*` keys** — contextual notes under the Select (ADR-075 addendum, same day):

| Key                                             | EN                                                                                                             | Shown when                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `settings.appearance.visualEffectsAutoNote`     | "Reduced automatically for this large display…" (styled `text-primary`)                                        | `autoAdaptDisplay && isLargeDisplay` and no session override active |
| `settings.appearance.visualEffectsOverrideNote` | "Session override for this device — automatic reduction resumes after the next launch" (styled `text-warning`) | Session override active                                             |

**2 removed keys** — replaced by the tier model above:

- `settings.general.enhancedEffects`
- `settings.general.enhancedEffectsHint`

> [!info] Migration note
> Stored `AppSettings` blobs that contain `enhancedEffects: true` are silently migrated to `visualEffects: 'enhanced'` at hydration by `migrateAppSettings` in `settingsStore.ts`; `enhancedEffects: false` becomes `visualEffects: 'standard'`. The legacy key is stripped on the next debounced persist. No backend change needed.

Code links: [[apps/frontend/src/stores/settingsStore.ts]], [[apps/frontend/src/features/settings/sections/AppearanceSection.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]], [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]]

---

#### Accessibility group — Gain & loss colors (2026-06-24, ADR-104 addendum)

5 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2918 keys**.

**5 new `settings.group.*` / `settings.appearance.*` keys** — Accessibility group in AppearanceSection:

| Key                                             | EN                                               |
| ----------------------------------------------- | ------------------------------------------------ |
| `settings.group.accessibility`                  | "Accessibility"                                  |
| `settings.appearance.gainLossColors`            | "Gain & loss colors"                             |
| `settings.appearance.gainLossColorsHint`        | Hint describing colorblind-safe vs classic modes |
| `settings.appearance.gainLossColors.colorblind` | "Colorblind-safe (orange loss)"                  |
| `settings.appearance.gainLossColors.classic`    | "Classic (red loss)"                             |

These keys back the Select in the new **Accessibility** `SettingsGroup` inside `AppearanceSection`. The setting it drives (`colorblindGainLoss`) toggles `.skin-v2` on `<html>` via `AppSettingsProvider`. See [[docs/features/appearance#gain--loss-colors--accessibility-setting-2026-06-24|Appearance — Gain & Loss Colors]] and [[docs/adr/104-skin-v2-dense-fintech-visual-redesign#addendum--2026-06-24-colorblind-palette-promoted-to-user-setting|ADR-104 addendum]].

Code links: [[apps/frontend/src/features/settings/sections/AppearanceSection.tsx]], [[apps/frontend/src/stores/settingsStore.ts]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Startup/UI fix batch (June 2026)

7 new keys, 2 removed. `bun run generate-locales` + `validate-locales` clean. Keys also flow to `packaging/electron/i18n/` via `generate-locales`.

**5 new `splash.*` keys** — Electron boot-splash phase narration:

| Key                       | EN                          |
| ------------------------- | --------------------------- |
| `splash.checkingDocker`   | `Checking Docker...`        |
| `splash.downloading`      | `Downloading components...` |
| `splash.starting`         | `Starting Vision...`        |
| `splash.startingServices` | `Starting services...`      |
| `splash.waitingApp`       | `Almost ready...`           |

These are used only in the Electron main process (`setSplashStatus()`); they are not rendered inside React. They require the Electron i18n file to be regenerated via `generate-locales`.

**2 new `upcoming.count` plural keys** (replace 2 removed):

| Key                    | one                                      | other                                     |
| ---------------------- | ---------------------------------------- | ----------------------------------------- |
| `upcoming.count.one`   | `{count} upcoming payment due this week` | —                                         |
| `upcoming.count.other` | —                                        | `{count} upcoming payments due this week` |

**2 removed keys** — replaced by `tc('upcoming.count', count)`:

- `upcoming.countSingle`
- `upcoming.countPlural`

#### Electron error page + backend-lost watchdog (2026-06-11)

5 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Keys also flow to `packaging/electron/i18n/en.json` + `nl.json` via `generate-locales`. Total after this batch: **2896 keys**.

**5 new `app.*` keys** — Electron startup error page and runtime backend-lost watchdog (main process only, not rendered in React):

| Key                     | EN                                                                                      | NL                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `app.errorPageTitle`    | "Vision couldn't start"                                                                 | "Vision kon niet starten"                                                                                     |
| `app.errorPageMessage`  | "Vision couldn't reach its backend. Try again, or check the logs to see what happened." | "Vision kon de backend niet bereiken. Probeer het opnieuw of bekijk de logboeken om te zien wat er gebeurde." |
| `app.errorPageRetry`    | "Try again"                                                                             | "Opnieuw proberen"                                                                                            |
| `app.errorPageOpenLogs` | "Open logs"                                                                             | "Logboeken openen"                                                                                            |
| `app.backendLost`       | "Connection to the Vision backend was lost. Reconnecting…"                              | "Verbinding met de Vision-backend verbroken. Opnieuw verbinden…"                                              |

> [!info] Implementation gap corrected
> ADR-022 (section 6) documented these five keys at acceptance time but they were never committed to `i18n/source/`. From ADR-022's merge until today, `packaging/electron/main.js` called `t('app.errorPageTitle')` etc. and received the raw key name back as a fallback string (e.g., the error page title appeared as `"app.errorPageTitle"`). The gap went unnoticed because the error page only appears when the startup health poll times out. This batch closes the gap. See the correction note appended to [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]] for full details.

Code links: [[packaging/electron/main.js]], [[i18n/source/en.json]], [[i18n/source/nl.json]], [[packaging/electron/i18n/en.json]], [[packaging/electron/i18n/nl.json]]

---

#### Premium v3 V8-V11 batch (June 2026, ADR-071)

4 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2891 keys**.

**4 `dashboard.*` / `suggestions.*` keys** — added by the SuggestionCard widget (V11):

| Key                                        | EN                                                |
| ------------------------------------------ | ------------------------------------------------- |
| `dashboard.suggestions`                    | "Suggestions" (widget label in visibility dialog) |
| `dashboard.widgetDescriptions.suggestions` | Widget description                                |
| `suggestions.kicker`                       | "Suggested for you"                               |
| `suggestions.review`                       | "Review"                                          |

> [!note] 2026-08-27 — SuggestionCard residue removed
> `SuggestionCard` was removed as part of the upcoming-payments banner unification. Its four orphaned keys were removed in the fixed-point unused-key cleanup. `bun run validate-locales` now fails when an exact source key has no static or dynamic-prefix consumer.

> [!note] No new keys for V8, V9, V10
> V8 (icon bounce) and V9 (sparkline scrub) are purely CSS/JS with no user-visible new strings. V10 (genie dialog exit) is also CSS/JS-only.

Code links: [[apps/frontend/src/hooks/useUpcomingPlannedPayments.ts]], [[apps/frontend/src/pages/DashboardPage.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Electron-Native Desktop Integration (June 2026, ADR-072)

The original V12 integration added 11 keys. The cross-platform About follow-up adds `menu.about`, bringing the native group to 12 keys and the current locale source to **3,136 keys** per `generate-locales` on 2026-08-27.

**10 `menu.*` keys** — native desktop application menu labels:

| Key                      | EN                   |
| ------------------------ | -------------------- |
| `menu.settings`          | "Settings…"          |
| `menu.file`              | "File"               |
| `menu.newTransaction`    | "New Transaction"    |
| `menu.importCsv`         | "Import CSV…"        |
| `menu.edit`              | "Edit"               |
| `menu.view`              | "View"               |
| `menu.toggleSidebar`     | "Toggle Sidebar"     |
| `menu.go`                | "Go"                 |
| `menu.keyboardShortcuts` | "Keyboard Shortcuts" |
| `menu.about`             | "About {app}"        |

**2 new `settings.appearance.*` keys** — system accent color toggle:

| Key                                    | EN                                                        | NL                 |
| -------------------------------------- | --------------------------------------------------------- | ------------------ |
| `settings.appearance.systemAccent`     | "Use system accent color"                                 | (Dutch equivalent) |
| `settings.appearance.systemAccentHint` | "Match buttons and highlights to your macOS accent color" | (Dutch equivalent) |

**1 key reworded** — `settings.general.enhancedEffectsHint` updated to mention window translucency in addition to the WebGL aurora (en + nl). Note: this key was subsequently **removed** by ADR-075 (2026-06-12) along with `settings.general.enhancedEffects`.

Code links: [[packaging/electron/main.js]], [[apps/frontend/src/features/settings/sections/AppearanceSection.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Premium v3 V5-V7 batch (June 2026, ADR-071)

14 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2887 keys** (working-tree snapshot incl. 11 uncommitted V12 keys; 2876 committed).

**8 new `contextMenu.*` keys** — transaction row right-click menu:

| Key                                | EN                     |
| ---------------------------------- | ---------------------- |
| `contextMenu.info`                 | "Show details"         |
| `contextMenu.quickLook`            | "Quick Look"           |
| `contextMenu.editInline`           | "Edit in row"          |
| `contextMenu.duplicate`            | "Duplicate"            |
| `contextMenu.showAllFromRecipient` | "Show all from {name}" |
| `contextMenu.markActive`           | "Mark as active"       |
| `contextMenu.markInactive`         | "Mark as inactive"     |
| `contextMenu.delete`               | "Delete…"              |

**2 new `quickLook.*` keys** — Quick Look dialog:

| Key               | EN                     |
| ----------------- | ---------------------- |
| `quickLook.title` | "Quick Look"           |
| `quickLook.hint`  | "Press Space to close" |

**4 new `shortcuts.*` keys** — ShortcutsOverlay table-interaction rows:

| Key                   | EN                                                      |
| --------------------- | ------------------------------------------------------- |
| `shortcuts.tableNav`  | "Move between table rows"                               |
| `shortcuts.tableOpen` | "Open transaction details"                              |
| `shortcuts.quickLook` | "Quick Look the focused row"                            |
| `shortcuts.rowMenu`   | "Tip: right-click a transaction row for quick actions." |

Code links: [[apps/frontend/src/features/transactions/components/TransactionsTable.tsx]], [[apps/frontend/src/features/transactions/components/TransactionQuickLook.tsx]], [[apps/frontend/src/components/shared/ShortcutsOverlay.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

---

#### Premium v3 batch (June 2026, ADR-071)

8 new keys added to `i18n/source/en.json` + `nl.json`; `bun run generate-locales` + `validate-locales` clean. Total after this batch: **2854 keys**.

**2 `settings.general.*` keys** — Enhanced visual effects toggle (original ADR-071 batch; **removed by ADR-075 on 2026-06-12** — replaced by `settings.appearance.visualEffects*` / `autoAdaptDisplay*`):

| Key                                    | EN                                                        | NL                 | Status             |
| -------------------------------------- | --------------------------------------------------------- | ------------------ | ------------------ |
| `settings.general.enhancedEffects`     | "Enhanced visual effects"                                 | (Dutch equivalent) | Removed 2026-06-12 |
| `settings.general.enhancedEffectsHint` | "Enable WebGL aurora background (may increase GPU usage)" | (Dutch equivalent) | Removed 2026-06-12 |

**4 new `shortcuts.*` keys** — ShortcutsOverlay (`?` key dialog):

| Key                     | EN                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `shortcuts.title`       | "Keyboard Shortcuts"                                                                                                                           |
| `shortcuts.showHelp`    | "Show keyboard shortcuts"                                                                                                                      |
| `shortcuts.closeDialog` | "Close dialog"                                                                                                                                 |
| `shortcuts.chartScrub`  | "Drag on a chart to compare a range" (2026-08-09: extended to mention the keyboard path — focus a chart, ←/→ steps points, Shift+←/→ compares) |

**2 new `commandPalette.*` keys** — Palette v2 additions:

| Key                                 | EN                         |
| ----------------------------------- | -------------------------- |
| `commandPalette.recent`             | "Recent"                   |
| `commandPalette.searchTransactions` | "Search transactions for…" |

Code links: [[apps/frontend/src/components/shared/ShortcutsOverlay.tsx]], [[apps/frontend/src/features/settings/sections/GeneralSection.tsx]], [[apps/frontend/src/components/shared/CommandPalette.tsx]], [[i18n/source/en.json]], [[i18n/source/nl.json]]

#### Plural forms + PlannedPaymentsPage toasts (June 2026)

**Plural key variants** (`table.items`, `portfolio.investments`, `performance.holdings`) — see [[docs/i18n/translations#with-plural-forms--tc-june-2026|tc() section]] above.

**Removed key:** `performance.holdingsPlural` — migrate callers to `tc('performance.holdings', count)`.

**2 new error-toast keys for `PlannedPaymentsPage`** (native `alert()` replaced with `toast.error`):

| Key                        | EN                                 | NL                                             |
| -------------------------- | ---------------------------------- | ---------------------------------------------- |
| `plannedPage.toggleFailed` | "Failed to toggle planned payment" | "Geplande betaling kon niet worden gewijzigd"  |
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
- `export.period.invalidRange` — "The start date must be on or before the end date." (added 2026-08-25)
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

**Dutch terminology consistency (2026-08-25):**

- Standardized investment surfaces on `portefeuille` and its compounds, including navigation, performance, import, and transaction labels.
- Replaced the English calques `over tijd` and inconsistent all-time labels with `in de loop van de tijd` and `hele periode`.
- Aligned portfolio failure and refresh messages with the existing noun `belegging`, and clarified the spouse/partner disability-exemption label.
- Standardized recipient copy on `ontvanger`, watchlist targets on `doelkoers`, and shortcut actions on infinitive verb forms.
- Added `aiChat.toolFailed` as the localized fallback for tool results without structured error detail, and kept raw Ollama connection errors out of the primary setup hint.
- Preserved the single ellipsis glyph (`…`) through locale generation and replaced ASCII three-dot sequences in user-facing source strings.

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

Code links: [[i18n/source/en.json]], [[i18n/source/nl.json]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]], [[apps/frontend/src/features/onboarding/OnboardingWizard.tsx]]

### Step 3: Use in Component

```tsx
const { t } = useLanguage();

return <h1>{t("myComponent.greeting")}</h1>;
```

## Language Context

### LanguageContext API

```typescript
interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  tc: (
    key: string,
    count: number,
    vars?: Record<string, string | number>,
  ) => string;
}
```

### Setting Language

```tsx
// Set to Dutch
setLanguage("nl");

// Set to English
setLanguage("en");
```

## Supported Parameters

### Common Parameters

| Parameter  | Type   | Description       |
| ---------- | ------ | ----------------- |
| `{count}`  | number | Count for plurals |
| `{name}`   | string | User/entity name  |
| `{amount}` | number | Currency amounts  |
| `{date}`   | string | Date values       |

## Translation Coverage

### Checking Coverage

The English file (`en.json`) is the source of truth. All keys should exist in English.

### Missing Translations

If a Dutch (`nl`) translation is missing, the English string is used as the fallback. If a key is absent from **both** locale files (i.e., it was never added to `en.json`), `t()` returns the raw key string as-is — for example, `t('foo.bar')` renders literally as `"foo.bar"` in the UI. This silent rendering of raw keys was a known failure mode; as of 2026-06-26, `validate-locales` catches these at CI time via its source key-usage scan (see [[docs/i18n/translations#validation--validate-locales-checks|Validation — validate-locales checks]]).

## UI Components with i18n

### Buttons

```tsx
<Button>{t("form.submit")}</Button>
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
toast.success(t("toast.saved"));
toast.error(t("toast.error"));
```

## Currency & Number Formatting

### Number Format

Numbers are formatted based on locale:

```tsx
import { numberFormatToLocale } from "@/utils/currency";

const locale = numberFormatToLocale("en");
new Intl.NumberFormat(locale, {
  style: "currency",
  currency: "EUR",
}).format(1000.5);
// "€1,000.50"
```

### Date Formatting

Vision uses native `Intl.DateTimeFormat` for date formatting (Phase 5 slim-down removed date-fns). The `dateUtils.ts` helper module provides thin wrappers for common patterns:

```tsx
import { formatDate, formatDateTime } from "@/lib/dateUtils";

// Format a date in the current locale
formatDate(new Date());
// English: "3/18/2025"
// Dutch: "18-3-2025"

// Format with day name
formatDate(new Date(), { weekday: "long", month: "long", day: "numeric" });
// English: "March 18, 2025"
// Dutch: "18 maart 2025"
```

## Best Practices

### Product terminology and capitalization

- Use **investment** for the entity a user selects, imports, creates, or deletes. Use **holding** only for an owned position in an account, allocation, or performance context.
- In Dutch, use **belegging** for the investment entity and **positie** for an owned, open, or closed position.
- Use sentence case for English buttons, dialog titles, and action labels (`Add transaction`, `Add to watchlist`). Preserve normal capitalization for proper names and acronyms.

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
t("form.addTransaction.title");
t("form.addCategory.title");

// ❌ Inconsistent
t("form.addTransaction");
t("addCategoryTitle");
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

## Validation — `validate-locales` checks

`scripts/validate-locales.js` (run via `bun run validate-locales`) is the authoritative gate for locale correctness. It must pass before any commit that touches `i18n/source/` or frontend source files that call `t()`/`tc()`.

### Checks performed

The script runs all checks sequentially; any failure sets exit code 1 and blocks CI.

| Check                           | What it verifies                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **en ↔ nl parity**              | Every key in `en.json` exists in `nl.json` and vice versa.                                                                                                                                                                                                                                                                            |
| **Placeholder parity**          | Every `{var}` placeholder in an en string also appears in the nl string for the same key.                                                                                                                                                                                                                                             |
| **Type consistency**            | Values that are objects (plural containers) in one file are objects in the other.                                                                                                                                                                                                                                                     |
| **Key-existence** (source scan) | Every `t('a.b.c')` / `tc('a.b.c')` call in `apps/frontend/src/**/*.{ts,tsx}` whose first argument is a static, key-shaped string literal (`/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/`) must exist in `en.json`. Comments are stripped before scanning so JSDoc usage examples do not false-positive. Dynamic/computed keys are skipped. |
| **Dropped-vars** (source scan)  | For `t('k', { x })` / `tc('k', n, { x })` calls with a static object-literal vars argument, every passed variable must have a matching `{x}` placeholder in the en string. (`count` is always allowed for `tc()`.) Catches values that are silently discarded at runtime.                                                             |
| **Value-shape** (source scan)   | No locale value may itself be a dotted key-shaped string — e.g., `"foo.bar"` as a value is a sign of an untranslated key pasted in place of the real translation.                                                                                                                                                                     |
| **Unused keys** (source scan)   | Every exact locale key must have a static source reference, match an inferred dynamic translation prefix, or belong to the narrow Electron `app.*` dynamic prefix. `--list-unused` prints the current dead-key set.                                                                                                                   |
| **Generated-output drift**      | Compares generated frontend locales and any present, gitignored `packaging/electron/i18n/*.json` output against `i18n/source`. A stale Electron output names the generated file and tells the operator to run `bun run generate-locales`.                                                                                             |

On a clean run the script prints:

```
Locale validation passed: parity, placeholders, types, source key-usage, unused-key, and generated-output drift checks are all clean.
```

### When a check fails

| Failure                  | Fix                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key-existence error      | Add the missing key to both `en.json` and `nl.json`, then `bun run generate-locales`.                                                                         |
| Dropped-vars error       | Either add the `{var}` placeholder to the en/nl string, or remove the unused var from the call site.                                                          |
| Value-shape error        | Replace the dotted key string with the actual translated text.                                                                                                |
| Unused-key error         | Remove the orphaned key from both source locales, or make the intended static/dynamic-prefix consumer explicit. Run `--list-unused` to inspect the exact set. |
| Drift error              | Run `bun run generate-locales`; commit the regenerated frontend `.ts` files. Electron JSON is build output and remains untracked.                             |
| Parity/placeholder error | Sync the missing key or placeholder to the other locale file.                                                                                                 |

> [!info] Dynamic key-existence checks are conservative
> The key-existence pass skips template translation calls and fully computed translation calls because it cannot resolve one exact key. The unused-key pass separately infers static template-literal prefixes and conservatively keeps matching locale keys. Test fully computed call sites manually or through end-to-end tests.

Code link: [[scripts/validate-locales.js]]

## Related Documentation

- [[docs/i18n/index]] - i18n Index
- [[docs/components/index]] - Components using translations
- [MDN Intl.DateTimeFormat docs](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat)
