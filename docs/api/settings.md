---
title: API - Settings
type: endpoint
method: GET, PUT, DELETE
path: /api/settings
description: User preferences and application settings
date: 2026-04-23
tags: [api, settings, preferences, phase-3]
status: active
aliases: [settings-api, preferences-api, user-settings, app-settings]
related_code: [[apps/node-backend/src/routes/settings.js]], [[apps/node-backend/src/repositories/settingsRepository.js]], [[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx]]
---

# Settings API

## Overview

The Settings API manages user preferences stored as key-value JSON. Settings can be read in bulk, fetched by key with defaults for known keys, updated individually or in bulk, and deleted.

## Endpoints

### GET /api/settings

Get all settings.

**Response:**
```json
{
  "theme": "dark",
  "language": "en",
  "currency": "EUR",
  "date_format": "DD/MM/YYYY"
}
```

### GET /api/settings/:key

Get a specific setting.

If a known setting key is missing, the API returns a default value instead of a 404.

**Example response:**
```json
{
  "key": "widget_visibility",
  "value": {}
}
```

### PUT /api/settings/:key

Create or update a single setting value.

Storage behavior:
- Backend serializes all values with `JSON.stringify(...)` and writes them as `$2::jsonb`
- This guarantees valid JSONB for primitive arrays (for example `dismissed_recurring_patterns: [373]`) and avoids malformed payloads like `{"373"}`

**Request Body:**
```json
{
  "value": {
    "excludedCategoryIds": [12, 18],
    "excludedRecipientIds": [4],
    "excludeHiddenCategories": true,
    "exclusionScope": "everywhere"
  }
}
```

**Validation notes for `dashboard_settings`:**
- `excludedCategoryIds` and `excludedRecipientIds` must be arrays of positive integers
- `excludeHiddenCategories` must be boolean
- `exclusionScope` must be one of `everywhere`, `dashboard`, `statistics`
- If `value` is missing from request body, endpoint returns `400` with `Missing "value" in request body`
- If `:key` length exceeds 100 chars, endpoint returns `400` with `Setting key too long (max 100 chars)`

Implementation note:
- Route-level validation was refactored into shared helpers (`validateSettingKeyLength`, `getSettingKeyTooLongError`, `normalizeDashboardSettingsValue`) reused by single-key and bulk upsert endpoints while preserving endpoint-specific error-message text and validation semantics ([[apps/node-backend/src/routes/settings.js]]).
- Repository normalization (`normalizeSettingValue`) now uses a shallow-clone strategy for object values, avoiding in-place mutation of caller-provided payload objects while preserving stored JSONB output and validation behavior ([[apps/node-backend/src/repositories/settingsRepository.js]]).

### PUT /api/settings

Bulk create/update multiple settings in one request.

Storage behavior:
- Each key is serialized and cast with `::jsonb` before upsert for consistent JSONB persistence

Validation behavior:
- Body must be a JSON object (`400` for arrays/non-objects)
- Any key longer than 100 chars returns `400` and includes the offending key in the detail text
- `dashboard_settings` is normalized/validated during bulk upsert (`excludedCategoryIds` / `excludedRecipientIds` positive-int arrays)
- `theme_settings` is validated for variant ∈ {default, dracula, solarized, nord, high-contrast}, mode ∈ {light, dark, system, schedule}, and schedule times (if mode is 'schedule') match `HH:MM`

**Request Body:**
```json
{
  "app_settings": {
    "defaultCurrency": "EUR",
    "language": "en"
  },
  "theme_settings": {
    "variant": "default",
    "mode": "system"
  }
}
```

### DELETE /api/settings/:key

Delete a setting key.

Response semantics:
- Returns `404` with `Setting '<key>' not found` when deleting a non-existing key.

## Common Settings

| Key | Type | Description |
|-----|------|-------------|
| app_settings | object | User-facing app preferences (currency, date format, language, etc.) |
| dashboard_settings | object | Dashboard/stats exclusions and exclusion scope |
| theme_settings | object | Theme variant, mode, and optional schedule settings |
| backup_settings | object | Desktop backup directory and backup-on-quit behavior |
| widget_visibility | object | Per-page widget visibility state |
| onboarding_complete | boolean | First-run onboarding completion state |
| dismissed_recurring_patterns | array | IDs/patterns dismissed from recurring suggestions |

### `app_settings` shape (frontend)

Typical fields persisted in `app_settings`:

```json
{
  "defaultCurrency": "EUR",
  "dateFormat": "DD/MM/YYYY",
  "numberFormat": "eu",
  "defaultPageSize": 50,
  "startOfWeek": "monday",
  "showDecimalPlaces": 2,
  "language": "en"
}
```

