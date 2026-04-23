---
title: DashboardSettingsDialog
type: component
status: active
date: 2026-04-23
tags: [components, forms, dialogs, settings, refactor, phase-3]
description: Multi-tab settings dialog split into 6 focused components for better maintainability and testing
aliases: [settings-dialog, dashboard-settings, DashboardSettingsDialog]
related_code:
  - apps/frontend/src/components/settings/DashboardSettingsDialog.tsx
  - apps/frontend/src/components/settings/tabs/GeneralTab.tsx
  - apps/frontend/src/components/settings/tabs/DashboardTab.tsx
  - apps/frontend/src/components/settings/tabs/AppTab.tsx
  - apps/frontend/src/components/settings/tabs/BackupTab.tsx
  - apps/frontend/src/components/settings/AIChatSettingsSection.tsx
  - apps/frontend/src/components/settings/AppearanceTab.tsx
---

# DashboardSettingsDialog

Multi-tab settings dialog for configuring user preferences, display settings, dashboard exclusions, backup options, and application behavior. Originally a ~1400-line monolith, refactored into 6 focused components following the thin-orchestrator pattern.

> [!info] Phase 3 Refactor
> **Date**: 2026-04-23
> **Reason**: Code cohesion, file size compliance (<800 lines), independent testability
> **Pattern**: Thin orchestrator owns state and save logic; tab components are pure presenters

## Architecture

### Component Hierarchy

```
DashboardSettingsDialog (orchestrator, ~170 lines)
├── GeneralTab (currency, date/number format, decimal places, start-of-week, page size, language)
├── AppearanceTab (theme variant, color mode, schedule) [pre-existing, unchanged]
├── DashboardTab (category/recipient exclusion, exclusion scope, exclude hidden toggle)
├── AppTab (onboarding restart, update check/apply, recurring dismissal reset, AI chat, reset-all)
└── BackupTab (backup dir, passphrase, encrypt toggle, restore UI, AlertDialog for restore)
    └── BackupTab also owns internal backup state (dir, passphrase, encrypt, showRestore)
```

### State Ownership

| State | Owner | Scope | Purpose |
|-------|-------|-------|---------|
| `activeTab` | DashboardSettingsDialog | UI | Currently visible tab |
| `localExcludedCategories` | DashboardSettingsDialog | Save | Categories to exclude from stats |
| `localExcludedRecipients` | DashboardSettingsDialog | Save | Recipients to exclude from stats |
| `localExcludeHidden` | DashboardSettingsDialog | Save | Auto-exclude inactive categories |
| `localExclusionScope` | DashboardSettingsDialog | Save | Where exclusions apply (everywhere/statistics/nowhere) |
| `localAppSettings` | DashboardSettingsDialog | Save | Currency, date format, number format, decimal places, start-of-week, page size, language, aiDefaultModel |
| `backupDir` | DashboardSettingsDialog | Save | Electron backup directory path |
| `backupOnQuit` | DashboardSettingsDialog | Save | Electron auto-backup-on-exit toggle |
| **BackupTab internal state** | BackupTab | Local | passphrase, encrypt, showRestore, tempPassphrase, tempEncrypt (not persisted to dialog state) |

---

## DashboardSettingsDialog

Thin orchestrator component. Owns save-time state and dialog open/close logic.

### Props

```typescript
interface DashboardSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: string; // 'general' | 'appearance' | 'dashboard' | 'app' | 'backup' (default: 'general')
}
```

### Features

- **Tabs**: 5 tabs (General, Appearance, Dashboard, App, Backup)
- **Save logic**: Persists exclusions, app settings, and backup config
- **Reset logic**: Resets all settings to defaults
- **Categories/Recipients fetching**: Uses React Query to fetch all categories and recipients (staleTime: 60s, limit: 1000)
- **Controlled sync**: When `open` changes, reinitializes all local state from context to avoid stale data

### Key Methods

#### `handleSave()`

```typescript
const handleSave = () => {
  updateSettings({
    excludedCategoryIds: localExcludedCategories,
    excludedRecipientIds: localExcludedRecipients,
    excludeHiddenCategories: localExcludeHidden,
    exclusionScope: localExclusionScope,
  });
  updateAppSettings(localAppSettings);
  if (apiClient.isElectron()) {
    apiClient.saveBackupSettings({ backupDir, backupOnQuit });
  }
  onOpenChange(false);
  toast.success(t('settings.saved'));
};
```

