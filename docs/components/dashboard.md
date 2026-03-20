---
title: Dashboard Components
type: component
status: active
date: 2025-03-18
tags: [components, dashboard, charts, widgets]
description: Dashboard-specific components for financial overview and visualization
related_code: ["apps/frontend/src/components/dashboard"]
---

# Dashboard Components

Components for the main Dashboard page (`/`), providing financial overview and visualization widgets.

## Component List

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/stat-card|StatCard]] | Summary stat card with trend | `StatCard.tsx` |
| [[docs/components/monthly-trends-chart|MonthlyTrendsChart]] | Monthly income vs expenses bar chart | `MonthlyTrendsChart.tsx` |
| [[docs/components/category-pie-chart|CategoryPieChart]] | Spending by category pie chart | `CategoryPieChart.tsx` |
| [[docs/components/cashflow-chart|CashFlowComparisonChart]] | Current vs previous period comparison | `CashFlowComparisonChart.tsx` |
| [[docs/components/bank-balances-widget|BankBalancesWidget]] | Bank account balance display | `BankBalancesWidget.tsx` |
| [[docs/components/monthly-spending-chart|MonthlySpendingChart]] | Monthly spending line chart | `MonthlySpendingChart.tsx` |

---

## StatCard

Displays a single statistic with optional trend indicator.

### Props

```typescript
interface StatCardProps {
  title: string;           // Card title
  value: string;           // Main value to display
  change?: string;         // Delta text (e.g., "+12%")
  changeType?: "positive" | "negative" | "neutral";
  subtitle?: string;       // Subtitle when no change
  icon: LucideIcon;        // Icon component
  trend?: "income" | "expense" | "up" | "down" | "neutral";
}
```

### Usage

```tsx
import { DollarSign } from "lucide-react";

<StatCard
  title="Total Income"
  value="€5,000"
  change="+12% vs last month"
  changeType="positive"
  icon={DollarSign}
  trend="income"
/>
```

### Visual Features

- Gradient background based on trend type
- Animated hover effect (lift + shadow)
- Color-coded change indicator
- Large formatted value with gradient text

---

## MonthlyTrendsChart

Bar chart showing monthly income vs expenses.

### Props

```typescript
interface MonthlyTrendsChartProps {
  data: Array<{
    month: string;
    income: number;
    expenses: number;
  }>;
  currency?: string;
}
```

### Usage

```tsx
<MonthlyTrendsChart
  data={[
    { month: "Jan", income: 5000, expenses: 3200 },
    { month: "Feb", income: 4800, expenses: 3100 },
  ]}
  currency="EUR"
/>
```

### Features

- Dual bar chart (income/expenses)
- Responsive design
- Tooltip on hover
- Dark mode support

---

## CategoryPieChart

Donut/pie chart showing spending distribution by category.

### Props

```typescript
interface CategoryPieChartProps {
  data: Array<{
    category: string;
    amount: number;
    color?: string;
  }>;
  currency?: string;
}
```

### Usage

```tsx
<CategoryPieChart
  data={[
    { category: "Food", amount: 450 },
    { category: "Transport", amount: 200 },
    { category: "Utilities", amount: 150 },
  ]}
  currency="EUR"
/>
```

### Features

- Donut style with center label
- Legend with category colors
- Animated transitions
- Custom colors per category

---

## CashFlowComparisonChart

Compares current period cashflow with previous period.

### Props

```typescript
interface CashFlowComparisonChartProps {
  currentPeriod: {
    income: number;
    expenses: number;
    net: number;
  };
  previousPeriod: {
    income: number;
    expenses: number;
    net: number;
  };
  currency?: string;
}
```

### Usage

```tsx
<CashFlowComparisonChart
  currentPeriod={{ income: 5000, expenses: 3200, net: 1800 }}
  previousPeriod={{ income: 4500, expenses: 2800, net: 1700 }}
  currency="EUR"
/>
```

### Features

- Side-by-side comparison bars
- Percentage change indicators
- Color-coded (green for improvement)

---

## BankBalancesWidget

Displays current balances for all bank accounts.

### Props

```typescript
interface BankBalancesWidgetProps {
  accounts: Array<{
    bankAccount: string;
    balance: number;
    currency: string;
    transactionCount?: number;
    firstTransaction?: string;
    lastTransaction?: string;
  }>;
}
```

### Usage

```tsx
<BankBalancesWidget
  accounts={[
    { bankAccount: "Main Account", balance: 5000, currency: "EUR" },
    { bankAccount: "Savings", balance: 10000, currency: "EUR" },
  ]}
/>
```

### Features

- List of accounts with balances
- Transaction count per account
- Date range of transactions
- Currency formatting

---

## Widget Visibility System

Dashboard uses a widget visibility system to let users customize their view.

### Usage

```tsx
import { useWidgetVisibility, WidgetVisibilityDialog } from "@/hooks/useWidgetVisibility";

const DASHBOARD_WIDGETS = [
  { id: 'statCards', label: 'Statistics Cards' },
  { id: 'monthlyTrends', label: 'Monthly Trends' },
  { id: 'categoryPie', label: 'Category Distribution' },
];

function Dashboard() {
  const { isVisible, setWidgetVisible } = useWidgetVisibility('dashboard', DASHBOARD_WIDGETS);
  
  return (
    <>
      {isVisible('statCards') && <StatCard ... />}
      {isVisible('monthlyTrends') && <MonthlyTrendsChart ... />}
      
      <WidgetVisibilityDialog
        widgets={DASHBOARD_WIDGETS}
        visibility={isVisible}
        onChange={setWidgetVisible}
      />
    </>
  );
}
```

### Hook API

```typescript
// Hook return values
{
  isVisible: (id: string) => boolean;
  setWidgetVisible: (id: string, visible: boolean) => void;
  setAllVisible: () => void;
  resetToDefaults: () => void;
  widgets: WidgetDefinition[];
}
```

---

## Data Flow

```
API (/api/info/*) → Hook (useFilteredDashboardStats) → Component → Dashboard
```

### Related Hooks

- `useFilteredDashboardStats()` - Fetches filtered dashboard data
- `useTransactions()` - Transaction list with filters
- `useWidgetVisibility()` - Widget visibility state

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/features/views]] - Dashboard view
- [[docs/api/info]] - Analytics API
- [[docs/performance/materialized-views]] - Dashboard optimization
