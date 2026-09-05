---
title: DashboardSettingsDialog
type: component
status: active
date: 2026-04-23
updated: 2026-08-27
tags: [components, forms, dialogs, settings, refactor, sidebar, instant-apply, phase-3, memoization, backup, encrypt, passphrase-modal, phase-2, visual-effects-tiers, auto-adapt-display, adr-084, small-viewport-robustness]
description: Sidebar-navigated instant-apply settings dialog. Left rail of seven sections; each section is a self-contained component reading from hooks and writing directly to the store/API. Single "Done" close button replaces the old Save/Cancel footer. Shared SettingsPrimitives (SettingsSection, SettingsGroup, SettingRow) enforce a uniform visual language. (ADR-084)
aliases: [settings-dialog, dashboard-settings, DashboardSettingsDialog]
related_code:
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
---

# DashboardSettingsDialog

Sidebar-navigated, instant-apply settings dialog for configuring user preferences, display settings, statistics exclusions, backup options, and application behavior.

> [!info] ADR-084 Rework — June 2026
> The dialog was a 5-tab (`General`, `Appearance`, `Dashboard`, `App`, `Backup`) Save/Cancel form. It is now a **sidebar + scrollable content pane** with **instant-apply**. The Cancel/Save footer is replaced by a single **Done** (close) button. Reset-all moved to the About & Maintenance danger zone. See [[docs/adr/084-settings-instant-apply-sidebar|ADR-084]] for full rationale.

## Architecture

### Component Hierarchy

```
DashboardSettingsDialog (sidebar orchestrator)
├── SettingsPrimitives (SettingsSection, SettingsGroup, SettingRow — shared layout)
├── GeneralSection       — currency, number/decimal/date format, language, start of week, page size
├── AppearanceSection    — theme variant, color mode + schedule, system accent, visual effects, auto-adapt
├── StatisticsSection    — exclusion scope, exclude-hidden, include-transfers, excluded categories/recipients
├── BehaviorSection      — startup section, cost-basis method, auto-clear planned, reset recurring dismissals
├── AiSection            — Ollama AI chat model + research provider keys
│   ├── AIChatSettingsSection
│   └── ResearchKeysSection
├── BackupSection        — directory, backup-on-quit, passphrase, run/restore (Electron only)
└── AboutSection         — app updates, onboarding restart, developer/admin mode, reset-all (danger zone)
```

### Instant-Apply Model

Every control writes through on change — no staged local state in the orchestrator.

| Setting category | Write path |
|---|---|
| Most app/dashboard settings | `updateAppSettings` / `updateDashboardSettings` → Zustand store → context providers debounce-persist (500 ms) |
| `includeTransfers` (server-only) | `apiClient.saveSetting` → `queryClient.invalidateQueries()` (optimistic cache refresh) |
| Visual-effects tier | Applied inline; capped display → `sessionTierOverride`; uncapped → synced `visualEffects` + clear override |
| Theme / color mode | Already instant; no change in behavior |
| Backup settings | Written directly by `BackupSection` only — no other section can clobber them |
| Reset to defaults | Explicit confirm in `AboutSection` danger zone |

Because each section is self-contained, the orchestrator holds no staged state and no per-section prop threads. The old "backup settings clobber" guard is gone: only `BackupSection` ever writes backup settings.

### State Ownership

| State | Owner | Purpose |
|-------|-------|---------|
| `activeSection` | DashboardSettingsDialog | Currently visible section |
| All settings values | Zustand store (via hooks in each section) | Single source of truth; sections read + write directly |
| Backup state (dir, passphrase, encrypt, showRestore) | BackupSection internal | Not propagated to orchestrator |

### Legacy Deep-Link Compatibility

The Electron menu bridge and onboarding flows pass tab key strings. `DashboardSettingsDialog` maps legacy keys via `LEGACY_TAB_MAP`:

| Legacy key | Maps to section |
|-----------|----------------|
| `dashboard` | `statistics` |
| `app` | `about` |
| `general`, `appearance`, `backup` | unchanged |

