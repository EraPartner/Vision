---
title: Form Dialogs
type: component
status: active
date: 2026-10-07
updated: 2026-10-06
tags: [components, forms, dialogs, settings, refactor, phase-3]
description: Modal dialogs for adding, editing data, and configuring settings throughout the application
aliases:
  [
    form-dialogs,
    modal-dialogs,
    add-dialogs,
    edit-dialogs,
    create-dialog,
    settings-dialog,
  ]
related_code:
  [
    "apps/frontend/src/features/transactions/",
    "apps/frontend/src/features/categories/",
    "apps/frontend/src/features/recipients/",
    "apps/frontend/src/features/settings/",
    "apps/frontend/src/features/tax/TaxProfileDialog.tsx",
    "apps/frontend/src/features/tax/profile-steps/ProfileNumberInput.tsx",
  ]
---

# Form Dialogs

Modal dialog components for creating, editing data, and configuring application settings throughout Vision.

Every visible field label targets the actual input or trigger with matching `htmlFor` and `id`. Group headings are semantic text with an `id`; the radio, tab, or segmented-button group references it through `aria-labelledby`. Repeated row controls use explicit per-row accessible names.

## Component List

| Component           | Description                                         | File                                                                                                  |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AddTransactionSheet | Add new transaction (right-hand sheet, not a dialog) | [[apps/frontend/src/features/transactions/components/AddTransactionSheet.tsx\|AddTransactionSheet.tsx]] |
| AddCategoryDialog   | Add new category                                    | [[apps/frontend/src/features/categories/AddCategoryDialog.tsx\|AddCategoryDialog.tsx]]                |
| AddRecipientDialog  | Add new recipient                                   | [[apps/frontend/src/features/recipients/AddRecipientDialog.tsx\|AddRecipientDialog.tsx]]              |

---

## AddTransactionSheet

Right-hand `Sheet` (max width 470px) for creating transactions, introduced by [[docs/adr/181-home-transactions-redesign|ADR-181]]. It replaced the modal `AddTransactionDialog`. The file exports two components:

- `AddTransactionSheet` — the controlled sheet.
- `AddTransactionButton` — the primary "Add transaction" button together with the sheet it opens. Used in the Home and Transactions page headers.

### Props

```typescript
interface AddTransactionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once the row (for a transfer: its outflow leg) exists on the server. */
  onCreated?: (transaction: Transaction, kind: TransactionKind) => void;
}
```

`AddTransactionButton` accepts `onCreated`, `size` (`"default" | "sm"`) and `className`. Transactions selects the created row in the inspector; Home navigates to `/transactions` with `location.state.selectTransactionId`.

### Kind and sign

A segmented control picks **Expense**, **Income** or **Transfer** (`TransactionKind`). The amount field is a **magnitude**: the kind supplies the sign (`signedAmount`: income is positive, expense and the transfer outflow are negative). A typed minus is ignored rather than flipping the kind.

### Form fields

| Field              | Kinds             | Required | Description                                                                       |
| ------------------ | ----------------- | -------- | --------------------------------------------------------------------------------- |
| `amount`           | all               | Yes      | Magnitude, parsed with the app number format, non-zero                            |
| `recipient_id`     | expense, income   | Yes      | Debounced server-search `RecipientCombobox`; a typed new name can be created in place (`allowCreate`) |
| `bank_account`     | all               | Yes      | "From account" for a transfer; its currency fills `currency`                      |
| `to_bank_account`  | transfer          | Yes      | Receiving account; must differ from the sending one                               |
| `transaction_date` | all               | Yes      | Chips **Today** / **Yesterday** / **Other date** (opens the date picker)          |
| `category_id`      | expense, income   | No       | Pre-filled with the recipient's usual category until the user picks another       |
| `memo`, `comment`  | all               | No       | Description and comment                                                           |

A note appears when the chosen date is on or before the account's statement anchor date (backdated entry).

### Validation

Submit-time validation lives in `addTransactionForm.ts` (`createAddTransactionSchema`, a Zod discriminated union on `kind`, so every missing field is reported in one pass). Messages are i18n keys translated by the sheet and routed to each field through `useFieldErrors` (inline ARIA errors, focus on the first invalid field in `ADD_TRANSACTION_FIELD_ORDER`).