Code links: [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx]]

### `theme_settings` shape (appearance)

Per-user theme variant, color palette mode, and optional schedule for mode transitions:

```json
{
  "variant": "default|dracula|solarized|nord|high-contrast",
  "mode": "light|dark|system|schedule",
  "schedule": {
    "lightFrom": "HH:MM",
    "darkFrom": "HH:MM"
  }
}
```

**Fields:**

- **`variant`** (string, required): One of five curated color palettes. Defaults to `'default'` (Apple liquid glass with emerald + gold).
- **`mode`** (string, required): Theme display mode.
  - `'light'`: Always light palette
  - `'dark'`: Always dark palette
  - `'system'`: Follow OS dark-mode preference
  - `'schedule'`: Switch based on time; requires `schedule` object
- **`schedule`** (object, optional): Only required if `mode` is `'schedule'`.
  - `lightFrom` (string): Time in `HH:MM` (24-hour) when light theme starts
  - `darkFrom` (string): Time in `HH:MM` (24-hour) when dark theme starts

**Validation:**

- `variant` must be one of the five allowed values; invalid value returns `400`
- `mode` must be `'light'`, `'dark'`, `'system'`, or `'schedule'`; invalid value returns `400`
- If `mode` is `'schedule'`, `schedule.lightFrom` and `schedule.darkFrom` must match regex `/^\d{2}:\d{2}$/` and represent valid 24-hour times
- Missing `schedule` when `mode` is `'schedule'` returns `400`

**Example requests:**

Light theme only:
```json
{
  "variant": "solarized",
  "mode": "light"
}
```

System mode (follow OS):
```json
{
  "variant": "nord",
  "mode": "system"
}
```

Scheduled mode (light 6 AM – 8 PM, dark 8 PM – 6 AM):
```json
{
  "variant": "dracula",
  "mode": "schedule",
  "schedule": {
    "lightFrom": "06:00",
    "darkFrom": "20:00"
  }
}
```

Code links: [[apps/frontend/src/styles/themes.ts]], [[apps/frontend/src/contexts/ThemeContext.tsx]], [[apps/frontend/src/components/settings/AppearanceTab.tsx]], [[docs/features/appearance|Appearance Feature]]

### Current Frontend Coverage Notes

- `defaultCurrency` is actively consumed by planned payments, portfolio add-investment defaults/resets, and currency formatting surfaces
- Portfolio add-investment submit + initial buy transaction currency fallbacks now also derive from `defaultCurrency` (no fixed EUR fallback)
- `defaultPageSize` is enforced by recipient-insights paging/load-more behavior
- `showDecimalPlaces` is applied by statistics and tax-related currency displays

Code links: [[apps/frontend/src/components/planned/PlannedPaymentForm.tsx]], [[apps/frontend/src/hooks/usePlannedPayments.ts]], [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/pages/RecipientInsightsPage.tsx]], [[apps/frontend/src/components/statistics/RecipientInsightsTab.tsx]], [[apps/frontend/src/pages/StatisticsPage.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/components/tax/SuggestedDeductionsCard.tsx]], [[apps/frontend/src/components/portfolio/PortfolioTaxAdjustmentsDialog.tsx]]

### Frontend Formatting Helpers

Shared date utilities include app-settings-aware date-time helpers used by settings propagation across date/time labels.

Code links: [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx]], [[apps/frontend/src/components/notifications/UpdateNotification.tsx]], [[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]]

## Related

- [[docs/adr/002-database-schema|Database Schema]] - `user_settings` table definition
- [[docs/adr/025-theme-variant-system|ADR-025: Theme Variant System]] - Theme variant architecture and implementation
- [[docs/features/settings|Settings Feature]] - Overview of settings system
- [[docs/features/appearance|Appearance Feature]] - Theme variant and mode selection UI
- [[docs/features/views|Views & Pages]] - How settings affect page rendering
- [[docs/components/form-dialogs|Form Dialogs]] - Settings propagation to forms
- [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog]] - Settings UI component (Phase 3 refactor)
- [[docs/guides/backend-configuration|Backend Configuration]] - Server-side config vs user settings
- [[docs/testing/testing|Testing Documentation]] - Branch-level settings route validation coverage
- Coverage code links: [[apps/node-backend/tests/routes/settings.test.js]], [[apps/node-backend/tests/validation.test.js]]
- Coverage follow-up (2026-04-11): settings route tests now also cover GET all/key behavior, known-default fallback, unknown-key `404`, and success/error branches for single PUT, bulk PUT, and DELETE.
- Coverage follow-up (2026-04-20): settings route tests now also cover `theme_settings` variant/mode/schedule validation and persistence.