---

## DashboardSettingsDialog (Orchestrator)

### File

`[[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx]]`

### Props

```typescript
interface DashboardSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: string; // 'general' | 'appearance' | 'statistics' | 'behavior' | 'ai' | 'backup' | 'about'
                       // Legacy keys 'dashboard' and 'app' are mapped via LEGACY_TAB_MAP
}
```

### Features

- **Sidebar nav**: Left rail with icon + label for each of the seven sections; highlights active section. The rail exposes `tablist`/`tab`/`tabpanel` semantics, keeps only the selected tab in the tab order, and supports Arrow keys plus Home/End. **Responsive (Aug 2026)**: below the `md` breakpoint the nav collapses into a horizontally-scrolling chip bar under the dialog header instead of a fixed 208px sidebar — a fixed sidebar left ~120px for every control at phone widths. `md+` layout is pixel-identical to before.
- **Scrollable content pane**: Right area renders the active section component.
- **Done button**: Single close action; no Save/Cancel.
- **Section lazy-init**: React Query cache persists across section switches; transient UI state (search inputs) resets on unmount.

### Usage

```tsx
import { DashboardSettingsDialog } from "@/features/settings/DashboardSettingsDialog";
import { useState } from "react";

function SettingsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Open Settings</Button>
      <DashboardSettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
```

---

## SettingsPrimitives

Shared layout primitives used by every section to enforce a uniform visual language.

### File

`[[apps/frontend/src/features/settings/SettingsPrimitives.tsx]]`

### Exports

| Component | Purpose | Layout |
|-----------|---------|--------|
| `SettingsSection` | Title + description header for a section | Full-width heading block |
| `SettingsGroup` | Bordered, hairline-divided card; optional label and description | Groups related rows |
| `SettingRow` | Label + hint + control | `row` for switches/actions; `stack` for selects/lists |

`SettingRow` replaces the three inconsistent label-control patterns from the old tabs (bare rows with full-width `Separator`, bordered cards, button-cards). Every setting in every section now uses the same primitive.

---

## GeneralSection

### File

`[[apps/frontend/src/features/settings/sections/GeneralSection.tsx]]`

### Contents

Currency, number format, decimal places, date format, language, start of week, page size (pure formatting + locale + table density settings). Reads from `useAppSettings`; writes through `updateAppSettings`.

---

## AppearanceSection

### File

`[[apps/frontend/src/features/settings/sections/AppearanceSection.tsx]]`

### Contents

Theme variant, color mode (system / light / dark / schedule), schedule start/end times, macOS system accent, visual-effects tier, auto-adapt display toggle. **Accessibility** group (2026-06-24): Gain & loss colors Select (`colorblindGainLoss` setting — colorblind-safe Okabe-Ito vs classic gold/red). Reads from `useTheme` / `useAppSettings`; writes through store actions.

### Visual-Effects Tier (ADR-075 addendum)

Applied inline on change — not deferred to Save:

- **Auto-adapt-capped display** (`autoAdaptDisplay && isLargeDisplay`): tier pick → `sessionTierOverride`. Picking `reduced` clears the override instead. Synced `visualEffects` preference is not written.
- **Uncapped display**: tier pick → synced `visualEffects` + clear `sessionTierOverride`.
- **Toggling auto-adapt off**: clears `sessionTierOverride` (auto reclaims control).

Contextual notes under the tier Select: `text-primary` when auto-capped; `text-warning` when a session override is active (device-local, cleared on next launch). Keys: `settings.appearance.visualEffectsAutoNote` / `visualEffectsOverrideNote`.

> [!info] Updated 2026-06-18 (ADR-084)
> Tier routing is now applied on change rather than on Save. See [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075 addendum]].

---

## StatisticsSection

Formerly the `DashboardTab`. Renamed for accuracy: the exclusion scope option labelled "everywhere" applies beyond the dashboard.

### File

`[[apps/frontend/src/features/settings/sections/StatisticsSection.tsx]]`

### Contents