### Create flow

- **Expense / Income**: `useCreateTransaction({ silent: true })` posts one row. `silent` skips the generic "created" toast; the option was added to the hook in this change. A 409 conflict shows the `addTxn.duplicateError` toast and an inline "Add anyway" prompt.
- **Transfer**: `useCreateTransfer` (`features/transactions/hooks/useCreateTransfer.ts`) creates or gets a recipient named after the counterpart account for each leg (`POST /api/recipients`), posts the outflow and inflow rows with `POST /api/transactions`, then links them with `POST /api/transactions/transfers` (`{ aId, bId }`, `apiClient.markTransfer`). If the link call fails, both rows are kept; reconciliation or a manual mark can link them later. See [[docs/features/transfers]].

### Opening the sheet

- The header button (`AddTransactionButton`).
- The `?new=1` deep link: when `/transactions?new=1` is present the sheet opens and strips the param with `replace` navigation.
- Web shortcut: bare `N` (see [[docs/components/layout]]).

### Features

- Recipient, category and account selection use searchable comboboxes whose popovers mount in a sheet-owned portal container so Radix focus trapping stays reliable.
- Focus lands on the amount field when the sheet opens.
- Unsaved edits register with `UnsavedChangesContext`.
- The form resets and the sheet closes on success.

---

## AddCategoryDialog

Modal dialog for creating new categories.

### Form Fields

| Field         | Type   | Required | Description                         |
| ------------- | ------ | -------- | ----------------------------------- |
| `general`     | string | Yes      | General category (e.g., "FOOD")     |
| `detail`      | string | No       | Detail category (e.g., "GROCERIES") |
| `description` | string | No       | Optional description                |

### Category Format

Categories use `GENERAL:DETAIL` format:

```
FOOD:GROCERIES
FOOD:DINING
TRANSPORT:CAR
TRANSPORT:PUBLIC
```

### Usage

```tsx
import { AddCategoryDialog } from "@/features/categories/AddCategoryDialog";

function CategoriesPage() {
  return (
    <div>
      <AddCategoryDialog />
      {/* Category list */}
    </div>
  );
}
```

---

## AddRecipientDialog

Modal dialog for creating new recipients.

### Form Fields

| Field                 | Type   | Required | Description                         |
| --------------------- | ------ | -------- | ----------------------------------- |
| `name`                | string | Yes      | Recipient/merchant name             |
| `default_category_id` | number | No       | Default category for this recipient |
| `notes`               | string | No       | Notes about the recipient           |

### Usage

```tsx
import { AddRecipientDialog } from "@/features/recipients/AddRecipientDialog";

function RecipientsPage() {
  return (
    <div>
      <AddRecipientDialog />
      {/* Recipient list */}
    </div>
  );
}
```

---

## Dialog Patterns

All form dialogs follow a consistent pattern:

### Structure

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogTrigger asChild>
    <Button>Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
    </DialogHeader>
    <form onSubmit={handleSubmit}>
      {/* Form fields */}
      <DialogFooter>
        <Button type="button" variant="secondary">
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

### State Management

```tsx
// Form state
const [form, setForm] = useState({
  field1: "",
  field2: "",
});

// Update field
const updateField = (field, value) => {
  setForm((prev) => ({ ...prev, [field]: value }));
};

// Submit handler
const handleSubmit = (e) => {
  e.preventDefault();
  // Validate
  // Call mutation
};
```

### Unsaved-change protection

Heavyweight forms call `useUnsavedChanges(isDirty)` with a comparison against
their initial values. The application-level `UnsavedChangesProvider` aggregates
all registrations, blocks pathname navigation, and shows one localized
leave/stay dialog. It also protects browser refresh and window close through
`beforeunload`. Query-parameter updates are not blocked because filters and
shareable page state use replace-written search parameters during normal edits.

Import flows call `bypassNextNavigation()` immediately before their successful
review-page navigation. This is a one-shot exception for a persisted result; it
must not be used for cancel or error paths.

### Error Handling

