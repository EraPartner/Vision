---
title: DashboardSettingsDialog
type: component
status: active
date: 2026-10-06
updated: 2026-10-06
tags:
  [
    components,
    forms,
    dialogs,
    settings,
    design-system,
    adr-183,
    refactor,
    sidebar,
    instant-apply,
    phase-3,
    memoization,
    backup,
    encrypt,
    passphrase-modal,
    phase-2,
    visual-effects-tiers,
    auto-adapt-display,
    adr-084,
    small-viewport-robustness,
  ]
description: The Settings window, a macOS-style preferences window drawn as a Dialog. A sidebar list of seven sections on the left, the current section's name in the title bar, and the section's groups as Cards of setting rows in a scrolling pane. Every control saves on change; the window closes with its close button or Escape. Shared SettingsPrimitives (SettingsSection, SettingsGroup, SettingRow) put every setting on the design system. (ADR-084, ADR-183)
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

The Settings window: a macOS-style preferences window for user preferences, appearance, statistics exclusions, behavior, AI, backup and maintenance. The desktop shell has exactly one BrowserWindow, so the window is a `Dialog` styled as a window (`max-w-4xl`, `h-[82vh]`): a sidebar of sections on the left, a title bar that names the current section, and the section's content in a scrolling pane. Every control saves on change; the window closes with its close button, Escape or browser Back. There is no description line, no "changes save automatically" paragraph and no footer; the sidebar ends with a one-line caption saying changes save automatically.

> [!info] ADR-084 Rework — June 2026
> The dialog was a 5-tab (`General`, `Appearance`, `Dashboard`, `App`, `Backup`) Save/Cancel form. ADR-084 made it a **sidebar + scrollable content pane** with **instant-apply**; reset-all moved to the About & maintenance section. The redesign (ADR-183, 2026-10-06) restyled it as a window on the design system and removed the Done button. See [[docs/adr/084-settings-instant-apply-sidebar|ADR-084]] for the instant-apply rationale.

## Architecture

### Component Hierarchy

```
DashboardSettingsDialog (sidebar orchestrator)
├── SettingsPrimitives (SettingsSection, SettingsGroup, SettingRow — shared layout)
├── GeneralSection       — currency, number/decimal/date format, language, start of week, page size
├── AppearanceSection    — theme variant, color mode + schedule, system accent, visual effects, auto-adapt
├── StatisticsSection    — exclusion scope, exclude-hidden, include-transfers, excluded categories/recipients
├── BehaviorSection      — startup section, cost-basis method, auto-clear planned, reset recurring dismissals
├── AiSection            — AI chat, OpenAI, AgentCloak Desktop, analysis preferences, research provider keys
│   ├── AIChatSettingsSection
│   ├── OpenAiSettingsSection
│   ├── AgentCloakDesktopSettingsSection
│   ├── AnalysisPreferencesSettings
│   └── ResearchKeysSection
├── BackupSection        — directory, backup-on-quit, passphrase, run/restore (Electron only)
└── AboutSection         — app updates, onboarding restart, developer/admin mode, reset-all (danger zone)
```

### Instant-Apply Model

Every control writes through on change — no staged local state in the orchestrator.

| Setting category                 | Write path                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Most app/dashboard settings      | `updateAppSettings` / `updateDashboardSettings` → Zustand store → context providers debounce-persist (500 ms) |
| `includeTransfers` (server-only) | `apiClient.saveSetting` → `queryClient.invalidateQueries()` (optimistic cache refresh)                        |
| Visual-effects tier              | Applied inline; capped display → `sessionTierOverride`; uncapped → synced `visualEffects` + clear override    |
| Theme / color mode               | Already instant; no change in behavior                                                                        |
| Backup settings                  | Written directly by `BackupSection` only — no other section can clobber them                                  |
| Reset to defaults                | Explicit confirm in `AboutSection` danger zone                                                                |

