---
title: Form Dialogs
type: component
status: active
date: 2026-03-31
tags: [components, forms, dialogs]
description: Modal dialogs for adding and editing data throughout the application
related_code: ["apps/frontend/src/components/forms"]
---

# Form Dialogs

Modal dialog components for creating and editing data throughout Vision.

## Component List

| Component | Description | File |
|-----------|-------------|------|
| AddTransactionDialog | Add new transaction | [[apps/frontend/src/components/forms/AddTransactionDialog.tsx\|AddTransactionDialog.tsx]] |
| AddCategoryDialog | Add new category | [[apps/frontend/src/components/forms/AddCategoryDialog.tsx\|AddCategoryDialog.tsx]] |
| AddRecipientDialog | Add new recipient | [[apps/frontend/src/components/forms/AddRecipientDialog.tsx\|AddRecipientDialog.tsx]] |

---

## AddTransactionDialog

Modal dialog for creating new transactions.

### Props

```typescript
// No props - component manages its own state
```

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transaction_date` | date | Yes | Transaction date |
| `bank_account` | string | Yes | Bank account name |
| `recipient_id` | number | Yes | Recipient ID |
| `category_id` | number | No | Category ID |
| `amount` | number | Yes | Transaction amount |
| `currency` | string | No | Currency code (default: EUR) |
| `memo` | string | No | Description/memo |
| `comment` | string | No | User comment |

### Usage

```tsx
import { AddTransactionDialog } from "@/components/forms/AddTransactionDialog";

function TransactionsPage() {
  return (
    <div>
      <AddTransactionDialog />
      {/* Transaction list */}
    </div>
  );
}
```

### Features

- Auto-populates today's date
- Fetches recipients/categories from API
- Validates required fields
- Shows loading state during submission
- Handles duplicate detection
- Resets form on successful submission
- Closes dialog on success

### Amount Convention

- **Negative** = Expense
- **Positive** = Income

---

## AddCategoryDialog

Modal dialog for creating new categories.

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `general` | string | Yes | General category (e.g., "FOOD") |
| `detail` | string | No | Detail category (e.g., "GROCERIES") |
| `description` | string | No | Optional description |

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
import { AddCategoryDialog } from "@/components/forms/AddCategoryDialog";

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Recipient/merchant name |
| `default_category_id` | number | No | Default category for this recipient |
| `notes` | string | No | Notes about the recipient |

### Usage

```tsx
import { AddRecipientDialog } from "@/components/forms/AddRecipientDialog";

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
        <Button type="button" variant="secondary">Cancel</Button>
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
  setForm(prev => ({ ...prev, [field]: value }));
};

// Submit handler
const handleSubmit = (e) => {
  e.preventDefault();
  // Validate
  // Call mutation
};
```

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

| Component | Usage |
|-----------|-------|
| `RecipientCombobox` | Searchable recipient selector |
| `CategoryCombobox` | Searchable category selector |
| `DatePicker` | Popover calendar date selector with optional clear action |

For dialog-bound forms, comboboxes and date pickers can use a dialog-owned portal container to avoid overlay stacking issues:

```tsx
const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

<DialogContent>
  <div ref={setPortalContainer} />
  <DatePicker portalContainer={portalContainer} />
  <RecipientCombobox portalContainer={portalContainer} />
  <CategoryCombobox portalContainer={portalContainer} />
</DialogContent>
```

### Example with Combobox

```tsx
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";

<RecipientCombobox
  value={form.recipient_id}
  onChange={(id) => setForm(prev => ({ ...prev, recipient_id: id }))}