```tsx
createMutation.mutate(data, {
  onSuccess: () => {
    // Reset form
    // Close dialog
    // Show success toast
  },
  onError: (error) => {
    // Show error toast
    // Handle specific errors (duplicates, validation)
  },
});
```

### Loading States

```tsx
<Button disabled={createMutation.isPending}>
  {createMutation.isPending && <Loader2 className="animate-spin" />}
  Save
</Button>
```

---

## Reusable Form Elements

Form dialogs use these shared components:

| Component           | Usage                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `RecipientCombobox` | Searchable recipient selector                                                                                             |
| `CategoryCombobox`  | Searchable category selector                                                                                              |
| `DatePicker`        | Popover date input with strict typed entry, month/year dropdowns, optional clear action, and app-language calendar labels |

For dialog-bound forms, comboboxes and date pickers can use a dialog-owned portal container to avoid overlay stacking issues:

```tsx
const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
  null,
);

<DialogContent>
  <div ref={setPortalContainer} />
  <DatePicker portalContainer={portalContainer} />
  <RecipientCombobox portalContainer={portalContainer} />
  <CategoryCombobox portalContainer={portalContainer} />
</DialogContent>;
```

### Example with Combobox

```tsx
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";

<RecipientCombobox
  value={form.recipient_id ? Number(form.recipient_id) : null}
  onSelect={(id) =>
    setForm((prev) => ({
      ...prev,
      recipient_id: id == null ? "" : String(id),
    }))
  }
/>;
```

---

## SplitTransactionDialog

Dialog for splitting a transaction's amount among multiple recipients.

**File:** [[apps/frontend/src/features/splits/SplitTransactionDialog.tsx]]

### Props

```typescript
interface SplitTransactionDialogProps {
  triggerLabel?: string;
  /** Replaces the default icon button (rendered through DialogTrigger asChild); the inspector footer passes a labelled ghost button. */
  trigger?: ReactElement;
  transactionId: number;
  transactionAmount: number;
  transactionCurrency: string;
}
```

### Features

- **Equal split mode**: Divides amount equally among all participants (user + selected recipients)
- **Custom amount mode**: Allows specifying individual amounts per recipient
- **Existing split awareness**: Shows existing splits and prevents exceeding transaction total
- **Validation**: Prevents submission if total splits exceed transaction amount or amounts are non-positive
- **Recipient selection**: Uses `RecipientCombobox` with portal container for dialog focus trap compatibility

### Usage

```tsx
import { SplitTransactionDialog } from "@/features/splits/SplitTransactionDialog";

<SplitTransactionDialog
  transactionId={txn.id}
  transactionAmount={txn.amount}
  transactionCurrency={txn.currency}
/>;
```

---

## TaxProfileDialog

Multi-step sheet/dialog for configuring the user's Belgian tax profile.

Numeric profile fields use a shared local-draft control. Stored zero values render as `0`, while
transitional decimal input such as `12.` remains visible during editing instead of being replaced
by the parsed number on each keystroke. Parseable drafts still update profile state immediately;
blur normalizes the display, and external profile changes resynchronize fields that are not focused.

**File:** [[apps/frontend/src/features/tax/TaxProfileDialog.tsx]]

### Props

```typescript
interface TaxProfileDialogProps {
  trigger?: ReactNode;
  initialStep?: Step; // 'employment' | 'income' | 'incomeSources' | 'exemptions' | 'region'
  targetYear?: number; // defaults to the live profile year
}
```

### Steps

| Step               | Description                                             | Fields                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Employment**     | Employment type selection                               | employee, civil_servant, self_employed, retired, other                                                                                                                                                             |
| **Income**         | Income and expense details                              | gross annual income, other taxable income, professional expense method (lump sum vs actual), cadastral income, additional residences                                                                               |
| **Income Sources** | Select transaction categories treated as taxable income | income category selection                                                                                                                                                                                          |
| **Deductions**     | Exemptions and dependents                               | dependent children, other dependents, alimony, pension contributions, life insurance, charitable donations, childcare costs, domestic help, mortgage interest, union dues, medical expenses, disability exemptions |
| **Region**         | Region and surcharge                                    | Flanders/Wallonia/Brussels, communal surcharge percentage                                                                                                                                                          |