Because each section is self-contained, the orchestrator holds no staged state and no per-section prop threads. The old "backup settings clobber" guard is gone: only `BackupSection` ever writes backup settings.

### State Ownership

| State                                                | Owner                                     | Purpose                                                |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `activeSection`                                      | DashboardSettingsDialog                   | Currently visible section; its name is the title bar   |
| All settings values                                  | Zustand store (via hooks in each section) | Single source of truth; sections read + write directly |
| Backup state (dir, passphrase, encrypt, showRestore) | BackupSection internal                    | Not propagated to orchestrator                         |

### Section Deep Links

The Electron menu bridge and onboarding pass canonical section identifiers. The accepted values are
`general`, `appearance`, `statistics`, `behavior`, `ai`, `backup`, and `about`. Retired
`dashboard` and `app` identifiers are not aliases; a direct component value falls back to General,
while a URL using one of those values does not open the dialog.

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
}
```

### Features

- **Accessible name**: the dialog is named "Settings" through a visually hidden `DialogTitle`; the visible title bar shows the current section's name as an `h2`, as a macOS preferences window does. `DialogContent` passes `aria-describedby={undefined}` because the window has no description.
- **Sidebar**: a `List` of `ListRow`s (`asChild` around a `role="tab"` button) with a leading icon and the section name; the selected row is filled with the primary color. The rail exposes `tablist`/`tab`/`tabpanel` semantics, keeps only the selected tab in the tab order, and supports Arrow keys plus Home/End. Below the `md` breakpoint the rail becomes a horizontally scrolling row of sections above the content, because a fixed rail would leave ~120px for every control at phone widths. The rail ends with a `type-caption` line (`settings.autosaveHint`) that says changes save automatically.
- **Title bar and content pane**: a 48px title bar with the section name, then a `ScrollArea` (`role="tabpanel"`, labelled by the selected tab) that renders the active section component.
- **Closing**: the window closes with the close button in the top-right corner, Escape, or browser Back (the route-backed `?settings=` entry); there is no Done or Save/Cancel footer.
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

Shared layout primitives used by every section so that every setting sits on the design system (role tokens, type ramp, Card and List primitives).

### File

`[[apps/frontend/src/features/settings/SettingsPrimitives.tsx]]`

### Exports

| Component          | Purpose                                                                                                                                       | Layout                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `SettingsSection`  | A `section` landmark labelled with the section name (the title bar shows the name, so it renders no heading); stacks groups with `space-y-6` | Full width                                                                             |
| `SettingsGroup`    | A `Card`: optional `CardHeader` with a `CardTitle variant="label"` (h3), a `type-footnote` description and an `aside` slot (e.g. a count badge); `CardContent variant="flush"` holding a borderless `List` | Groups related rows                                                                    |
| `SettingRow`       | An `li` row: `type-body` label (a `<Label>` when `htmlFor`/`labelId` is set) plus an optional `type-footnote text-label-secondary` description on the left, an h-9 control on the right | `row` for switches, buttons and compact selects; `responsive` for selects; `stack` for inputs and lists; `destructive` tones the label; `titleHidden` keeps the label for assistive technology only |
| `SelectSettingRow` | One `SettingRow` + `Select`, expressed as config                                                                                              | `responsive`, or `stack` when it has supplemental children                             |

Every setting in every section uses these primitives; no section draws its own bordered box.

---

## GeneralSection

### File

`[[apps/frontend/src/features/settings/sections/GeneralSection.tsx]]`

### Contents

Two groups: **Numbers & dates** (default currency, number format, decimal places, date format) and **Language & display** (language, start of week, default page size). Reads from `useAppSettings`; writes through `updateAppSettings`.

---

## AppearanceSection

### File

`[[apps/frontend/src/features/settings/sections/AppearanceSection.tsx]]`

### Contents

Theme variant (a stacked row of `aria-pressed` buttons with name, description and palette swatches), **Sidebar** (labels or icons only, when a sidebar is mounted), **Color mode** (mode select, schedule times when scheduled, macOS system accent switch), **Visual effects** (tier select with the auto-cap and session-override notes, reduce-on-large-displays switch) and **Accessibility** (gain & loss colors select, `colorblindGainLoss`: colorblind-safe Okabe-Ito vs classic gold/red). Reads from `useTheme` / `useAppSettings`; writes through store actions.

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

- **Where exclusions apply**: `everywhere` / `dashboard` / `statistics` select
- **Exclude hidden categories**: auto-exclude inactive categories switch
- **Include transfers**: server-only aggregation switch (`includeTransfers`); persists via `apiClient.saveSetting` + a scoped `queryClient.invalidateQueries()`; no client-side reader
- **Excluded categories**: a group with a count badge (`settings.dashboard.excludedCount` plural), a search field, and a scrolling checklist grouped by top-level category with a tri-state group checkbox
- **Excluded payees**: a group with a count badge, a search field, and a scrolling checklist (excluded first)

Reads from `useSettings`; exclusion arrays + scope write through `updateDashboardSettings`. `includeTransfers` writes directly via API (see [[docs/adr/083-internal-transfer-detection|ADR-083]]).

---

## BehaviorSection

### File

`[[apps/frontend/src/features/settings/sections/BehaviorSection.tsx]]`

### Contents

- **Open app on**: which page opens at launch (`budgeting` / `portfolio` / `research` / `ai-chat` / `last`)
- **Cost basis method**: portfolio gain/loss calculation method (also saved server-side as `cost_basis_method`)
- **Auto-clear planned payments**: clear a planned payment when an imported or added transaction unambiguously matches it
- **Keep services running on quit** (desktop only): Electron services setting
- **Brokerage cash categories**: dividend, interest, fee and tax category pickers
- **Reset dismissed recurring suggestions**: a Reset button that clears the dismissals and toasts the result

Reads from `useAppSettings`; writes through `updateAppSettings`.

---

## AiSection

### File

`[[apps/frontend/src/features/settings/sections/AiSection.tsx]]`

### Contents

Composes `[[apps/frontend/src/features/settings/AIChatSettingsSection.tsx|AIChatSettingsSection]]` (Ollama status + default model), `OpenAiSettingsSection` (default OpenAI model), `AgentCloakDesktopSettingsSection` (connection status, Check again, Enable/Disable), `AnalysisPreferencesSettings` (default answer depth, default benchmark with Clear) and `ResearchKeysSection` (one row per provider: masked status, key input, Save, Clear). Each sub-component reads and writes independently; `AiSection` is a layout wrapper. Keys are entered inline; no sub-dialog opens from this section.

---

## BackupSection

Formerly `BackupTab`. Now self-contained: it owns all backup state and writes directly to `apiClient` — no backup props are threaded through the orchestrator.

### File

`[[apps/frontend/src/features/settings/sections/BackupSection.tsx]]`

### Contents

Outside the desktop app the section is one `CardContent variant="state"` card saying backups are only available in the desktop app. In the desktop app, three groups:

- **Backups**: backup folder (read-only path + Browse…/Change…), Back up when quitting switch, Back up now button
- **Backup encryption (optional)**: passphrase input with Save passphrase and Clear saved passphrase, the encryption status as the row's description, the secure-storage warning, and a dismissable "Store your passphrase securely" reminder row
- **Restore from backup**: Choose backup file… (read-only file name + picker), then a destructive Restore now row whose description carries the irreversibility warning. Restore now asks first through the destructive `useConfirmDialog` (`settings.restore.confirmTitle`, Restore / Cancel), then hands the file to `useRestoreBackup`, which opens the passphrase dialog for `.visionbak.enc` files

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

- **Identity card**: a `Card` with the Vision mark, product name (`type-title-2`), version and license, and Source code / Documentation links
- **Updates**: the shared `useUpdateStatus` result as a row (running the latest version, or the available version with release date, release notes excerpt and a Release notes link), then a Check for updates button and, in the desktop app when an update exists, Install update
- **Setup assistant**: Restart button (resets onboarding, closes the window, reloads)
- **Admin mode**: switch that shows the Admin section in the sidebar
- **Reset**: the **Reset all settings** row (destructive tone) with a Reset button that asks first through the destructive `useConfirmDialog` confirmation (`settings.app.resetAllConfirm.*`), which says what is reset and what is kept. Confirming resets the app preferences, the session visual-effects override and the dashboard statistics settings (exclusions), and saves the server-side `includeTransfers` setting as `false`. Theme variant and color mode, accounts, transactions, categories and other data are kept. See [[docs/features/settings#instant-apply-model|Settings — Instant-Apply Model]] for the full list.

Admin and Monitors stay in the sidebar (ADR-180); they are not sections of the Settings window.

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

## i18n Keys

| Key pattern                                                         | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `settings.title`                                                    | Accessible name of the window and the tablist        |
| `settings.tab.{general,appearance,backup}`, `settings.section.{statistics,behavior,ai,about}` | Sidebar section names, also the title bar |
| `settings.autosaveHint`                                             | Caption at the bottom of the sidebar                 |
| `settings.group.{formatting,localeDisplay,colorMode,visualEffects}` | Group card titles                                    |
| `settings.dashboard.excludedCount.{one,other}`                      | Count badge on the exclusion groups (`tc()`)         |

ADR-183 removed `settings.done`, `settings.description`, `settings.saveHint`, `settings.section.*.desc`, `settings.app.identity` and `settings.dashboard.excluded`, and reworded the failure toasts to the "Couldn't …" form (`settings.backup.failed`, `settings.restore.failed`, `settings.backup.passphrase.saveFailed`, `settings.research.{save,clear}Failed`, `settings.agentCloak.statusError`); the restore confirmation button reads Restore.

---

## Testing Strategy

| Component               | Test Scope                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------- |
| DashboardSettingsDialog | Dialog open/close, accessible name and title bar, section nav, close button and Escape, canonical and retired section-id behavior |
| GeneralSection          | Currency/format selection, instant write to store                                      |
| StatisticsSection       | Category/recipient exclusion, scope selection, includeTransfers toggle                 |
| BehaviorSection         | Startup section select, auto-clear planned toggle, recurring reset confirmation        |
| AppearanceSection       | Theme variant, tier routing (capped vs uncapped display)                               |
| AiSection               | Ollama status display, model selector                                                  |
| BackupSection           | Directory picker, backup creation, encrypted restore flow (`BackupSection.test.tsx`)   |
| AboutSection            | Reset-all confirmation, onboarding restart                                             |

---

## Refactor History

| Phase                     | Date       | Change                                                                                                                     |
| ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase 3                   | 2026-04-23 | Monolith (~1400 lines) split into thin orchestrator + 5 tab components                                                     |
| April 25                  | 2026-04-25 | `useCallback` + functional updater pattern for stable callbacks; `React.memo()` on all tabs                                |
| ADR-075 addendum          | 2026-06-12 | Visual-effects tier Select + auto-adapt Switch added to AppearanceTab; `tierSelection` staged state in orchestrator        |
| ADR-084                   | 2026-06-18 | 5-tab Save/Cancel form → sidebar + instant-apply; `SettingsPrimitives`; section taxonomy rework; `tabs/` directory removed |
| ADR-104 addendum          | 2026-06-24 | Accessibility group added to AppearanceSection: Gain & loss colors Select (`colorblindGainLoss`)                           |
| Small-viewport robustness | 2026-08-10 | Section nav collapses to a horizontal scrolling chip bar below `md`; `md+` unchanged (PR #156)                             |
| ADR-183                   | 2026-10-06 | Settings window on the design system: sidebar as List/ListRow tabs, section name in the title bar, Done button and description removed, groups as Cards of rows, sentence-case copy and "Couldn't …" toasts |

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
