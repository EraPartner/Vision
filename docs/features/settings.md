---
title: Settings Feature
type: feature
status: active
date: 2026-10-08
updated: 2026-10-08
tags:
  [
    feature,
    settings,
    configuration,
    preferences,
    frontend,
    backend,
    refactor,
    phase-3,
    phase-4,
    zustand,
    store,
    backup,
    encrypt,
    passphrase,
    phase-2,
    auto-link,
    planned-match,
    june-2026,
    instant-apply,
    sidebar,
    accessibility,
    colorblind,
    gain-loss,
    design-system,
    adr-183,
  ]
description: Application settings system with JSONB storage, preload optimization, propagation across all pages, and the instant-apply Settings window (DashboardSettingsDialog, ADR-084 and ADR-183).
aliases: [preferences, configuration, app settings, user settings]
related_code:
  - apps/frontend/src/stores/settingsStore.ts
  - apps/frontend/src/features/settings/DashboardSettingsDialog.tsx
  - apps/frontend/src/features/settings/SettingsPrimitives.tsx
  - apps/frontend/src/features/settings/sections/GeneralSection.tsx
  - apps/frontend/src/features/settings/sections/AppearanceSection.tsx
  - apps/frontend/src/features/settings/sections/StatisticsSection.tsx
  - apps/frontend/src/features/settings/sections/BehaviorSection.tsx
  - apps/frontend/src/features/settings/sections/AiSection.tsx
  - apps/frontend/src/features/settings/sections/BackupSection.tsx
  - apps/frontend/src/features/settings/sections/AboutSection.tsx
  - apps/frontend/src/features/settings/AIChatSettingsSection.tsx
  - apps/frontend/src/features/settings/OpenAiSettingsSection.tsx
  - apps/frontend/src/features/settings/AgentCloakDesktopSettingsSection.tsx
  - apps/frontend/src/stores/hydration/AppSettingsHydration.tsx
  - apps/frontend/src/stores/hydration/SettingsHydration.tsx
  - apps/frontend/src/contexts/SettingsPreloadContext.tsx
  - apps/frontend/src/stores/hydration/ThemeHydration.tsx
  - apps/node-backend/src/routes/settings.ts
  - apps/node-backend/src/repositories/settingsRepository.ts
---

# Settings Feature

## Overview

The Settings system manages all application preferences, from display formatting (currency, date format, number format) to behavioral settings (exclusions, pagination defaults, widget visibility). It uses a unified Zustand store, three hydration bridges, a preload context, and a JSONB-backed storage system.

The Settings dialog was reworked in June 2026 from a 5-tab Save/Cancel form into a **sidebar-navigated, instant-apply** surface ([[docs/adr/084-settings-instant-apply-sidebar|ADR-084]]), and in October 2026 into a macOS-style **Settings window** on the design system (ADR-183).

## Architecture

### Zustand Settings Store (Phase 4)

All application settings are managed by a unified **Zustand store** located at `[[apps/frontend/src/stores/settingsStore.ts|settingsStore.ts]]`. Three hydration and effects bridges retain the established consumer hooks:

- **AppSettingsHydration** (`app_settings` key)
- **SettingsHydration** (`dashboard_settings` key)
- **ThemeHydration** (`theme_settings` key)

The provider components in each hydration bridge handle:

- Hydration from SettingsPreloadContext
- Debounced persistence back to the API (500 ms)
- DOM side-effects (ThemeHydration: CSS class, matchMedia, interval)

Consumer hooks (`useAppSettings`, `useSettings`, `useTheme`) use `useShallow()` to select only the slice they need, preventing unnecessary re-renders when unrelated slices change.

**Three-layer settings system**