### Usage

```tsx
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";

<TaxProfileDialog
  trigger={<Button>Configure Tax Profile</Button>}
  initialStep="income"
/>;
```

### Integration

- Uses `BelgianTaxProfileContext` for profile state management
- Sets `profileConfigured: true` on completion
- Each step navigates independently via the step progress bar

---

## OnboardingWizard

Multi-step onboarding wizard shown to first-time users.

**File:** [[apps/frontend/src/features/onboarding/OnboardingWizard.tsx]]

### Hook

```typescript
const { isComplete, isLoading, complete, reset } = useOnboarding();
```

- **`isComplete`**: Whether onboarding has been completed (checked via `onboarding_complete` setting)
- **`isLoading`**: Whether the completion status is being fetched
- **`complete()`**: Mark onboarding as done and persist to settings
- **`reset()`**: Reset onboarding state to show wizard again

### Props

```typescript
interface OnboardingWizardProps {
  open: boolean;
  onComplete: () => void;
  onOpenSettings?: (tab: string) => void;
}
```

### Steps

| Step             | Description                                                                                 | Actions                   |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| **Welcome**      | Greeting and feature badges                                                                 | Next                      |
| **Overview**     | Feature categories (Budgeting, Portfolio)                                                   | Next                      |
| **Bank Setup**   | Select a bank adapter from toggle buttons that expose the active choice with `aria-pressed` | Next                      |
| **Import**       | Upload CSV for selected bank                                                                | Import or skip            |
| **Categories**   | Create suggested categories (15 pre-defined)                                                | Create selected or skip   |
| **Feature Tour** | Navigate to any feature page                                                                | Navigate or next          |
| **Backup**       | Backup/restore information, restore from file (Electron only)                               | Open settings or complete |

### Features

- **Persistence**: Completion state is stored via `apiClient.getSetting/saveSetting` with key `onboarding_complete`; a versioned local draft restores resumable step input after reload and is cleared on completion/reset. Browser files are never persisted and must be selected again.
- **Bank adapter discovery**: Fetches available adapters via `apiClient.getSupportedParsers()`
- **Category bulk creation**: Creates selected categories with error handling for duplicates
- **CSV import**: Integrated import flow using `apiClient.importCSV()`
- **Backup restore**: Electron-only file picker for restoring from backup via `apiClient.restoreBackup()`
- **i18n**: All labels, descriptions, and toast messages are localized

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/api/transactions]] - Transactions API
- [[docs/api/categories]] - Categories API
- [[docs/api/recipients]] - Recipients API
- [[docs/api/splits]] - Splits API
- [[docs/features/transfers]] - Transfers (two-leg creation from the Transfer kind)
- [[docs/adr/181-home-transactions-redesign]] - Home and Transactions redesign (AddTransactionSheet)

## AddTransactionForm

Form state and validation for the Add Transaction sheet. This is a lightweight utility module (not a React component) that provides a typed form state interface, a factory function for initializing the form, the signing helper and the submit-time Zod schema.

### Type: AddTransactionFormState

| Field              | Type                                 | Description                                                  |
| ------------------ | ------------------------------------ | ------------------------------------------------------------ |
| `kind`             | `"expense" \| "income" \| "transfer"` | What the sheet records; supplies the sign of the amount      |
| `transaction_date` | `string`                             | ISO date string (YYYY-MM-DD), defaults to today              |
| `bank_account`     | `string`                             | Bank account name (sending account for a transfer)           |
| `account_id`       | `number \| null`                     | Resolved account id                                          |
| `to_bank_account`  | `string`                             | Transfer only: receiving account name                        |
| `to_account_id`    | `number \| null`                     | Transfer only: receiving account id                          |
| `recipient_id`     | `string`                             | Recipient ID (empty string if none)                          |
| `category_id`      | `string`                             | Category ID (empty string if none)                           |
| `memo`             | `string`                             | Transaction memo/description                                 |
| `amount`           | `string`                             | Magnitude as typed; the kind decides the sign on submit      |
| `currency`         | `string`                             | Currency code, defaults to EUR                               |
| `comment`          | `string`                             | Additional comment field                                     |

