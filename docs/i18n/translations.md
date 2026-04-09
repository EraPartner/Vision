---
title: Translations & i18n
type: i18n
status: active
date: 2026-04-04
tags: [i18n, translations, localization, internationalization]
description: Internationalization system including supported languages, translation workflow, and usage patterns
aliases: [i18n, translations, localization, language, nl, en, dutch, english]
related_code: ["apps/frontend/src/locales", "apps/frontend/src/contexts/LanguageContext.tsx"]
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
// t() function signature
t(key: string, params?: Record<string, string | number>): string
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
| `settings.*` | Settings labels | `settings.language` |

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

### Recent keys added in this task

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

These keys were added in `i18n/source/en.json` and `i18n/source/nl.json`, then regenerated into `apps/frontend/src/locales/en.ts` and `apps/frontend/src/locales/nl.ts` (including provider-hint updates for `binance`/`kinesis` and the planned-page date-picker label).

Code links: [[i18n/source/en.json]], [[i18n/source/nl.json]], [[apps/frontend/src/locales/en.ts]], [[apps/frontend/src/locales/nl.ts]], [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]]

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

```tsx
import { format } from "date-fns";
import { nl, enUS } from 'date-fns/locale';

const locale = language === 'nl' ? nl : enUS;
format(new Date(), 'PPP', { locale });
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
- [date-fns locale docs](https://date-fns.org/docs/Locale)