Persists all modified settings, closes the dialog, and shows success toast.

#### `handleReset()`

```typescript
const handleReset = () => {
  resetSettings();
  resetAppSettings();
  setLocalExcludedCategories([]);
  setLocalExcludedRecipients([]);
  setLocalExcludeHidden(true);
  setLocalExclusionScope('everywhere');
  setLocalAppSettings(defaultAppSettings);
  toast.info(t('settings.resetToDefaults'));
};
```

Resets all settings and local state. Dialog remains open. Called via AppTab "Reset All" button.

### State Synchronization

On `open` change, the component reinitializes all local state:

```typescript
useEffect(() => {
  if (!open) return;
  setLocalExcludedCategories(settings.excludedCategoryIds);
  setLocalExcludedRecipients(settings.excludedRecipientIds);
  setLocalExcludeHidden(settings.excludeHiddenCategories);
  setLocalExclusionScope(settings.exclusionScope);
  setLocalAppSettings(appSettings);
  // BackupTab handles its own initialization via the open prop
}, [open, settings, appSettings]);
```

This ensures:
- User cancellations discard unsaved changes
- Re-opening reflects latest context values
- BackupTab receives the `open` prop to handle its own initialization (Electron-specific)

### Usage

```tsx
import { DashboardSettingsDialog } from "@/components/settings/DashboardSettingsDialog";
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

## GeneralTab

Tab component for general application settings: currency, date format, number format, decimal places, start-of-week, page size, and language.

### File

`[[apps/frontend/src/components/settings/tabs/GeneralTab.tsx]]`

### Props

```typescript
interface GeneralTabProps {
  localAppSettings: AppSettings;
  onUpdate: (s: AppSettings) => void;
}
```

### Features

- **Currency**: 30+ supported currencies (EUR, USD, GBP, etc.)
- **Date Format**: 5 format options (DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, etc.)
- **Number Format**: 4 locale formats (European, US, Swiss, Indian)
- **Decimal Places**: 0-8 digits
- **Start of Week**: Sunday or Monday
- **Page Size**: Default table rows (10, 20, 50, 100, 200)
- **Language**: en, nl (more via i18n config)

### UI Pattern

Each setting uses a labeled Select droplet with optional hint text:

```tsx
<div className="space-y-2">
  <Label className="text-sm font-semibold">{t('settings.general.currency')}</Label>
  <Select
    value={localAppSettings.defaultCurrency}
    onValueChange={(v) => onUpdate({ ...localAppSettings, defaultCurrency: v })}
  >
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {/* items */}
    </SelectContent>
  </Select>
  <p className="text-xs text-muted-foreground">{t('settings.general.currencyHint')}</p>
</div>
```

Wrapped in `ScrollArea` for overflow handling.

---

## AppearanceTab

Tab component for theme and visual preferences: theme variant, color mode, and schedule.

### File

`[[apps/frontend/src/components/settings/AppearanceTab.tsx]]`

### Features

- **Theme Variant**: light, dark, custom (configurable via `theme_settings`)
- **Color Mode**: system, light, dark, schedule (time-based switching)
- **Schedule**: Start/end times for scheduled mode
- Uses Radix UI Tabs + Dialog for schedule configuration

---

## DashboardTab

Tab component for configuring dashboard exclusions: which categories and recipients to exclude from statistics and charts.

### File

`[[apps/frontend/src/components/settings/tabs/DashboardTab.tsx]]`

### Props

```typescript
interface DashboardTabProps {
  categories: Category[];
  recipients: Recipient[];
  isLoading: boolean;
  excludedCategories: number[];
  setExcludedCategories: (ids: number[]) => void;
  excludedRecipients: number[];
  setExcludedRecipients: (ids: number[]) => void;
  excludeHidden: boolean;
  setExcludeHidden: (exclude: boolean) => void;
  exclusionScope: ExclusionScope;
  setExclusionScope: (scope: ExclusionScope) => void;
}
```

### Features

- **Category Search**: Searchable multiselect with `categorySearch` local state
- **Recipient Search**: Searchable multiselect with `recipientSearch` local state
- **Exclude Hidden**: Toggle to auto-exclude inactive (hidden) categories
- **Exclusion Scope**: Radio group to select where exclusions apply:
  - `'everywhere'`: All pages and calculations
  - `'statistics'`: Statistics and related pages only
  - `'nowhere'`: Exclusions disabled
- **Visual feedback**: Shows selected count per category/recipient
- **Loading state**: Skeleton placeholders while categories/recipients fetch

### UI Pattern

Two-column layout: categories on left, recipients on right. Each uses a Popover-based multiselect UI.

```tsx
<div className="grid grid-cols-2 gap-4">
  {/* Category Multiselect */}
  <div>
    <Label>Categories to Exclude</Label>
    <Input
      placeholder="Search categories..."
      value={categorySearch}
      onChange={(e) => setCategorySearch(e.target.value)}
    />
    {/* Filtered list of checkboxes */}
  </div>

  {/* Recipient Multiselect */}
  <div>
    {/* Similar structure */}
  </div>
