---
title: Localization Documentation Index
type: i18n-index
status: active
date: 2026-04-24
updated: 2026-05-29
tags: [i18n, index, localization, translations, phase-6, phase-f, admin, observability, splits, settlement, chart-aria, screen-reader, accessibility, aria-label]
description: Internationalization system including supported languages, translation workflow, and usage patterns. Phase 6 adds 32 export keys for PDF report export dialog. Phase F adds 60 admin observability keys. 2026-05-29 adds 16 chart.aria.* keys (localized chart screen-reader summaries) and 21 aria.* keys (localized icon-button aria-labels).
aliases: [i18n, localization, translations, languages]
---

# Localization Documentation

> [!abstract] Overview
> Internationalization (i18n) in Vision. The app supports multiple languages with a JSON-based translation workflow.

## Documentation

```dataview
TABLE title, description
FROM "docs/i18n"
WHERE type = "i18n"
SORT title ASC
```

## Quick Reference

| Topic | Description |
|-------|-------------|
| [[docs/i18n/translations|Translations & i18n]] | Complete i18n guide |

## Supported Languages

| Language | Code | Status |
|----------|------|--------|
| **English** | `en` | Default - Full support |
| **Dutch** | `nl` | Full support |

## Translation Files

Located in `i18n/source/`:

```
i18n/
└── source/
    ├── en.json      # English (source of truth)
    └── nl.json      # Dutch translations

apps/frontend/src/
└── locales/
    ├── en.ts        # Generated
    └── nl.ts        # Generated
```

## Usage

The frontend uses `LanguageContext` (`apps/frontend/src/contexts/LanguageContext.tsx`) to manage locale state.

```tsx
import { useLanguage } from "@/contexts/LanguageContext";

function Component() {
  const { t, language, setLanguage } = useLanguage();
  
  return (
    <div>
      <h1>{t('page.title')}</h1>
      <button onClick={() => setLanguage('nl')}>
        Nederlands
      </button>
    </div>
  );
}
```

## Adding Translations

1. Add keys to `i18n/source/en.json`
2. Add corresponding keys to `i18n/source/nl.json`
3. Build to generate `.ts` files
4. Use in components via `useLanguage()` hook

## Recent Key Additions

### Chart Screen-Reader + aria-label i18n (2026-05-29)

Added 37 new keys remediating audit findings [[docs/reference/codebase-audit-2026-05#ux.4|ux.4]] and [[docs/reference/codebase-audit-2026-05#ux.5|ux.5]]:

- **16 `chart.aria.*` keys** — `chartAria.ts` chart screen-reader summary generators now accept `t` + `kindKey`. All 6 chart components call `useLanguage()`. Keys cover kind labels, series/segment counts, sparkline descriptions, and "and N more" overflow. Dutch equivalents added to `nl.json`.
- **21 `aria.*` keys** — Icon-only interactive elements across pages, features, and shared components now use `t('aria.*')` instead of hardcoded English strings. Covers delete, edit, save, cancel, close, clear, dismiss, select-all, sidebar toggles, remove-entry, remove-from-watchlist, and transaction-info labels.

See [[docs/i18n/translations#chart.aria and aria namespaces (2026-05-29)|translations — chart.aria and aria namespaces]].

### Splits Settlement (2026-04-27)

Added 2 new keys for splits settlement toast notifications:

- `splits.settled` — "Splits settled" (en) / "Splits verrekend" (nl) — Success toast when settlement completes
- `splits.settledFailed` — "Failed to settle splits" (en) / "Splits verrekenen mislukt" (nl) — Error toast on settlement failure

Used in [[apps/frontend/src/hooks/useSplits.ts]] by `useSettleSplit()` hook for user feedback when settling individual splits via the `/owes` page.

### Phase F (2026-04-24) — Admin Environment i18n

Added ~60 new keys for the admin observability hub (Phase F):

- Settings toggle: `settings.app.adminMode`, `settings.app.adminModeHint`, `settings.app.developer`
- Navigation: `nav.admin`, `nav.adminOverview`, `nav.adminProviders`, `nav.adminEndpoints`
- Overview page: `admin.overview.{title,description,dbSize,tables,dataSources,failing,endpoints,errorRate,requests,allHealthy}`
- Data Sources page: `admin.providers.{title,description,tableTitle,colProvider,colKind,colLastSuccess,colLastError,colFailures,never,checkNow,probeOk,probeFail,probeError}`
- Endpoints page: `admin.endpoints.{title,description,tableTitle,colPath,colMethod,colRequests,colErrors,colErrorRate,colP50,colP95,filterPlaceholder}`

> The Feature Flags admin page and its `admin.flags.*` / `nav.adminFeatureFlags` / `admin.overview.{featureFlags,flagsEnabled}` keys were removed alongside the runtime feature-flag system in [[docs/adr/035-remove-feature-flags|ADR-035]].

All keys added to `i18n/source/en.json` and `i18n/source/nl.json`; generated into frontend locale bundles.

### Phase 6 (2026-04-24) — PDF Report Export i18n

Added 32 new keys for the PDF export dialog and report feature (Phase 6):

- Export dialog: `export.title`, `export.description`, `export.openDialog`
- Report type selection: `export.reportType`, `export.reportType.{financial,portfolio,tax}`
- Period selection: `export.period`, `export.period.{ytd,rolling3,rolling12,year,custom}`, `export.period.{from,to,year.label}`
- Section toggles: `export.sections`, `export.sections.all`, `export.section.{executiveSummary,cashflowTrend,categoryBreakdown,topRecipients,bankBalances,rollingAverages,plannedOutlook,portfolioAllocation,topHoldings,taxBreakdown}`
- Currency & actions: `export.{currency,download,downloading,comingSoon}`

All keys added to `i18n/source/en.json` and `i18n/source/nl.json`; generated into `apps/frontend/src/locales/en.ts` and `nl.ts`.

### Portfolio/Metals + News (Earlier phases)

- `addInv.desc.metals`
- `addWatchlist.metals`
- `metals.title`
- `metals.noMetals`
- `metals.noMetalsDesc`
- `nav.metals`
- `portfolio.assetClass.metals`
- `portfolio.assetGroup.metals`
- `plannedPage.link.pickDate`

Source-of-truth reminder: translation keys are maintained in `i18n/source/*.json`; generated frontend locale bundles are derived artifacts and should be regenerated after key changes.

Code links: [[i18n/source/en.json]], [[i18n/source/nl.json]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]], [[apps/frontend/src/components/reports/ExportDialog.tsx]]

## Key Naming Convention

```
{component}.{section}.{element}

Examples:
- nav.dashboard
- form.addTransaction.title
- errors.amount.required
```
