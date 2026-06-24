---
title: Settings Feature
type: feature
status: active
date: 2026-06-19
updated: 2026-06-24
tags: [feature, settings, configuration, preferences, frontend, backend, refactor, phase-3, phase-4, zustand, store, backup, encrypt, passphrase, phase-2, auto-link, planned-match, june-2026, instant-apply, sidebar, accessibility, colorblind, gain-loss]
description: Application settings system with JSONB storage, preload optimization, propagation across all pages, and sidebar-navigated instant-apply DashboardSettingsDialog UI (ADR-084).
aliases: [preferences, configuration, app settings, user settings]
related_code:
  - apps/frontend/src/stores/settingsStore.ts
  - apps/frontend/src/components/settings/DashboardSettingsDialog.tsx
  - apps/frontend/src/components/settings/SettingsPrimitives.tsx
  - apps/frontend/src/components/settings/sections/GeneralSection.tsx
  - apps/frontend/src/components/settings/sections/AppearanceSection.tsx
  - apps/frontend/src/components/settings/sections/StatisticsSection.tsx
  - apps/frontend/src/components/settings/sections/BehaviorSection.tsx
  - apps/frontend/src/components/settings/sections/AiSection.tsx
  - apps/frontend/src/components/settings/sections/BackupSection.tsx
  - apps/frontend/src/components/settings/sections/AboutSection.tsx
  - apps/frontend/src/components/settings/AIChatSettingsSection.tsx
  - apps/frontend/src/contexts/AppSettingsContext.tsx
  - apps/frontend/src/contexts/SettingsContext.tsx
  - apps/frontend/src/contexts/SettingsPreloadContext.tsx
  - apps/frontend/src/contexts/ThemeContext.tsx
  - apps/node-backend/src/routes/settings.js
  - apps/node-backend/src/repositories/settingsRepository.js
---

# Settings Feature

## Overview

The Settings system manages all application preferences, from display formatting (currency, date format, number format) to behavioral settings (exclusions, pagination defaults, widget visibility). It uses a three-layer context architecture for optimal loading performance and a JSONB-backed storage system.

The Settings dialog was reworked in June 2026 from a 5-tab Save/Cancel form into a **sidebar-navigated, instant-apply** surface. See [[docs/adr/084-settings-instant-apply-sidebar|ADR-084]] for full rationale.

## Architecture

### Zustand Settings Store (Phase 4)

All application settings are managed by a unified **Zustand store** located at `[[apps/frontend/src/stores/settingsStore.ts|settingsStore.ts]]`. This store consolidates three previously separate React contexts:

- **AppSettingsContext** (app_settings key)
- **SettingsContext** (dashboard_settings key)
- **ThemeContext** (theme_settings key)

The Provider components in each context file still exist as thin wrappers to handle:
- Hydration from SettingsPreloadContext
- Debounced persistence back to the API (500 ms)
- DOM side-effects (ThemeContext: CSS class, matchMedia, interval)

Consumer hooks (`useAppSettings`, `useSettings`, `useTheme`) use `useShallow()` to select only the slice they need, preventing unnecessary re-renders when unrelated slices change.

**Three-Layer Context System (now wrapping Zustand)**

```
SettingsPreloadContext → SettingsContext/AppSettingsContext/ThemeContext
     (preload)                 (wrapper providers)
          ↓
        useSettingsStore (Zustand)
     (source of truth)
```

1. **SettingsPreloadContext**: Fetches settings before the app renders, preventing flash of unstyled content.

2. **Zustand Store**: Single source of truth for all settings state. Exports:
   - `useSettingsStore` — Direct access to full store
   - Actions: `updateAppSettings`, `updateDashboardSettings`, `setThemeMode`, `setTheme`, `toggleTheme`, etc.
   - Slices: `appSettings`, `dashboardSettings`, `theme`, `themeMode`, `themeSchedule`, `themeVariant`