### Function: createAddTransactionFormState

```ts
function createAddTransactionFormState(
  defaultCurrency?: string,
  kind: TransactionKind = "expense",
): AddTransactionFormState;
```

Returns a fresh form state object with sensible defaults:

- `kind`: the given kind, `'expense'` by default
- `transaction_date`: Current date (YYYY-MM-DD)
- `bank_account`, `to_bank_account`, `recipient_id`, `category_id`, `memo`, `amount`, `comment`: Empty strings; `account_id` and `to_account_id`: `null`
- `currency`: Provided `defaultCurrency` or `'EUR'`

`signedAmount(kind, magnitude)` returns the API amount and `createAddTransactionSchema(numberFormat)` the submit-time schema (required rules per kind, non-zero amount, different accounts for a transfer).

### Usage

Used by [[apps/frontend/src/features/transactions/components/AddTransactionSheet.tsx|AddTransactionSheet]] to initialize, reset and validate the form state. The flat string-based state is designed for easy integration with controlled form inputs.

**Code**: [[apps/frontend/src/features/transactions/addTransactionForm.ts]]

---

## MergeRecipientsDialog

Two-step dialog for merging duplicate recipients. Users first select a primary recipient (via Command search), then select aliases to merge into it.

### Props

| Prop           | Type             | Description               |
| -------------- | ---------------- | ------------------------- |
| `open`         | `boolean`        | Dialog open state         |
| `onOpenChange` | `(open) => void` | Open state change handler |

### Flow

1. **Step 1**: Select primary recipient via searchable Command palette
2. **Step 2**: Select alias recipients to merge into the primary
3. Submit calls the merge API and refreshes the recipient list

### Features

- Uses `useMergeRecipients` hook for merge logic
- Paginates all recipients for the search dropdown
- Filters out already-aliased entries from the alias selection
- Portal container support for dialog focus trap compatibility

**Code**: [[apps/frontend/src/features/recipients/MergeRecipientsDialog.tsx]]

---

## VirtualDataTable

High-performance generic data table with virtual scrolling, inline editing, server-side search/sort, and infinite scroll. Used throughout the app for large datasets (transactions, recipients, categories).

### Props

| Prop               | Type                   | Description                                                              |
| ------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `title`            | `string`               | Table title displayed in card header                                     |
| `subtitle`         | `string?`              | Optional subtitle                                                        |
| `columns`          | `Column<T>[]`          | Column definitions (key, header, editable, sortable, filterable, render) |
| `data`             | `T[]`                  | Array of row data                                                        |
| `emptyMessage`     | `ReactNode?`           | Content shown when no data                                               |
| `actions`          | `ReactNode?`           | Action buttons rendered in header                                        |
| `onRowUpdate`      | `(index, row) => void` | Callback when inline-edited row is saved                                 |
| `onRowDoubleClick` | `(row, index) => void` | Callback on double-click (e.g., deep link to Transactions)               |
| `totalItems`       | `number?`              | Total items on server (for infinite scroll)                              |
| `isFetchingMore`   | `boolean?`             | Loading state for infinite scroll                                        |
| `onLoadMore`       | `() => void`           | Called when user scrolls near bottom                                     |
| `hasMore`          | `boolean?`             | Whether more items are available                                         |
| `onSearchChange`   | `(query) => void`      | Server-side search callback                                              |
| `searchValue`      | `string?`              | Controlled search value                                                  |
| `onSortChange`     | `(key, dir) => void`   | Server-side sort callback (enables server-sort mode)                     |
| `sortKeyProp`      | `string?`              | Controlled sort key                                                      |
| `sortDirProp`      | `SortDirection?`       | Controlled sort direction                                                |
| `maxHeight`        | `number?`              | Virtual scroll container height (default: 600)                           |
| `rowHeight`        | `number?`              | Estimated row height for virtualizer                                     |
| `cancelEditingRef` | `Ref?`                 | Ref to expose cancelEditing externally                                   |
| `onEditingChange`  | `(editing) => void`    | Callback when editing state changes                                      |