```
SettingsPreloadContext → SettingsHydration/AppSettingsHydration/ThemeHydration
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

3. **Hydration Bridges** (AppSettingsHydration, SettingsHydration, ThemeHydration): Provide convenience hooks that use `useShallow()` to subscribe to store slices. Example:
   ```typescript
   export const useAppSettings = () => {
     return useSettingsStore(
       useShallow((s) => ({
         ...s.appSettings,
         isLoading: s.isAppSettingsLoading,
       })),
     );
   };
   ```

### Hydration-Time Blob Validation (Zod)

The persisted `app_settings` and `dashboard_settings` blobs are untrusted JSON from the settings API. Both are validated at the store boundary during hydration, in `[[apps/frontend/src/stores/settingsStore.ts|settingsStore.ts]]`:

- `migrateDashboardSettings` (ZOD-11) parses the blob with `storedDashboardSettingsSchema` — a Zod `looseObject` (unknown keys survive and are persisted back) with per-field `.catch` to the default, so one malformed field never poisons the merge.
- `migrateAppSettings` does the same via `storedAppSettingsSchema`. It validates the canonical `visualEffects` tier directly; the retired `enhancedEffects` boolean no longer changes hydration. The money-formatting fields get value-level bounds because bad values make `Intl.NumberFormat` throw `RangeError` (crashing pages into the error boundary, or degrading guarded money surfaces to raw unlocalised numbers): `defaultCurrency` must be a well-formed 3-letter ISO-4217 code, `showDecimalPlaces` an integer 0–20, and `numberFormat` one of `eu`, `us`, `ch`, or `in`. `dateFormat` is limited to the five values offered by Settings; malformed or hand-edited values recover to `DD/MM/YYYY` instead of reaching a locale-sensitive fallback. The optional `openAiDefaultModel` is a non-empty string of at most 200 characters and is checked against the live approved model catalog before use. A blob that is not an object at all falls back to `DEFAULT_APP_SETTINGS` wholesale.

Since the 2026-09-11 compatibility cutoff, dashboard hydration reads only the server-backed
`dashboard_settings` value and otherwise uses defaults. It no longer imports
`vision_dashboardSettings` from browser storage. See
[[docs/adr/135-compatibility-cutoff-for-september-retirements|ADR-135]].

A well-formed (possibly partial) blob produces exactly the pre-validation `{ ...DEFAULTS, ...blob }` result, byte for byte. All `Intl.NumberFormat`-backed money formatters (`Money.tsx`, `useCurrencyFormatter` string + parts paths, `utils/currency.ts#formatCurrency`) additionally guard construction with try/catch and degrade to the same bare `` `${val}` `` text — defense in depth for per-call currency/decimals overrides that come from data rather than settings.

### Settings Keys