3. **Context Wrappers** (AppSettingsContext, SettingsContext, ThemeContext): Provide convenience hooks that use `useShallow()` to subscribe to store slices. Example:
   ```typescript
   export const useAppSettings = () => {
     return useSettingsStore(useShallow(s => ({ ...s.appSettings, isLoading: s.isAppSettingsLoading })));
   };
   ```

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
| `rebalance_plans` | array | `[]` | Saved custom rebalancing plans (max 50); each entry `{ id, name, targetWeights, cashCap? }` — see [[docs/adr/098-cross-workspace-features\|ADR-098]] |
| `startupSection` | `StartupSection` | `'budgeting'` | Section the app navigates to at launch (field within the `app_settings` JSONB blob) |
| `autoClearPlannedOnMatch` | boolean | `true` | When `true`, automatically links and executes a planned payment when an ingested transaction unambiguously matches it. When `false`, auto-link is disabled entirely (no suggestions surface either). See [[docs/features/plannedTransactions#auto-link--auto-clear-on-ingest-june-2026\|Planned Transactions: Auto-Link on Ingest]]. |
| `colorblindGainLoss` | boolean | `false` | When `true`, applies the Okabe-Ito colorblind-safe gain/loss palette (green gain / orange loss, `.skin-v2` root class). When `false` (default), uses the classic gold gain (`--gain: var(--accent)`) / red loss (`--loss: var(--destructive)`) palette. Controlled via **Settings → Appearance → Accessibility → Gain & loss colors**. Persisted in the `app_settings` JSONB blob; `AppSettingsProvider` calls `setSkinV2(appSettings.colorblindGainLoss)` on hydration and on change. See [[docs/adr/104-skin-v2-dense-fintech-visual-redesign\|ADR-104 addendum]]. |

## Startup Section

The `startupSection` field controls which top-level section the app opens on immediately after launch. It is persisted as a field inside the existing `app_settings` JSONB blob — no separate backend setting key and no migration are required.

**Type definition (from `[[apps/frontend/src/stores/settingsStore.ts]]`):**

```typescript
type StartupSection = 'budgeting' | 'portfolio' | 'research' | 'ai-chat';
```

**Section → home-page mapping:**

| Value | Navigates to |
|-------|-------------|
| `'budgeting'` | `/` (default, no redirect) |
| `'portfolio'` | `/portfolio` |
| `'research'` | `/research` |
| `'ai-chat'` | `/ai-chat` |

**Redirect behavior** is handled by `[[apps/frontend/src/components/shared/StartupRedirect.tsx]]`, mounted inside `<BrowserRouter>` in `App.tsx`. It fires once, after settings hydrate, and only when the app opened at the root path `/`. It calls `navigate(..., { replace: true })` so the redirect does not create a history entry. Deep links (any non-`/` initial path) and later in-app navigation back to `/` are unaffected.

**UI:** a "Open app on" Select is located in the **Behavior** section of `DashboardSettingsDialog` (`[[apps/frontend/src/components/settings/sections/BehaviorSection.tsx]]`). The option labels reuse `nav.*` i18n keys. Two i18n keys cover the label and hint: `settings.general.startupSection`, `settings.general.startupSectionHint`.

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

## Frontend UI (DashboardSettingsDialog)

> [!info] Reworked June 2026 (ADR-084)
> The settings dialog was a 5-tab Save/Cancel form (`General`, `Appearance`, `Dashboard`, `App`, `Backup`). It is now a **sidebar-navigated, instant-apply** surface. See [[docs/adr/084-settings-instant-apply-sidebar|ADR-084]] for full rationale.

The primary UI is `[[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx|DashboardSettingsDialog]]`, which acts as a **sidebar shell orchestrator**: a left rail of seven section icons/labels, and a scrollable content pane on the right. Each section component is self-contained — it reads from hooks and writes directly to the store or API, so the orchestrator no longer threads staged props.

**Shared layout primitives** live in `[[apps/frontend/src/components/settings/SettingsPrimitives.tsx|SettingsPrimitives.tsx]]`:
- `SettingsSection` — title + description header
- `SettingsGroup` — bordered, hairline-divided card with optional label
- `SettingRow` — label + hint + control; `row` layout for switches/actions, `stack` layout for selects/lists

### Section Taxonomy

| Section | File | Contents |
|---------|------|---------|
| General | `sections/GeneralSection.tsx` | Currency, number/decimal/date format, language, start of week, page size |
| Appearance | `sections/AppearanceSection.tsx` | Theme variant, color mode + schedule, macOS system accent, visual-effects tier, auto-adapt; **Accessibility** group: gain & loss colors (colorblind-safe vs classic) |
| Statistics | `sections/StatisticsSection.tsx` | Exclusion scope, exclude-hidden, internal transfers toggle, excluded categories/recipients (was "Dashboard" tab) |
| Behavior | `sections/BehaviorSection.tsx` | Startup section, cost-basis method, auto-clear planned, reset recurring dismissals |
| AI & Research | `sections/AiSection.tsx` | Ollama AI chat model, research provider keys (composes `AIChatSettingsSection` + `ResearchKeysSection`) |
| Backup | `sections/BackupSection.tsx` | Directory, backup-on-quit, passphrase, run/restore (Electron only) |
| About & Maintenance | `sections/AboutSection.tsx` | App updates, restart onboarding, developer/admin mode, reset-all (danger zone) |

### Instant-Apply Model

Every control writes through on change — there is no global Save/Cancel footer. The orchestrator exposes a single **Done** button that closes the dialog. Specific mechanisms:

- **Most settings**: write through `updateAppSettings` or `updateDashboardSettings` (Zustand store actions); context providers debounce-persist to the API (500 ms).
- **`includeTransfers`**: a server-only aggregation setting with no client reader. Its toggle persists via `apiClient.saveSetting` then `queryClient.invalidateQueries()` for an optimistic cache refresh. Lives in the Statistics section.
- **Visual-effects tier**: applied inline on change (ADR-075 addendum). On an auto-adapt-capped display, a pick writes to `sessionTierOverride`; on an uncapped display it writes the synced `visualEffects` preference and clears the override. Toggling auto-adapt clears the override.
- **Reset to defaults**: moved out of a Save-time action into the **About & Maintenance** danger zone as an explicit "Reset to defaults" button with confirmation.

### Legacy Deep-Link Compatibility

The Electron menu bridge and onboarding flows deep-link into specific settings sections via key names. Legacy tab keys (`general`, `appearance`, `dashboard`, `app`, `backup`) are mapped to new section ids by a `LEGACY_TAB_MAP` inside `DashboardSettingsDialog.tsx`:

| Legacy key | New section id |
|-----------|---------------|
| `dashboard` | `statistics` |
| `app` | `about` |
| `general`, `appearance`, `backup` | unchanged |

Existing callers continue to work without modification.

### i18n Keys (ADR-084)

New keys added (en + nl); no existing keys removed:
- `settings.done` — close button label
- `settings.section.{general,appearance,statistics,behavior,ai,backup,about}` — sidebar nav labels
- `settings.section.{general,appearance,...}.desc` — section description text
- `settings.group.{formatting,localeDisplay,colorMode,visualEffects}` — group card labels

The old `settings.save` / `settings.cancel` strings remain in locale files (unused).

#### i18n Keys — Accessibility group (2026-06-24)

New keys added in en + nl (Appearance section):

| Key | EN value |
|-----|---------|
| `settings.group.accessibility` | "Accessibility" |
| `settings.appearance.gainLossColors` | "Gain & loss colors" |
| `settings.appearance.gainLossColorsHint` | Hint text explaining the two options |
| `settings.appearance.gainLossColors.colorblind` | "Colorblind-safe (orange loss)" |
| `settings.appearance.gainLossColors.classic` | "Classic (red loss)" |

**Full Documentation**: See [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog Documentation]]

### Backup & Restore with Encryption (Phase 2 UX)

The **BackupSection** integrates encrypted backup restore with a **passphrase modal**:

- **Encrypted backup detection**: When user selects a `.visionbak.enc` file for restore, the system detects the encryption via magic header inspection (no decryption attempted yet).
- **Passphrase prompt**: If encrypted, a modal dialog (`RestoreBackupPassphraseDialog`) prompts the user for the backup passphrase before attempting restore.
- **Error handling**: Wrong passphrase errors (`INVALID_PASSPHRASE`) re-open the modal for a retry, while network/database errors show informative toasts.
- **Fallback passphrases**: The restore flow still respects `VISION_BACKUP_PASSPHRASE` env var and OS keychain (safeStorage) as fallback sources if user does not enter a passphrase in the modal.
- **No breaking changes**: Unencrypted backups (`.visionbak`) restore without prompting; encrypted backups always prompt via the modal.

**See:** [[docs/features/backup-coverage-audit|Backup Coverage Audit]] for full restore process details and [[docs/features/onboarding|Onboarding Feature]] for RestoreFromBackupCard integration.

## Related Features

- [[docs/adr/084-settings-instant-apply-sidebar|ADR-084: Settings dialog sidebar + instant-apply]]
- [[docs/features/appearance|Appearance]] — Theme variant, color palette mode, and schedule settings
- [[docs/features/statistics|Statistics]] — Uses exclusions and currency settings
- [[docs/features/portfolio-tax|Portfolio Tax]] — Uses tax adjustments stored as settings
- [[docs/features/views|Dashboard]] — Uses widget visibility settings
