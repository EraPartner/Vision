---
title: API - Settings
type: endpoint
method: GET, PUT, DELETE
path: /api/settings
description: User preferences and application settings
date: 2026-06-19
updated: 2026-08-26
tags: [api, settings, preferences, phase-3, auto-link, planned-match, june-2026]
status: active
aliases: [settings-api, preferences-api, user-settings, app-settings]
related_code: [[apps/node-backend/src/routes/settings.js]], [[apps/node-backend/src/repositories/settingsRepository.js]], [[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx]]
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
- `excludedCategoryIds` and `excludedRecipientIds` must be arrays of positive integers — each element is validated by the shared `validateId` (a plain base-10 integer in 1..2,147,483,647), and one bad element rejects the whole request with `400 VALIDATION_ERROR` (`"<field> contains invalid value: <value>"`)
  - **Changed 2026-08-11:** elements were parsed with `parseInt`, so `excludedCategoryIds: ["12abc"]` was silently stored as `[12]` — the dashboard then excluded a category the user never chose, with no error shown. `"12abc"`, `"12.5"`, `"1e3"`, `"0x10"`, `" 5 "`, `"+5"` and `0` now all reject. Plain integers are unaffected. See [[docs/security/input-validation#Array Validation|Input Validation]].
- `excludeHiddenCategories` must be boolean
- `exclusionScope` must be one of `everywhere`, `dashboard`, `statistics`
- If `value` is missing from request body, endpoint returns `400` with `Missing "value" in request body`
- If `:key` length exceeds 100 chars, endpoint returns `400` with `Setting key too long (max 100 chars)`

Implementation note:
- Route-level `validateSettingValue` is reused by single-key and bulk upserts. Its `dashboard_settings` schema delegates each exclusion ID to `validateIntArray`, so coercion and rejection happen before the repository is called ([[apps/node-backend/src/routes/settings.js]]).
- The repository stores the already-validated value as JSONB and does not apply a second lossy `Number()` normalization pass. A malformed value therefore cannot become JSON `null` during persistence ([[apps/node-backend/src/repositories/settingsRepository.js]]).

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
- `204 No Content` with an empty body on success.
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
| rebalance_plans | array | Saved custom portfolio rebalancing plans (max 50 entries) |

### `rebalance_plans` shape (2026-06-19)

Array of saved custom portfolio rebalancing plans. Stored and retrieved via `GET/PUT /api/settings/rebalance_plans`.

**Default:** `[]`

**Element schema:**

```json
{
  "id": "string (UUID or user-generated, required)",
  "name": "string (1–80 chars, required)",
  "targetWeights": {
    "stocks": 40,
    "intl_stocks": 20,
    "bonds": 20,
    "gold": 5,
    "commodities": 5,
    "crypto": 5,
    "real_estate": 3,
    "savings": 2
  },
  "cashCap": 5000
}
```

**Fields:**

- **`id`** (string, required): Unique plan identifier.
- **`name`** (string, 1–80 chars, required): Human-readable label.
- **`targetWeights`** (object, required): Sleeve → non-negative target percentage. Values need not sum to 100%; the server's `normalizeWeights` function normalises them before deployment math runs. Valid sleeve keys match `crossWorkspaceDataService.js` `SLEEVE_ROLLUP`: `stocks`, `intl_stocks`, `bonds`, `gold`, `commodities`, `crypto`, `real_estate`, `savings`.
- **`cashCap`** (number ≥ 0, optional): Maximum spendable cash to deploy in a single rebalance run. Omit or pass `undefined` to deploy all available liquid cash.

**Validation errors** (`PUT /api/settings/rebalance_plans`):

| Condition | Response |
|-----------|----------|
| Value is not an array | `400` |
| Array has more than 50 elements | `400` |
| Any element missing `id` or `name` | `400` |
| `name` empty or longer than 80 chars | `400` |
| `targetWeights` missing or not a plain object | `400` |
| Any weight value is negative | `400` |
| `cashCap` present and negative | `400` |

Code links: [[apps/node-backend/src/routes/settings.js]] (`assertRebalancePlansValue`), [[apps/node-backend/tests/settingsStorage.test.js]], [[apps/frontend/src/hooks/useRebalancePlans.ts]], [[apps/frontend/src/lib/api/crossWorkspace.ts]]

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
  "language": "en",
  "autoClearPlannedOnMatch": true
}
```

**`autoClearPlannedOnMatch` (June 2026):** When `true` (default), an ingested transaction that unambiguously matches exactly one active unexecuted planned payment is automatically linked and that planned payment is executed (same path as a manual `POST /:id/execute`). Ambiguous matches (0 or ≥2 candidates) surface as confirmable suggestions via `GET /api/planned-transactions/match-suggestions`. Set to `false` to disable all auto-link behavior including suggestions. See [[docs/features/plannedTransactions#auto-link--auto-clear-on-ingest-june-2026|Planned Transactions: Auto-Link on Ingest]].

Code links: [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx]]

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

Code links: [[apps/frontend/src/styles/themes.ts]], [[apps/frontend/src/contexts/ThemeContext.tsx]], [[apps/frontend/src/features/settings/sections/AppearanceSection.tsx]], [[docs/features/appearance|Appearance Feature]]

### Current Frontend Coverage Notes

- `defaultCurrency` is actively consumed by planned payments, portfolio add-investment defaults/resets, and currency formatting surfaces
- Portfolio add-investment submit + initial buy transaction currency fallbacks now also derive from `defaultCurrency` (no fixed EUR fallback)
- `defaultPageSize` is enforced by recipient-insights paging/load-more behavior
- `showDecimalPlaces` is applied by statistics and tax-related currency displays

Code links: [[apps/frontend/src/features/planned/PlannedPaymentForm.tsx]], [[apps/frontend/src/hooks/usePlannedPayments.ts]], [[apps/frontend/src/features/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/features/statistics/RecipientInsightsTab.tsx]], [[apps/frontend/src/pages/StatisticsPage.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/features/tax/SuggestedDeductionsCard.tsx]], [[apps/frontend/src/features/portfolio/PortfolioTaxAdjustmentsDialog.tsx]]

### Frontend Formatting Helpers

Shared date utilities include app-settings-aware date-time helpers used by settings propagation across date/time labels.

Code links: [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx]], [[apps/frontend/src/components/notifications/UpdateNotification.tsx]], [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/research/MarketLookupPage.tsx]]

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