### Column Definition

```ts
interface Column<T> {
  key: string; // Data key
  header: string; // Display header
  editable?: boolean; // Enable inline editing
  type?: "text" | "number" | "date";
  render?: (row, editing, index) => ReactNode; // Custom cell renderer
  sortable?: boolean; // Enable column sorting
  filterable?: boolean; // Enable column filter popover
  minWidth?: number;
  defaultWidth?: number;
}
```

### Features

- **Virtual scrolling** via `@tanstack/react-virtual` — renders only visible rows
- **Inline editing** — double-click editable cells, save/cancel actions
- **Server-side search** — debounced search with `onSearchChange`
- **Server-side sorting** — controlled sort via `onSortChange` + `sortKeyProp`/`sortDirProp`
- **Infinite scroll** — `onLoadMore` triggered near bottom
- **Column filtering** — popover-based per-column filters
- **Deferred rendering** — uses `useDeferredValue` for smooth search UX

### Usage

```tsx
<VirtualDataTable
  title="Transactions"
  columns={columns}
  data={transactions}
  onRowUpdate={handleUpdate}
  onSearchChange={setSearchQuery}
  onSortChange={handleSort}
  sortKeyProp={sortKey}
  sortDirProp={sortDir}
  onLoadMore={loadMore}
  hasMore={hasMore}
/>
```

**Code**: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]]

## SuggestedDeductionsCard

Analyzes the user's Belgian tax profile and generates a list of missed or available tax deductions.

### Props

No props — reads tax profile from context.

### Features

- Analyzes Belgian tax profile for deduction opportunities
- Covers: pension savings, life insurance, group insurance, charitable donations, childcare, domestic help, alimony
- Shows estimated tax savings per deduction
- CTA button opens the [[apps/frontend/src/features/tax/TaxProfileDialog.tsx|TaxProfileDialog]]
- No props required — reads from BelgianTaxProfileContext

**Code**: [[apps/frontend/src/features/tax/SuggestedDeductionsCard.tsx]]

---

## MergeRecipientsDialog

Two-step dialog for merging duplicate recipients.

### Props

| Prop           | Type                      | Description                |
| -------------- | ------------------------- | -------------------------- |
| `open`         | `boolean`                 | Controls dialog visibility |
| `onOpenChange` | `(open: boolean) => void` | Visibility change handler  |

### Flow

1. **Step 1**: User selects a primary recipient via Command search
2. **Step 2**: User selects alias recipients to merge into the primary
3. Uses `useMergeRecipients` hook for the merge operation
4. Paginates all recipients and filters out already-aliased entries

**Code**: [[apps/frontend/src/features/recipients/MergeRecipientsDialog.tsx]]

---

## UpdateNotification (removed)

The update badge and dialog were removed by [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]; no dialog opens for updates any more. `useUpdateStatus` polls `apiClient.checkForUpdates()` every 5 minutes while the tab is visible and drives a dot on the sidebar's Settings row. Settings › About shows the version, release notes and the check / install actions (install with backup, download and restart phases, Electron only). See [[docs/features/application-updates|Application updates]].

**Code**: [[apps/frontend/src/hooks/useUpdateStatus.ts]], [[apps/frontend/src/features/settings/sections/AboutSection.tsx]]

---

## UpcomingPaymentsNotification

Displays upcoming planned payments for the next 7 days.

### Props

No props.

### Features

- Fetches active planned transactions for the next 7 days
- Filters out executed one-time payments
- Renders a dismissible Alert showing up to 5 upcoming payments
- Each payment shows memo, date, and formatted amount
- Dismissed IDs persisted in `localStorage`
- "View All" link navigates to `/planned`

**Code**: [[apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx]]

---

## DashboardSettingsDialog (Phase 3 Refactor)

Multi-tab settings dialog for configuring user preferences, display settings, dashboard exclusions, backup options, and application behavior. Originally a ~1400-line monolith, refactored into 6 focused components.

**Full Documentation**: See [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog Documentation]]

### Component Structure

The dialog is split into a thin orchestrator and 6 focused tab/section components:

| Component                 | Lines          | Purpose                                                                          |
| ------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `DashboardSettingsDialog` | ~170           | Orchestrator, owns save logic and exclusion state                                |
| `GeneralTab`              | ~175           | Currency, date/number format, decimal places, start-of-week, page size, language |
| `AppearanceTab`           | (pre-existing) | Theme variant, color mode, schedule                                              |
| `DashboardTab`            | ~240           | Category/recipient exclusion, exclusion scope                                    |
| `AppTab`                  | ~230           | Onboarding restart, update check, recurring reset, AI chat, reset-all            |
| `BackupTab`               | ~310           | Backup dir, passphrase, encrypt, restore (Electron only)                         |
| `AIChatSettingsSection`   | ~92            | Ollama status + model selector                                                   |

### Props

```typescript
interface DashboardSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: string; // 'general' | 'appearance' | 'dashboard' | 'app' | 'backup'
}
```

### Features

- **5 tabs**: General (formatting), Appearance (theme), Dashboard (exclusions), App (maintenance), Backup (Electron only)
- **Thin orchestrator pattern**: Parent owns save-time state; tabs are pure presenters
- **State isolation**: BackupTab manages its own internal state (passphrase, encrypt) without propagating to parent
- **React Query integration**: Fetches categories/recipients on demand for exclusion UI
- **Electron support**: Backup directory picker, auto-backup-on-quit, restore flow
- **Confirmation dialogs**: Reset-all asks first through the destructive `useConfirmDialog` confirmation (since 2026-10-05; see [[docs/components/form-dialogs#reset-all|Reset All]])

### Usage

```tsx
import { DashboardSettingsDialog } from "@/features/settings/DashboardSettingsDialog";
import { useState } from "react";

function SettingsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Settings</Button>
      <DashboardSettingsDialog
        open={open}
        onOpenChange={setOpen}
        defaultTab="general"
      />
    </>
  );
}
```

### Key Methods

#### Orchestrator Save Logic

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
  toast.success(t("settings.saved"));
};
```

Persists all modified settings, closes the dialog, and shows success toast. Called on Save button click.

#### Reset All

> [!info] 2026-10-05: reset asks first
> The orchestrator `handleReset()` that reset immediately is gone. **Reset all settings** lives in the danger zone of `AboutSection`, and its `handleResetAll()` asks first through the destructive `useConfirmDialog` confirmation. The dialog text says that all preferences return to their defaults and that the theme, accounts, transactions and other data are kept. See [[docs/components/dashboard-settings-dialog#aboutsection|DashboardSettingsDialog — AboutSection]].

```typescript
const handleResetAll = async () => {
  const confirmed = await confirm({
    title: t("settings.app.resetAllConfirm.title"),
    description: t("settings.app.resetAllConfirm.desc"),
    confirmLabel: t("settings.app.resetAllConfirm.action"),
    variant: "destructive",
  });
  if (!confirmed) return;
  resetSettings();
  resetAppSettings(); // also clears the session tier override
  apiClient
    .saveSetting("includeTransfers", false)
    .then(() => queryClient.invalidateQueries())
    .catch(() => {
      /* non-fatal */
    });
  toast.info(t("settings.resetToDefaults"));
};
```

Cancelling changes nothing. Confirming resets the app and dashboard settings to their defaults and keeps the dialog open.

### Related Code

- Settings Context: `[[apps/frontend/src/stores/hydration/SettingsHydration.tsx]]`
- App Settings Context: `[[apps/frontend/src/stores/hydration/AppSettingsHydration.tsx]]`
- Settings API: `[[apps/node-backend/src/routes/settings.ts]]`

---

## Related Documentation

- [[docs/components/index|Components Index]] - All components
- [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog]] - Full settings dialog documentation
- [[docs/features/settings|Settings Feature]] - Settings system overview
- [[docs/api/settings|Settings API]] - Backend API endpoints
- [[docs/api/transactions|Transactions API]] - Transactions API
- [[docs/api/categories|Categories API]] - Categories API
- [[docs/api/recipients|Recipients API]] - Recipients API
- [[docs/api/splits|Splits API]] - Splits API
