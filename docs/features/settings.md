---
title: Settings Feature
type: feature
status: active
date: 2026-04-09
tags: [feature, settings, configuration, preferences, frontend, backend]
description: Application settings system with JSONB storage, preload optimization, and propagation across all pages
aliases: [preferences, configuration, app settings, user settings]
related_code:
  - apps/frontend/src/contexts/AppSettingsContext.tsx
  - apps/frontend/src/contexts/SettingsContext.tsx
  - apps/frontend/src/contexts/SettingsPreloadContext.tsx
  - apps/node-backend/src/routes/settings.js
  - apps/node-backend/src/repositories/settingsRepository.js
---

# Settings Feature

## Overview

The Settings system manages all application preferences, from display formatting (currency, date format, number format) to behavioral settings (exclusions, pagination defaults, widget visibility). It uses a three-layer context architecture for optimal loading performance and a JSONB-backed storage system.

## Architecture

### Three-Layer Context System

```
SettingsPreloadContext → SettingsContext → AppSettingsContext
     (preload)              (raw data)        (processed)
```

1. **SettingsPreloadContext**: Fetches settings before the app renders, preventing flash of unstyled content. Provides `usePreloadedSetting(key)` for direct access to individual settings.

2. **SettingsContext**: Manages the raw settings data from the API. Provides `settings` object with all key-value pairs and methods for individual/bulk updates.

3. **AppSettingsContext**: Processes raw settings into a typed `appSettings` object with defaults applied. Provides `useAppSettings()` hook.

### Settings Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultCurrency` | string | `'EUR'` | Default display currency |
| `numberFormat` | string | `'european'` | Number formatting style |
| `showDecimalPlaces` | number | `2` | Decimal places for display |
| `dateFormat` | string | `'dd/MM/yyyy'` | Date display format |
| `defaultPageSize` | number | `50` | Default table page size |
| `excludedCategoryIds` | number[] | `[]` | Categories to exclude from stats |
| `excludedRecipientIds` | number[] | `[]` | Recipients to exclude from stats |
| `excludeHiddenCategories` | boolean | `false` | Exclude inactive categories |
| `exclusionScope` | string | `'nowhere'` | Where exclusions apply |
| `theme_settings` | object | `{variant: 'default', mode: 'system'}` | Theme variant and mode preferences |
| `widget_visibility` | object | `{}` | Per-page widget visibility |
| `portfolio_tax_adjustments_v1` | object | `{}` | Manual tax adjustments |
| `backup_settings` | object | `{}` | Backup configuration |

## Backend Storage

### Settings Repository

Located at `[[apps/node-backend/src/repositories/settingsRepository.js]]`:

- **Storage format**: JSONB column in `settings` table
- **Key-based access**: Individual settings accessed by key
- **Default values**: Defaults applied at the application layer, not in the database

### API Endpoints

Located at `[[apps/node-backend/src/routes/settings.js]]`:

#### GET /api/settings

Returns all settings as a key-value object.

#### GET /api/settings/:key

Returns a single setting by key.

#### PUT /api/settings/:key

Upserts a single setting.

**Request body:**
```json
{ "value": "EUR" }
```

Implementation note:
- Backend route logic now reuses shared key-length and `dashboard_settings` normalization/validation helpers across single-key and bulk writes (`validateSettingKeyLength`, `getSettingKeyTooLongError`, `normalizeDashboardSettingsValue`) without changing API behavior.
- Backend repository normalization now avoids mutating caller-provided setting objects in place by normalizing through a shallow clone, preserving stored JSON output while reducing side-effect risk in calling code (`normalizeSettingValue`) ([[apps/node-backend/src/repositories/settingsRepository.js]]).

#### PUT /api/settings (bulk)

Bulk upserts multiple settings.

**Request body:**
```json
{
  "defaultCurrency": "EUR",
  "dateFormat": "dd/MM/yyyy"
}
```

#### DELETE /api/settings/:key

Deletes a single setting (reverts to default).

## Frontend API Client

Located in `[[apps/frontend/src/lib/api.ts]]`:

```typescript
async getSettings(): Promise<Record<string, any>>
async getSetting(key: string): Promise<{ key: string; value: any }>
async saveSetting(key: string, value: any): Promise<{ key: string; value: any }>
async saveSettingsBulk(settings: Record<string, any>): Promise<{ saved: number }>
```

## Widget Visibility System

The `useWidgetVisibility` hook manages per-page widget visibility settings:

```typescript
const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults } =
  useWidgetVisibility('statistics', STATISTICS_WIDGETS);
```

- **Page-scoped**: Each page has its own visibility state (e.g., `'statistics'`, `'portfolioTax'`)
- **Persisted**: Saved to `widget_visibility` setting key
- **Defaultable**: Each widget defines its own `defaultVisible` state
- **Resettable**: Can reset all widgets to their defaults

## Exclusion System

Settings control which categories and recipients are excluded from statistics:

- **`excludedCategoryIds`**: Array of category IDs to exclude
- **`excludedRecipientIds`**: Array of recipient IDs to exclude
- **`excludeHiddenCategories`**: Auto-exclude inactive categories
- **`exclusionScope`**: Controls where exclusions apply:
  - `'everywhere'`: All pages
  - `'statistics'`: Statistics and related pages only
  - `'nowhere'`: Exclusions disabled

## Propagation Behavior

Settings changes propagate throughout the application:

| Setting | Affected Areas |
|---------|---------------|
| `defaultCurrency` | All currency displays, portfolio pages, net worth, tax |
| `numberFormat` | All number formatting (European vs US) |
| `showDecimalPlaces` | All currency displays |
| `dateFormat` | All date displays, chart labels |
| `defaultPageSize` | VirtualDataTable pagination |
| `excludedCategoryIds` | Statistics, dashboard, charts |
| `excludedRecipientIds` | Statistics, recipient insights |

## Performance Optimizations

1. **Preload context**: Settings are fetched before the app renders, avoiding flash of defaults
2. **Individual setting access**: `usePreloadedSetting(key)` allows components to access specific settings without subscribing to the full settings object
3. **Default application**: Defaults are applied at the context level, not per-component
4. **Bulk updates**: Multiple settings can be saved in a single API call

## Corrupt Settings Recovery (Electron)

In Electron desktop builds, the application persists settings to a local `settings.json` file. If this file becomes corrupted (e.g., due to a crash during write):

**Recovery behavior:**
- App detects JSON parse error on startup
- Quarantines the corrupted file as `settings.json.corrupt-<ISO-timestamp>`
- Returns application defaults
- App continues startup normally

**User experience:**
- Settings are reset to defaults (one-time)
- Corrupted file is preserved for forensics
- User can manually restore from backup if needed

**Example quarantine:**
```
settings.json.corrupt-2026-04-19T14-30-45-123Z
```

This automatic recovery prevents startup failure while preserving the corrupted file for debugging.

## Related Features

- [[docs/features/appearance|Appearance]] — Theme variant, color palette mode, and schedule settings
- [[docs/features/statistics|Statistics]] — Uses exclusions and currency settings
- [[docs/features/portfolio-tax|Portfolio Tax]] — Uses tax adjustments stored as settings
- [[docs/features/views|Dashboard]] — Uses widget visibility settings