/>
```

---

## SplitTransactionDialog

Dialog for splitting a transaction's amount among multiple recipients.

**File:** [[apps/frontend/src/components/splits/SplitTransactionDialog.tsx]]

### Props

```typescript
interface SplitTransactionDialogProps {
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
import { SplitTransactionDialog } from "@/components/splits/SplitTransactionDialog";

<SplitTransactionDialog
  transactionId={txn.id}
  transactionAmount={txn.amount}
  transactionCurrency={txn.currency}
/>
```

---

## TaxProfileDialog

Multi-step sheet/dialog for configuring the user's Belgian tax profile.

**File:** [[apps/frontend/src/components/tax/TaxProfileDialog.tsx]]

### Props

```typescript
interface TaxProfileDialogProps {
  trigger?: ReactNode;
  initialStep?: Step; // 'employment' | 'income' | 'exemptions' | 'region'
}
```

### Steps

| Step | Description | Fields |
|------|-------------|--------|
| **Employment** | Employment type selection | employee, civil_servant, self_employed, retired, other |
| **Income** | Income and expense details | gross annual income, other taxable income, professional expense method (lump sum vs actual), cadastral income, additional residences |
| **Deductions** | Exemptions and dependents | dependent children, other dependents, alimony, pension contributions, life insurance, charitable donations, childcare costs, domestic help, mortgage interest, union dues, medical expenses, disability exemptions |
| **Region** | Region and surcharge | Flanders/Wallonia/Brussels, communal surcharge percentage |

### Usage

```tsx
import { TaxProfileDialog } from "@/components/tax/TaxProfileDialog";

<TaxProfileDialog
  trigger={<Button>Configure Tax Profile</Button>}
  initialStep="income"
/>
```

### Integration

- Uses `BelgianTaxProfileContext` for profile state management
- Sets `profileConfigured: true` on completion
- Each step navigates independently via the step progress bar

---

## OnboardingWizard

Multi-step onboarding wizard shown to first-time users.

**File:** [[apps/frontend/src/components/onboarding/OnboardingWizard.tsx]]

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

| Step | Description | Actions |
|------|-------------|---------|
| **Welcome** | Greeting and feature badges | Next |
| **Overview** | Feature categories (Budgeting, Portfolio) | Next |
| **Bank Setup** | Select bank adapter from available parsers | Next |
| **Import** | Upload CSV for selected bank | Import or skip |
| **Categories** | Create suggested categories (15 pre-defined) | Create selected or skip |
| **Feature Tour** | Navigate to any feature page | Navigate or next |
| **Backup** | Backup/restore information, restore from file (Electron only) | Open settings or complete |

### Features

- **Persistence**: Completion state stored via `apiClient.getSetting/saveSetting` with key `onboarding_complete`
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

## AddTransactionForm

Form state management for the Add Transaction dialog. This is a lightweight utility module (not a React component) that provides a typed form state interface and a factory function for initializing the form.

### Type: AddTransactionFormState

| Field | Type | Description |
|-------|------|-------------|
| `transaction_date` | `string` | ISO date string (YYYY-MM-DD), defaults to today |
| `bank_account` | `string` | Bank account identifier |
| `recipient_id` | `string` | Recipient ID (empty string if none) |
| `category_id` | `string` | Category ID (empty string if none) |
| `memo` | `string` | Transaction memo/description |
| `amount` | `string` | Amount as string (positive for income, negative for expense) |
| `currency` | `string` | Currency code, defaults to EUR |
| `comment` | `string` | Additional comment field |

### Function: createAddTransactionFormState

```ts
function createAddTransactionFormState(defaultCurrency?: string): AddTransactionFormState
```

Returns a fresh form state object with sensible defaults:
- `transaction_date`: Current date (YYYY-MM-DD)
- `bank_account`, `recipient_id`, `category_id`, `memo`, `amount`, `comment`: Empty strings
- `currency`: Provided `defaultCurrency` or `'EUR'`

### Usage

Used by [[apps/frontend/src/components/forms/AddTransactionDialog.tsx|AddTransactionDialog]] to initialize and reset the form state. The flat string-based state is designed for easy integration with controlled form inputs.

**Code**: [[apps/frontend/src/components/forms/addTransactionForm.ts]]

---

## MergeRecipientsDialog

Two-step dialog for merging duplicate recipients. Users first select a primary recipient (via Command search), then select aliases to merge into it.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Dialog open state |
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

**Code**: [[apps/frontend/src/components/recipients/MergeRecipientsDialog.tsx]]

---

## VirtualDataTable

High-performance generic data table with virtual scrolling, inline editing, server-side search/sort, and infinite scroll. Used throughout the app for large datasets (transactions, recipients, categories).

### Props

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Table title displayed in card header |
| `subtitle` | `string?` | Optional subtitle |
| `columns` | `Column<T>[]` | Column definitions (key, header, editable, sortable, filterable, render) |
| `data` | `T[]` | Array of row data |
| `emptyMessage` | `ReactNode?` | Content shown when no data |
| `actions` | `ReactNode?` | Action buttons rendered in header |
| `onRowUpdate` | `(index, row) => void` | Callback when inline-edited row is saved |
| `onRowDoubleClick` | `(row, index) => void` | Callback on double-click (e.g., deep link to Transactions) |
| `totalItems` | `number?` | Total items on server (for infinite scroll) |
| `isFetchingMore` | `boolean?` | Loading state for infinite scroll |
| `onLoadMore` | `() => void` | Called when user scrolls near bottom |
| `hasMore` | `boolean?` | Whether more items are available |
| `onSearchChange` | `(query) => void` | Server-side search callback |
| `searchValue` | `string?` | Controlled search value |
| `onSortChange` | `(key, dir) => void` | Server-side sort callback (enables server-sort mode) |
| `sortKeyProp` | `string?` | Controlled sort key |
| `sortDirProp` | `SortDirection?` | Controlled sort direction |
| `maxHeight` | `number?` | Virtual scroll container height (default: 600) |
| `rowHeight` | `number?` | Estimated row height for virtualizer |
| `cancelEditingRef` | `Ref?` | Ref to expose cancelEditing externally |
| `onEditingChange` | `(editing) => void` | Callback when editing state changes |

### Column Definition

```ts
interface Column<T> {
  key: string;           // Data key
  header: string;        // Display header
  editable?: boolean;    // Enable inline editing
  type?: "text" | "number" | "date";
  render?: (row, editing, index) => ReactNode;  // Custom cell renderer
  sortable?: boolean;    // Enable column sorting
  filterable?: boolean;  // Enable column filter popover
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

---

## DataTable

Standard data table with pagination, inline editing, search, and column filtering. Simpler alternative to VirtualDataTable for smaller datasets that don't require virtual scrolling.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Table title |
| `subtitle` | `string?` | Optional subtitle |
| `columns` | `Column<T>[]` | Column definitions (same as VirtualDataTable) |
| `data` | `T[]` | Row data |
| `emptyMessage` | `string?` | Empty state message |
| `actions` | `ReactNode?` | Header action buttons |
| `onRowUpdate` | `(index, row) => void` | Inline edit save callback |
| `page` | `number?` | Current page (controlled) |
| `pageSize` | `number?` | Items per page (default: 50) |
| `totalItems` | `number?` | Total items for pagination |
| `onPageChange` | `(page) => void` | Page change callback |
| `onSearchChange` | `(query) => void` | Server-side search callback |
| `searchValue` | `string?` | Controlled search value |

### Key Differences from VirtualDataTable

| Feature | DataTable | VirtualDataTable |
|---------|-----------|------------------|
| Rendering | Standard table rows | Virtual scrolling |
| Pagination | Built-in page controls | Infinite scroll |
| Performance | Good for <500 rows | Handles 10,000+ rows |
| Row height | Fixed | Configurable estimate |
| Double-click | Not supported | `onRowDoubleClick` prop |
| Editing state callback | Not supported | `onEditingChange` prop |

### Features

- **Pagination** — page controls with `page`/`pageSize`/`onPageChange`
- **Inline editing** — double-click editable cells
- **Server-side search** — debounced via `onSearchChange`
- **Local search** — falls back to client-side filtering when no `onSearchChange`
- **Column sorting** — client-side or server-side
- **Column filtering** — popover-based filters

**Code**: [[apps/frontend/src/components/shared/DataTable.tsx]]

## SuggestedDeductionsCard

Analyzes the user's Belgian tax profile and generates a list of missed or available tax deductions.

### Props

No props — reads tax profile from context.

### Features

- Analyzes Belgian tax profile for deduction opportunities
- Covers: pension savings, life insurance, group insurance, charitable donations, childcare, domestic help, alimony
- Shows estimated tax savings per deduction
- CTA button opens the [[apps/frontend/src/components/tax/TaxProfileDialog.tsx|TaxProfileDialog]]
- No props required — reads from BelgianTaxProfileContext

**Code**: [[apps/frontend/src/components/tax/SuggestedDeductionsCard.tsx]]

---

## MergeRecipientsDialog

Two-step dialog for merging duplicate recipients.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controls dialog visibility |
| `onOpenChange` | `(open: boolean) => void` | Visibility change handler |

### Flow

1. **Step 1**: User selects a primary recipient via Command search
2. **Step 2**: User selects alias recipients to merge into the primary
3. Uses `useMergeRecipients` hook for the merge operation
4. Paginates all recipients and filters out already-aliased entries

**Code**: [[apps/frontend/src/components/recipients/MergeRecipientsDialog.tsx]]

---

## UpdateNotification

Polls for application updates and displays an install prompt.

### Props

No props.

### Features

- Polls `apiClient.checkForUpdates()` every 5 minutes
- Skips polling when tab is hidden (Page Visibility API)
- Shows amber badge when update is available
- Dialog displays version info, release notes, and install button
- Install calls `apiClient.installShellUpdate()` with phase tracking (pulling → restarting → done)

**Code**: [[apps/frontend/src/components/notifications/UpdateNotification.tsx]]

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

## Related Documentation
