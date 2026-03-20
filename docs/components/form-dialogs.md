---
title: Form Dialogs
type: component
status: active
date: 2025-03-18
tags: [components, forms, dialogs]
description: Modal dialogs for adding and editing data throughout the application
related_code: ["apps/frontend/src/components/forms"]
---

# Form Dialogs

Modal dialog components for creating and editing data throughout Vision.

## Component List

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/add-transaction-dialog|AddTransactionDialog]] | Add new transaction | `AddTransactionDialog.tsx` |
| [[docs/components/add-category-dialog|AddCategoryDialog]] | Add new category | `AddCategoryDialog.tsx` |
| [[docs/components/add-recipient-dialog|AddRecipientDialog]] | Add new recipient | `AddRecipientDialog.tsx` |

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

### Example with Combobox

```tsx
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";

<RecipientCombobox
  value={form.recipient_id}
  onChange={(id) => setForm(prev => ({ ...prev, recipient_id: id }))}
/>
```

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/api/transactions]] - Transactions API
- [[docs/api/categories]] - Categories API
- [[docs/api/recipients]] - Recipients API