- **Exclusion scope**: `everywhere` / `statistics` / `nowhere`
- **Exclude hidden categories**: auto-exclude inactive categories toggle
- **Include internal transfers**: server-only aggregation toggle (`includeTransfers`); persists via `apiClient.saveSetting` + `queryClient.invalidateQueries()`; no client-side reader
- **Excluded categories**: searchable multiselect
- **Excluded recipients**: searchable multiselect

Reads from `useSettings`; exclusion arrays + scope write through `updateDashboardSettings`. `includeTransfers` writes directly via API (see [[docs/adr/083-internal-transfer-detection|ADR-083]]).

---

## BehaviorSection

### File

`[[apps/frontend/src/features/settings/sections/BehaviorSection.tsx]]`

### Contents

- **Startup section**: which top-level section opens at launch (`budgeting` / `portfolio` / `research` / `ai-chat`)
- **Cost-basis method**: portfolio gain/loss calculation method
- **Auto-clear planned on match**: auto-link + execute planned transactions on ingest match
- **Reset recurring dismissals**: clear all dismissed recurring suggestions (with confirmation)

Reads from `useAppSettings`; writes through `updateAppSettings`.

---

## AiSection

### File

`[[apps/frontend/src/features/settings/sections/AiSection.tsx]]`

### Contents

Composes `[[apps/frontend/src/features/settings/AIChatSettingsSection.tsx|AIChatSettingsSection]]` (Ollama connection status + model selector) and `ResearchKeysSection` (provider API keys). Both sub-components read and write independently; `AiSection` is a layout wrapper.

---

## BackupSection

Formerly `BackupTab`. Now self-contained: it owns all backup state and writes directly to `apiClient` — no backup props are threaded through the orchestrator.

### File

`[[apps/frontend/src/features/settings/sections/BackupSection.tsx]]`

### Contents

- **Backup directory**: path input + Electron file picker (Electron only)
- **Backup on quit**: auto-backup-on-exit toggle
- **Passphrase + encryption**: AES-256-GCM encrypt toggle + passphrase input (>6 chars)
- **Create backup**: immediate backup with progress UI
- **Restore backup**: file picker → encrypted detection → `useRestoreBackup` hook → passphrase modal on `.visionbak.enc`

### Internal State

All backup state (`backupDir`, `backupPassphrase`, `backupEncrypt`, `showRestore`, `tempPassphrase`) is managed internally — no propagation to the orchestrator. This eliminates the old "backup settings clobber" guard that existed because the previous `handleSave()` wrote backup settings for all tabs regardless of which one was active.

### Encrypted Restore Flow (Phase 2)

`BackupSection` uses the `useRestoreBackup()` hook (`[[apps/frontend/src/hooks/useRestoreBackup.tsx]]`):

- Detects encryption via `apiClient.isBackupEncrypted(filePath)`
- Opens passphrase modal (`RestoreBackupPassphraseDialog`) for `.visionbak.enc` files
- Re-prompts on `INVALID_PASSPHRASE`; falls back to `VISION_BACKUP_PASSPHRASE` env and OS keychain

### Tests

`[[apps/frontend/src/features/settings/sections/__tests__/BackupSection.test.tsx]]`

### Related

- `[[apps/frontend/src/hooks/useRestoreBackup.tsx]]` — Encrypted-aware restore hook
- `[[apps/frontend/src/lib/api/electron.ts]]` — `isBackupEncrypted()` and `restoreBackup(filePath, opts?)`
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]] — Full restore process and encryption details
- [[docs/features/onboarding|Onboarding Feature]] — RestoreFromBackupCard integration

---

## AboutSection

### File

`[[apps/frontend/src/features/settings/sections/AboutSection.tsx]]`

### Contents

- **App updates**: manual update check + install (Electron)
- **Restart onboarding**: reset onboarding completion + reshow wizard
- **Developer / admin mode**: toggle (with confirmation)
- **Reset to defaults** (danger zone): resets all settings; requires AlertDialog confirmation; replaces the old `handleReset()` in the orchestrator

---

