---
title: Localization Documentation Index
type: i18n-index
status: active
date: 2026-03-31
tags: [i18n, index, localization, translations]
description: Internationalization system including supported languages, translation workflow, and usage patterns
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

## Recent Key Additions (Portfolio/Metals + News)

Added in source JSON and regenerated locale bundles (`apps/frontend/src/locales/en.ts`, `apps/frontend/src/locales/nl.ts`):

- `addInv.desc.metals`
- `addWatchlist.metals`
- `metals.title`
- `metals.noMetals`
- `metals.noMetalsDesc`
- `nav.metals`
- `portfolio.assetClass.metals`
- `portfolio.assetGroup.metals`

Source-of-truth reminder: translation keys are maintained in `i18n/source/*.json`; generated frontend locale bundles are derived artifacts and should be regenerated after key changes.

Code links: [[i18n/source/en.json]], [[i18n/source/nl.json]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]]

## Key Naming Convention

```
{component}.{section}.{element}

Examples:
- nav.dashboard
- form.addTransaction.title
- errors.amount.required
```
