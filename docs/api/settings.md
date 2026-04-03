---
title: API - Settings
type: endpoint
method: GET, PUT, DELETE
path: /api/settings
description: User preferences and application settings
date: 2026-04-02
tags: [api, settings, preferences]
status: active
aliases: [settings-api, preferences-api, user-settings, app-settings]
related_code: [[apps/node-backend/src/routes/settings.js]], [[apps/node-backend/src/repositories/settingsRepository.js]]
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

### PUT /api/settings

Bulk create/update multiple settings in one request.

Storage behavior:
- Each key is serialized and cast with `::jsonb` before upsert for consistent JSONB persistence

**Request Body:**
```json
{
  "app_settings": {
    "defaultCurrency": "EUR",
    "language": "en"
  },
  "theme_settings": {
    "theme": "system",
    "accentColor": "default"
  }
}
```

### DELETE /api/settings/:key

Delete a setting key.

## Common Settings

| Key | Type | Description |
|-----|------|-------------|
| app_settings | object | User-facing app preferences (currency, date format, language, etc.) |
| dashboard_settings | object | Dashboard/stats exclusions and exclusion scope |
| theme_settings | object | Theme mode and accent preferences |
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
- [[docs/features/views|Views & Pages]] - How settings affect page rendering
- [[docs/components/form-dialogs|Form Dialogs]] - Settings propagation to forms
- [[docs/guides/backend-configuration|Backend Configuration]] - Server-side config vs user settings