## AIChatSettingsSection

Reusable AI chat model group composed inside `AiSection`. It and `ResearchKeysSection` use the same
`SettingsGroup`/`SettingRow` anatomy as every other settings section; Appearance's theme-variant picker
also uses a stacked row instead of a hand-built heading/card pair.

### File

`[[apps/frontend/src/features/settings/AIChatSettingsSection.tsx]]`

### Props

```typescript
interface AIChatSettingsSectionProps {
  value: string | undefined;
  onChange: (model: string) => void;
}
```

### Features

- **Status Indicator**: Ollama connection status (green/red dot) via `useOllamaStatus()`
- **Model Selector**: Available models from `useOllamaModels()` → `apiClient.getOllamaModels()`
- **Help Text**: Ollama setup and model requirements

---

## i18n Keys (ADR-084)

New keys added in en + nl; no existing keys changed:

| Key pattern | Purpose |
|-------------|---------|
| `settings.done` | Done button label |
| `settings.section.{about,ai,behavior,statistics,...}` | Sidebar section labels |
| `settings.section.*.desc` | Section description text |
| `settings.group.{formatting,localeDisplay,colorMode,visualEffects}` | Group card labels |

The old `settings.save` / `settings.cancel` strings remain in locale files (unused).

---

## Testing Strategy

| Component | Test Scope |
|-----------|-----------|
| DashboardSettingsDialog | Dialog open/close, section nav, Done button, legacy tab key mapping |
| GeneralSection | Currency/format selection, instant write to store |
| StatisticsSection | Category/recipient exclusion, scope selection, includeTransfers toggle |
| BehaviorSection | Startup section select, auto-clear planned toggle, recurring reset confirmation |
| AppearanceSection | Theme variant, tier routing (capped vs uncapped display) |
| AiSection | Ollama status display, model selector |
| BackupSection | Directory picker, backup creation, encrypted restore flow (`BackupSection.test.tsx`) |
| AboutSection | Reset-all confirmation, onboarding restart |

---

## Refactor History

| Phase | Date | Change |
|-------|------|--------|
| Phase 3 | 2026-04-23 | Monolith (~1400 lines) split into thin orchestrator + 5 tab components |
| April 25 | 2026-04-25 | `useCallback` + functional updater pattern for stable callbacks; `React.memo()` on all tabs |
| ADR-075 addendum | 2026-06-12 | Visual-effects tier Select + auto-adapt Switch added to AppearanceTab; `tierSelection` staged state in orchestrator |
| ADR-084 | 2026-06-18 | 5-tab Save/Cancel form → sidebar + instant-apply; `SettingsPrimitives`; section taxonomy rework; `tabs/` directory removed |
| ADR-104 addendum | 2026-06-24 | Accessibility group added to AppearanceSection: Gain & loss colors Select (`colorblindGainLoss`) |
| Small-viewport robustness | 2026-08-10 | Section nav collapses to a horizontal scrolling chip bar below `md`; `md+` unchanged (PR #156) |

---

## Related Documentation

- [[docs/adr/084-settings-instant-apply-sidebar|ADR-084: Settings sidebar + instant-apply]]
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual effects tiers]]
- [[docs/adr/083-internal-transfer-detection|ADR-083: Internal transfer detection]]
- [[docs/features/settings|Settings Feature]] — Complete settings system overview
- [[docs/api/settings|Settings API]] — Backend endpoints and schema
- [[docs/components/index|Components Index]] — All frontend components
- [[docs/reference/frontend-api-client|Frontend API Client]] — API methods used by settings dialog

## Related Code

- Settings Store: `[[apps/frontend/src/stores/settingsStore.ts]]`
- Settings Context: `[[apps/frontend/src/stores/hydration/SettingsHydration.tsx]]`
- App Settings Context: `[[apps/frontend/src/stores/hydration/AppSettingsHydration.tsx]]`
- API Client: `[[apps/frontend/src/lib/api.ts]]`
- Settings API: `[[apps/node-backend/src/routes/settings.js]]`