</div>

{/* Exclusion Scope */}
<RadioGroup value={exclusionScope} onValueChange={setExclusionScope}>
  <Label><Radio value="everywhere" /> Apply everywhere</Label>
  <Label><Radio value="statistics" /> Statistics pages only</Label>
  <Label><Radio value="nowhere" /> Disabled</Label>
</RadioGroup>
```

### Related API

- [[docs/features/settings|Settings Feature]] — Exclusion scope documentation
- [[docs/api/info|Info & Analytics API]] — Endpoints affected by exclusions

---

## AppTab

Tab component for application maintenance and advanced settings: onboarding restart, update check/apply, recurring dismissal reset, AI chat settings, and full reset.

### File

`[[apps/frontend/src/components/settings/tabs/AppTab.tsx]]`

### Props

```typescript
interface AppTabProps {
  aiDefaultModel: string | undefined;
  onAiModelChange: (model: string) => void;
  onReset: () => void;           // Calls handleReset() from DashboardSettingsDialog
  onOpenChange: (open: boolean) => void;
  dateFormat: string;
}
```

### Features

- **Onboarding Restart**: Button to reset onboarding completion and reshow wizard
  - Calls `useOnboarding().reset()`
  - Closes settings dialog
  - Re-opens onboarding modal
- **Update Check**: Button to manually check for application updates
  - Calls `apiClient.checkForUpdates()`
  - Shows `checkingUpdate` loading state
  - Displays available version and release notes
  - Install button calls `apiClient.installShellUpdate()` with phase tracking
- **Recurring Dismissal Reset**: Button to clear all dismissed recurring transaction suggestions
  - Calls `apiClient.resetRecurringDismissals()`
  - Shows confirmation before proceeding
- **AI Chat Settings**: Integrated via `[[#AIChatSettingsSection|AIChatSettingsSection]]` component
  - Displays Ollama status and model selector
  - Integrated with llm.mcp conversation plugin
- **Reset All Settings**: Button to revert all settings to defaults
  - Shows confirmation dialog
  - Calls `onReset()` passed from parent
  - Resets currency, date/number formats, exclusions, theme, widget visibility, etc.

### Internal State

```typescript
const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
const [checkingUpdate, setCheckingUpdate] = useState(false);
const [applyPhase, setApplyPhase] = useState<'pulling' | 'restarting' | 'done'>('pulling');
```

### UI Pattern

Stack of button groups, each wrapped in a card or section with explanatory text:

```tsx
<div className="space-y-6">
  {/* Onboarding */}
  <div>
    <h3 className="text-sm font-semibold">Restart Onboarding</h3>
    <Button onClick={handleRestartOnboarding}>Restart</Button>
  </div>

  {/* Update Check */}
  <div>
    <h3 className="text-sm font-semibold">Check for Updates</h3>
    <Button onClick={handleCheckUpdate} disabled={checkingUpdate}>
      {checkingUpdate ? 'Checking...' : 'Check for Updates'}
    </Button>
    {updateStatus && /* show update dialog */}
  </div>

  {/* AI Chat Settings */}
  <AIChatSettingsSection
    value={aiDefaultModel}
    onChange={onAiModelChange}
  />

  {/* Reset All */}
  <div>
    <h3 className="text-sm font-semibold">Reset All Settings</h3>
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Reset All to Defaults</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogDescription>
          This will reset all settings to defaults. This action cannot be undone.
        </AlertDialogDescription>
        <AlertDialogAction onClick={onReset}>Reset</AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</div>
```

---

## BackupTab

Tab component for managing application backups: directory selection, passphrase protection, encryption, and restore functionality (Electron only).

### File

`[[apps/frontend/src/components/settings/tabs/BackupTab.tsx]]`

### Props

```typescript
interface BackupTabProps {
  open: boolean;
  backupDir: string;
  setBackupDir: (dir: string) => void;
  backupOnQuit: boolean;
  setBackupOnQuit: (quit: boolean) => void;
}
```

### Internal State

Managed independently within BackupTab; not propagated to parent:

```typescript
const [backupPassphrase, setBackupPassphrase] = useState('');
const [backupEncrypt, setBackupEncrypt] = useState(false);
const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
const [tempPassphrase, setTempPassphrase] = useState('');
const [tempEncrypt, setTempEncrypt] = useState(false);
```

### Features

- **Backup Directory**: Path input for backup storage location
  - Button to open file picker (Electron only)
  - Displays current directory or placeholder
  - Persisted via `setBackupDir` callback

- **Backup on Quit**: Toggle to enable automatic backup on application exit
  - Persisted via `setBackupOnQuit` callback
  - Only applies in Electron desktop builds

- **Encryption**: Toggle to encrypt backups with AES-256-GCM
  - Shows passphrase input when enabled
  - Passphrase must be >6 characters
  - Persisted separately (not in settings context)

- **Create Backup**: Button to create an immediate backup
  - Shows progress UI with file path
  - Calls `apiClient.createBackup()`
  - Toast notification on success/failure

- **Restore Backup**: Button to restore from backup file
  - Opens file picker to select `.backup` file
  - Shows restore confirmation dialog with passphrase input (if encrypted)
  - `AlertDialog` with custom portal container to avoid modal stacking
  - Calls `apiClient.restoreBackup(file, passphrase?)`
  - Requires app restart after restore

### UI Pattern

Stacked sections with descriptive labels and helper text:

```tsx
<ScrollArea className="h-full pr-4">
  <div className="space-y-6 py-4">
    {/* Backup Directory */}
    <div className="space-y-2">
      <Label>Backup Directory</Label>
      <div className="flex gap-2">
        <Input
          placeholder="/path/to/backups"
          value={backupDir}
          onChange={(e) => setBackupDir(e.target.value)}
          readOnly
        />
        <Button onClick={handlePickDirectory}>Browse</Button>
      </div>
    </div>

    {/* Backup on Quit */}
    <div className="flex items-center justify-between">
      <Label>Backup on Quit</Label>
      <Switch checked={backupOnQuit} onCheckedChange={setBackupOnQuit} />
    </div>

    {/* Encryption */}
    <div className="space-y-2">
      <Label>Encrypt Backups</Label>
      <Switch checked={backupEncrypt} onCheckedChange={setBackupEncrypt} />
      {backupEncrypt && (
        <Input
          type="password"
          placeholder="Passphrase (min 6 characters)"
          value={backupPassphrase}
          onChange={(e) => setBackupPassphrase(e.target.value)}
        />
      )}
    </div>

    {/* Create Backup */}
    <Button onClick={handleCreateBackup} className="w-full">
      Create Backup Now
    </Button>

    {/* Restore Backup */}
    <Button onClick={handleRestoreBackup} variant="secondary" className="w-full">
      Restore from Backup
    </Button>

    {/* Restore Confirmation AlertDialog */}
    <AlertDialog open={showRestoreConfirm} onOpenChange={setShowRestoreConfirm}>
      <AlertDialogContent portalContainer={portalContainer}>
        <AlertDialogTitle>Restore from Backup?</AlertDialogTitle>
        <AlertDialogDescription>
          This will replace all current data. The application will restart.
        </AlertDialogDescription>
        {selectedFile?.encrypted && (
          <Input
            type="password"
            placeholder="Backup Passphrase"
            value={tempPassphrase}
            onChange={(e) => setTempPassphrase(e.target.value)}
          />
        )}
        <AlertDialogAction onClick={handleRestoreConfirm}>
          Restore
        </AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</ScrollArea>
```

### Initialization Behavior

BackupTab receives the `open` prop and initializes backup directory on mount and when dialog opens:

```typescript
useEffect(() => {
  if (!open) return;
  (async () => {
    if (apiClient.isElectron()) {
      const settings = await apiClient.getBackupSettings();
      setBackupDir(settings?.backupDir || '');
      setBackupOnQuit(settings?.backupOnQuit || false);
    }
  })();
}, [open]);
```

This ensures BackupTab state is synced with Electron settings on dialog open, independent of the parent orchestrator.

### Related API

- `[[apps/node-backend/src/routes/backup.js]]` — Backup and restore endpoints
- `[[docs/features/settings|Settings Feature]]` — Backup configuration

---

## AIChatSettingsSection

Reusable section for AI chat model configuration. Shows Ollama connection status and model selector.

### File

`[[apps/frontend/src/components/settings/AIChatSettingsSection.tsx]]`

### Props

```typescript
interface AIChatSettingsSectionProps {
  value: string | undefined;
  onChange: (model: string) => void;
}
```

### Features

- **Status Indicator**: Shows Ollama connection status (connected/disconnected)
  - Uses `useOllamaStatus()` hook
  - Shows green dot + "Connected" or red dot + "Not Connected"
- **Model Selector**: Dropdown of available models
  - Uses `useOllamaModels()` hook
  - Fetches from `apiClient.getOllamaModels()`
  - Falls back to empty list if Ollama unavailable
- **Help Text**: Information about Ollama setup and model requirements

### Internal Hooks

- `useOllamaStatus()` — Polling hook that checks Ollama connection status
- `useOllamaModels()` — Hook that fetches available models from Ollama

### Usage

```tsx
<AIChatSettingsSection
  value={aiDefaultModel}
  onChange={(model) => setLocalAppSettings({ ...localAppSettings, aiDefaultModel: model })}
/>
```

Used in [[#AppTab|AppTab]].

---

## Related Documentation

- [[docs/features/settings|Settings Feature]] — Complete settings system overview
- [[docs/api/settings|Settings API]] — Backend endpoints and schema
- [[docs/components/index|Components Index]] — All frontend components
- [[docs/reference/frontend-api-client|Frontend API Client]] — API methods used by settings dialog

## Related Code

- Settings Context: `[[apps/frontend/src/contexts/SettingsContext.tsx]]`
- App Settings Context: `[[apps/frontend/src/contexts/AppSettingsContext.tsx]]`
- API Client: `[[apps/frontend/src/lib/api.ts]]`
- Settings API: `[[apps/node-backend/src/routes/settings.js]]`

## Refactor Rationale

**Before**: One monolithic `DashboardSettingsDialog.tsx` (~1400 lines)
- Poor cohesion: General settings, dashboard exclusions, backup, and app maintenance logic intermingled
- Hard to test individual features
- Violated <800-line file size rule
- Cognitive overhead when making changes

**After**: 6 focused components (~170 + 175 + 240 + 230 + 310 + 92 lines = 1217 lines across files)
- Each tab is a single concern (currency/format, exclusions, maintenance, backup)
- Independent unit testability
- Clear prop contracts
- Easier to navigate and modify
- Follows thin-orchestrator pattern established in Phase 3

## Testing Strategy

| Component | Test Scope |
|-----------|-----------|
| DashboardSettingsDialog | Dialog open/close, save flow, reset confirmation, state sync on open change |
| GeneralTab | Currency/format selection, changes reflected in local state |
| DashboardTab | Category/recipient exclusion, scope selection, search filtering |
| AppTab | Onboarding restart, update check, reset-all confirmation |
| BackupTab | Directory picker, backup creation, restore flow, encryption |
| AIChatSettingsSection | Ollama status display, model selector |

All components export named types for easy mock creation.