| Key                            | Type                   | Default                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultCurrency`              | string                 | `'EUR'`                                | Default display currency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `numberFormat`                 | `eu \| us \| ch \| in` | `'eu'`                                 | Display and strict form-input separator convention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `showDecimalPlaces`            | number                 | `2`                                    | Decimal places for display                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dateFormat`                   | string                 | `'DD/MM/YYYY'`                         | One of the five date display formats exposed by Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `defaultPageSize`              | number                 | `50`                                   | Default table page size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `excludedCategoryIds`          | number[]               | `[]`                                   | Categories to exclude from stats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `excludedRecipientIds`         | number[]               | `[]`                                   | Recipients to exclude from stats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `excludeHiddenCategories`      | boolean                | `false`                                | Exclude inactive categories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `exclusionScope`               | string                 | `'nowhere'`                            | Where exclusions apply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `theme_settings`               | object                 | `{variant: 'default', mode: 'system'}` | Theme variant and mode preferences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `widget_visibility`            | object                 | `{}`                                   | Per-page widget visibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `portfolio_tax_adjustments_v1` | object                 | `{}`                                   | Manual tax adjustments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `backup_settings`              | object                 | `{}`                                   | Backup configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rebalance_plans`              | array                  | `[]`                                   | Saved custom rebalancing plans (max 50); each entry `{ id, name, targetWeights, cashCap? }` — see [[docs/adr/098-cross-workspace-features\|ADR-098]]                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `startupSection`               | `StartupSection`       | `'budgeting'`                          | Section the app navigates to at launch (field within the `app_settings` JSONB blob)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `autoClearPlannedOnMatch`      | boolean                | `true`                                 | When `true`, automatically links and executes a planned payment when an ingested transaction unambiguously matches it. When `false`, auto-link is disabled entirely (no suggestions surface either). See [[docs/features/plannedTransactions#auto-link--auto-clear-on-ingest-june-2026\|Planned Transactions: Auto-Link on Ingest]].                                                                                                                                                                                                                                 |
| `colorblindGainLoss`           | boolean                | `false`                                | When `true`, applies the Okabe-Ito colorblind-safe gain/loss palette (green gain / orange loss, `.skin-v2` root class). When `false` (default), uses the classic gold gain (`--gain`) / red loss (`--loss: var(--destructive)`) palette. Controlled via **Settings → Appearance → Accessibility → Gain & loss colors**. Persisted in the `app_settings` JSONB blob; `AppSettingsProvider` calls `setSkinV2(appSettings.colorblindGainLoss)` on hydration and on change. See [[docs/adr/104-skin-v2-dense-fintech-visual-redesign\|ADR-104 addendum]].                |
| `openAiDefaultModel`           | string                 | _(operator default)_                   | Preferred approved OpenAI API model for new investigations. An explicit per-investigation choice wins; stale catalog entries fall back safely. See [[docs/adr/148-user-default-openai-model\|ADR-148]].                                                                                                                                                                                                                                                                                                                                                              |
| `aiAnswerDepth`                | `quick \| detailed`    | `'quick'`                              | Visible default investigation depth. Run and saved-analysis parameters override it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `analysisBenchmark`            | string                 | _(none)_                               | Optional explicit benchmark identifier. Vision does not infer one from holdings or risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Startup Section

The `startupSection` field controls which top-level section the app opens on immediately after launch. It is persisted as a field inside the existing `app_settings` JSONB blob — no separate backend setting key and no migration are required.

**Type definition (from `[[apps/frontend/src/stores/settingsStore.ts]]`):**

```typescript
type StartupSection = "budgeting" | "portfolio" | "research" | "ai-chat";
```

**Section → home-page mapping:**

| Value         | Navigates to               |
| ------------- | -------------------------- |
| `'budgeting'` | `/` (default, no redirect) |
| `'portfolio'` | `/portfolio`               |
| `'research'`  | `/research`                |
| `'ai-chat'`   | `/ai-chat`                 |

**Redirect behavior** is handled by `[[apps/frontend/src/components/shared/StartupRedirect.tsx]]`, mounted inside `<BrowserRouter>` in `App.tsx`. It fires once, after settings hydrate, and only when the app opened at the root path `/`. It calls `navigate(..., { replace: true })` so the redirect does not create a history entry. Deep links (any non-`/` initial path) and later in-app navigation back to `/` are unaffected.

**UI:** a "Open app on" Select is located in the **Behavior** section of `DashboardSettingsDialog` (`[[apps/frontend/src/features/settings/sections/BehaviorSection.tsx]]`). The option labels reuse `nav.*` i18n keys; the stored value `'budgeting'` is labelled **Home** (`nav.home`) since ADR-180, with no change to the persisted value. Two i18n keys cover the label and hint: `settings.general.startupSection`, `settings.general.startupSectionHint`.

The same section contains four active-category pickers for instrument-free brokerage cash rows: dividend, interest, fee, and tax. They hydrate and save one complete `brokerage_cash_category_ids` object. Controls are disabled while saving, and a failed save restores the last server value and shows an error toast. Clearing a picker stores `null`.

## Backend Storage

### Settings Repository

Located at `[[apps/node-backend/src/repositories/settingsRepository.ts]]`:

- **Storage format**: JSONB column in `settings` table
- **Key-based access**: Individual settings accessed by key
- **Default values**: Defaults applied at the application layer, not in the database

### API Endpoints

Located at `[[apps/node-backend/src/routes/settings.ts]]`:

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

- Backend route logic reuses `assertSettingKeyLength` and `validateSettingValue` across single-key and bulk writes. Dashboard exclusion fields must be arrays; digit-string IDs are coerced to positive PostgreSQL `int4` integers, while malformed or out-of-range values are rejected before storage.
- The repository serializes the already-validated value directly to JSONB. It does not apply a second lossy `Number()` normalization pass ([[apps/node-backend/src/repositories/settingsRepository.ts]]).

#### PUT /api/settings (bulk)

Bulk upserts multiple settings.

**Request body:**

```json
{
  "defaultCurrency": "EUR",
  "dateFormat": "DD/MM/YYYY"
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
  useWidgetVisibility("statistics", STATISTICS_WIDGETS);
```

- **Page-scoped**: Each page has its own visibility state. Page keys in use: `'dashboard'` (Home widgets), `'statistics'`, `'portfolioTax'` and `'transactionsColumns'` (the optional Transactions columns Tags, Currency, Running balance and Status, all default-hidden; see [[docs/features/transactions#Toolbar, columns and View menu]]). Widget ids are the persisted keys, so renaming one silently discards saved choices for it
- **Labels**: a `WidgetDefinition` carries either `label` or a translated `labelKey`
- **Persisted**: Saved to `widget_visibility` setting key
- **Failure feedback**: A rejected save keeps the optimistic local visibility but triggers the shared translated settings error toast, warning that the change may not survive a restart
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

| Setting                | Affected Areas                                         |
| ---------------------- | ------------------------------------------------------ |
| `defaultCurrency`      | All currency displays, portfolio pages, net worth, tax |
| `numberFormat`         | All number formatting (European, US, Swiss, or Indian) |
| `showDecimalPlaces`    | All currency displays                                  |
| `dateFormat`           | All date displays, chart labels                        |
| `defaultPageSize`      | VirtualDataTable pagination                            |
| `excludedCategoryIds`  | Statistics, dashboard, charts                          |
| `excludedRecipientIds` | Statistics, recipient insights                         |

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

The primary UI is `[[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx|DashboardSettingsDialog]]`, the **Settings window**: a macOS-style preferences window drawn as a `Dialog` (the desktop shell has one BrowserWindow), `max-w-4xl` by `82vh`. A sidebar on the left lists the seven sections as `List`/`ListRow` tabs with an icon and the section name, the selected one marked with a quiet tinted background; the title bar shows the current section's name; the content pane scrolls the section's groups. The dialog's accessible name stays "Settings" (a visually hidden `DialogTitle`). There is no description paragraph, no "save automatically" hint paragraph and no footer: the sidebar ends with a one-line caption (`settings.autosaveHint`) and the window closes with its close button, Escape or browser Back. Each section component is self-contained — it reads from hooks and writes directly to the store or API, so the orchestrator threads no staged props.

The section rail implements the tabs accessibility pattern: one selected tab is in the tab order,
each tab controls the active tab panel, and Arrow keys plus Home/End move focus and selection.
Below the `md` breakpoint the rail becomes a horizontally scrolling row above the content.

**Shared layout primitives** live in `[[apps/frontend/src/features/settings/SettingsPrimitives.tsx|SettingsPrimitives.tsx]]` and put every setting on the design system:

- `SettingsSection` — a `section` landmark named after the section; it renders no heading because the title bar already shows the name
- `SettingsGroup` — a `Card` whose header is a `CardTitle variant="label"` plus an optional `type-footnote` description and an `aside` slot, and whose flush content is a borderless `List` of rows
- `SettingRow` — an `li` row: `type-body` label and optional `type-footnote text-label-secondary` description on the left, an h-9 control on the right; `row` layout for switches, buttons and compact selects, `stack` for inputs and lists, `destructive` for the reset and restore rows, `titleHidden` for search fields. Simple `SelectSettingRow` controls align beside labels when their group is at least 28rem wide, with a 10–14rem control column, and stack in narrower containers; selects with supplemental children keep the stacked layout.

Copy follows [[docs/adr/182-ui-copy-plain-words|ADR-182]]: sentence case (the section is "AI & research", the theme is "High contrast"), failure toasts read "Couldn't …", and the restore confirmation button reads Restore. The confirmations the window opens (reset all settings, restore a backup) use the shared `useConfirmDialog` alert dialog; the encrypted-restore passphrase prompt comes from `useRestoreBackup`.

### Section Taxonomy

| Section       | File                             | Contents                                                                                                                                                             |
| ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General       | `sections/GeneralSection.tsx`    | Currency, number/decimal/date format, language, start of week, page size                                                                                             |
| Appearance    | `sections/AppearanceSection.tsx` | Theme variant, color mode + schedule, macOS system accent, visual-effects tier, auto-adapt, **Sidebar** (Labels / Icons only, [[docs/adr/180-sidebar-sections-replace-workspaces\|ADR-180]]); **Accessibility** group: gain & loss colors (colorblind-safe vs classic) |
| Insights      | `sections/StatisticsSection.tsx` | Exclusion scope, exclude-hidden, internal transfers toggle, excluded categories/recipients (was "Dashboard" tab)                                                     |
| Behavior      | `sections/BehaviorSection.tsx`   | Startup section, cost-basis method, auto-clear planned, brokerage cash category mappings, reset recurring dismissals                                                 |
| AI & research | `sections/AiSection.tsx`         | Analysis defaults, Ollama and OpenAI default models, AgentCloak Desktop status and protection control, and research provider keys                                    |

| Backup | `sections/BackupSection.tsx` | Directory, backup-on-quit, passphrase, run/restore (Electron only) |
| About & maintenance | `sections/AboutSection.tsx` | Identity card (Vision mark, canonical build version, AGPL-3.0-only license, source/documentation links), updates (the shared `useUpdateStatus` result as a row with a Release notes link, Check for updates, Install update), Setup assistant restart, Admin mode switch, Reset all settings |

Admin and Monitors remain sidebar sections of their own (ADR-180) rather than Settings sections.

The AgentCloak Desktop group shows a fresh availability check, effective protection state, local
reference-key state, and whether the OpenAI route is enabled. Check Again repeats the probe.
Enable probes the Desktop loopback interface and creates a Vision reference mapping key when none
exists, then saves the enabled preference. It works even when OpenAI is not configured. Disable
leaves the key in place for existing token-bearing investigations. See
[[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]] and
[[docs/api/ai-research|AI Research API]].

### Instant-Apply Model

Every control writes through on change — there is no Save/Cancel or Done footer; the window closes with its close button, Escape or browser Back. Specific mechanisms:

- **Most settings**: write through `updateAppSettings` or `updateDashboardSettings` (Zustand store actions); context providers debounce-persist to the API (500 ms).
- **`includeTransfers`**: a server-only aggregation setting with no client reader. Its toggle persists via `apiClient.saveSetting` then `queryClient.invalidateQueries()` for an optimistic cache refresh. Lives in the Insights section (the internal `statistics` key is unchanged).
- **Visual-effects tier**: applied inline on change (ADR-075 addendum). On an auto-adapt-capped display, a pick writes to `sessionTierOverride`; on an uncapped display it writes the synced `visualEffects` preference and clears the override. Toggling auto-adapt clears the override.
- **Reset all settings**: moved out of a Save-time action into the **About & Maintenance** danger zone. Since 2026-10-05 its **Reset** button asks first through the destructive `useConfirmDialog` confirmation (`settings.app.resetAllConfirm.*`); before that it reset immediately. The dialog says that all preferences return to their defaults, naming the language, the number and date formats and the excluded categories and recipients, and that the theme, accounts, transactions and other data are kept. Confirming resets every app preference (currency, date and number format, decimal places, page size, start of week, language, startup page, visual effects, gain and loss colors, cost basis method, admin mode, auto-clearing planned payments, and the AI model, answer depth and benchmark choices), the session visual-effects override, and the dashboard statistics settings (excluded categories and recipients, exclude-hidden and exclusion scope). Confirming also saves the server-side `includeTransfers` setting as `false` and shows the `settings.resetToDefaults` toast. Theme variant and color mode, accounts, transactions, categories and other data are kept. Cancelling changes nothing.
- **Product identity**: `lib/appIdentity.ts` exposes the build-time root-package version, product name, license, repository, and documentation URLs. The same version appears in the sidebar footer and the About identity card; package manifests are kept aligned so neither surface can make a stale hardcoded claim.

Rejected `app_settings`, `dashboard_settings`, and `widget_visibility` saves all increment the shared `settingsSaveErrorNonce`. `SettingsSaveErrorToaster`, mounted under `LanguageProvider`, shows the existing localized `settings.saveFailed` message when it observes the nonce advance; React may coalesce simultaneous failures into one toast. The optimistic local state is deliberately not rolled back, so the user can keep working while being warned that the change may not survive a restart.

### Section Deep Links

Settings are addressable through `?settings=<section>`, where the canonical section ids are `general`, `appearance`, `statistics`, `behavior`, `ai`, `backup`, and `about`. Opening settings adds a browser-history entry, changing sections replaces that entry, and closing removes the parameter. Browser Back therefore closes a newly opened settings dialog without losing unrelated query parameters. The Electron menu and onboarding use the same route-backed entry point.

`resolveSettingsSection` accepts only those seven canonical identifiers. The retired `dashboard`
and `app` values are no longer mapped to `statistics` and `about`. A URL containing either retired
value does not open settings; internal callers that provide an unknown section fall back to
General. Electron menus and onboarding use canonical identifiers.

### i18n Keys

- `settings.title` — accessible name of the window and its tablist
- `settings.tab.{general,appearance,backup}` and `settings.section.{statistics,behavior,ai,about}` — sidebar section names, also shown in the title bar
- `settings.autosaveHint` — the sidebar caption
- `settings.group.{formatting,localeDisplay,sidebar,colorMode,visualEffects,accessibility}` — group card titles
- `settings.dashboard.excludedCount.{one,other}` — count badge on the exclusion groups

ADR-183 removed `settings.done`, `settings.description`, `settings.saveHint`, `settings.section.*.desc`, `settings.app.identity` and `settings.dashboard.excluded`. The old `settings.save` / `settings.cancel` strings remain in locale files (unused).

#### i18n Keys — Accessibility group (2026-06-24)

New keys added in en + nl (Appearance section):

| Key                                             | EN value                             |
| ----------------------------------------------- | ------------------------------------ |
| `settings.group.accessibility`                  | "Accessibility"                      |
| `settings.appearance.gainLossColors`            | "Gain & loss colors"                 |
| `settings.appearance.gainLossColorsHint`        | Hint text explaining the two options |
| `settings.appearance.gainLossColors.colorblind` | "Colorblind-safe (orange loss)"      |
| `settings.appearance.gainLossColors.classic`    | "Classic (red loss)"                 |

**Full Documentation**: See [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog Documentation]]

### Backup & Restore with Encryption (Phase 2 UX)

The **BackupSection** integrates encrypted backup restore with a **passphrase modal**:

- **Encrypted backup detection**: When user selects a `.visionbak.enc` file for restore, the system detects the encryption via magic header inspection (no decryption attempted yet).
- **Passphrase prompt**: If encrypted, a modal dialog (`RestoreBackupPassphraseDialog`) prompts the user for the backup passphrase before attempting restore.
- **Error handling**: Wrong passphrase errors (`INVALID_PASSPHRASE`) re-open the modal for a retry, while network/database errors show informative toasts.
- **Fallback passphrases**: The restore flow still respects `VISION_BACKUP_PASSPHRASE` env var and OS keychain (safeStorage) as fallback sources if user does not enter a passphrase in the modal.
- **No breaking changes**: Unencrypted backups (`.visionbak`) restore without prompting; encrypted backups always prompt via the modal.

**See:** [[docs/features/backup-coverage-audit|Backup Coverage Audit]] for full restore process details and [[docs/features/onboarding|Onboarding Feature]] for RestoreFromBackupCard integration.

## Concurrent saves

[[docs/adr/173-conditional-settings-replacement|ADR-173]] defines conditional whole-value
replacement. Reads retain persisted baselines separately from defaults. A stale save fails with
409; nested values are not merged, and omitted fields are removed. After any uncertain or failed
save, reload Vision before saving that key again. Browser queues and Electron's backup/services
writer advance their baselines only after acknowledged persistence. Failed preload or an offline
local mirror does not authorize overwriting database state.


## Related Features

- [[docs/adr/084-settings-instant-apply-sidebar|ADR-084: Settings dialog sidebar + instant-apply]]
- [[docs/adr/148-user-default-openai-model|ADR-148: User default OpenAI model]]
- [[docs/adr/171-packaged-openai-explicit-configuration|ADR-171: Explicitly configured packaged OpenAI API route]]
- [[docs/features/appearance|Appearance]] — Theme variant, color palette mode, and schedule settings
- [[docs/features/statistics|Statistics]] — Uses exclusions and currency settings
- [[docs/features/portfolio-tax|Portfolio Tax]] — Uses tax adjustments stored as settings
- [[docs/features/views|Dashboard]] — Uses widget visibility settings


## Number format previews

General settings generates each decimal-precision example with the selected number format. European, US, Swiss, and Indian examples therefore use the same separators as the selected format.


## Clarity and recovery feedback

The settings caption distinguishes preferences that save automatically from actions with their own Save or confirmation buttons. Restore and reset retain their explicit confirmation flows. Section names can wrap in the wider desktop rail. Backup paths retain the destination end when space is limited, with the full path available in the field tooltip.
