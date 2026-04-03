---
title: Layout Components
type: component
status: active
date: 2026-03-18
tags: [components, layout, navigation]
description: Core layout components including sidebar, header, and app structure
aliases: [layout, app layout, sidebar, navigation]
related_code: ["apps/frontend/src/components/layout"]
---

# Layout Components

Core layout components that structure the application shell.

## Component List

| Component | Description | File |
|-----------|-------------|------|
| AppLayout | Main app wrapper with sidebar | [[apps/frontend/src/components/layout/AppLayout.tsx\|AppLayout.tsx]] |
| AppSidebar | Navigation sidebar | [[apps/frontend/src/components/layout/AppSidebar.tsx\|AppSidebar.tsx]] |

---

## AppLayout

Main layout wrapper that contains the sidebar and page content.

### Usage

```tsx
import { AppLayout } from "@/components/layout/AppLayout";

function App() {
  return (
    <AppLayout>
      <DashboardPage />
    </AppLayout>
  );
}
```

### Structure

```
<AppLayout>
  <AppSidebar />
  <main className="flex-1">
    {/* Page content */}
  </main>
</AppLayout>
```

### Features

- Responsive sidebar integration
- Workspace context provider
- Notification system integration
- Dark/light theme support

### Props

```typescript
interface AppLayoutProps {
  children: React.ReactNode;
}
```

---

## AppSidebar

Navigation sidebar with workspace-aware navigation.

### Navigation Structure

The sidebar adapts based on the active workspace:

### Budgeting Workspace

```
├── Overview
│   ├── Dashboard
│   └── Transactions
├── Organization
│   ├── Categories
│   └── Recipients
├── Analysis
│   ├── Statistics
│   ├── Planned Payments
│   ├── Who Owes You
│   └── Tax
└── Data
    └── Import
```

### Portfolio Workspace

```
├── Overview
│   ├── Dashboard
│   ├── Net Worth
│   └── Performance
├── Investments
│   ├── Stocks/ETFs
│   └── Crypto
├── Assets
│   ├── Real Estate
│   └── Savings/Bonds
└── Tools
    ├── Market Lookup
    ├── Watchlist
    ├── Exchange Rates
    └── Tax
```

### Usage

```tsx
import { AppSidebar } from "@/components/layout/AppSidebar";

function Layout() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* Logo */}
      </SidebarHeader>
      <SidebarContent>
        {/* Navigation groups */}
      </SidebarContent>
      <SidebarFooter>
        {/* User info */}
      </SidebarFooter>
    </Sidebar>
  );
}
```

### Features

- **Collapsible**: Toggle between expanded and icon-only modes
- **Workspace-aware**: Changes navigation based on workspace
- **Active state**: Highlights current route
- **Responsive**: Adapts to screen size
- **Keyboard accessible**: Full keyboard navigation

### Workspace Switcher

```tsx
const { workspace, setWorkspace } = useWorkspace();

// Switch to portfolio
setWorkspace("portfolio");

// Switch to budgeting
setWorkspace("budgeting");
```

### Navigation Items

```typescript
interface NavItem {
  title: string;      // Display title
  url: string;        // Route path
  icon: LucideIcon;   // Icon component
}

interface NavGroup {
  label: string;      // Group label
  items: NavItem[];   // Group items
}
```

### Internationalization

Navigation labels use the translation system:

```tsx
const budgetingGroups = [
  {
    label: t('nav.overview'),
    items: [
      { title: t('nav.dashboard'), url: "/", icon: LayoutDashboard },
      { title: t('nav.transactions'), url: "/transactions", icon: Receipt },
    ],
  },
];
```

---

## Error Boundary

Wrapper for catching React errors.

### Usage

```tsx
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";

function App() {
  return (
    <ErrorBoundary>
      <AppLayout>
        <PageContent />
      </AppLayout>
    </ErrorBoundary>
  );
}
```

### Features

- Catches React component errors
- Shows error UI instead of crashing
- Provides error recovery options

---

## Workspace Hook

The `useWorkspace()` hook provides workspace-aware navigation. It derives the active workspace from the current route path — no Context or Provider needed since all state lives in the router.

### Type: Workspace

```ts
type Workspace = "budgeting" | "portfolio";
```

### Hook API

```ts
function useWorkspace(): { workspace: Workspace; setWorkspace: (ws: Workspace) => void }
```

| Return | Type | Description |
|--------|------|-------------|
| `workspace` | `Workspace` | Current workspace: `"portfolio"` if path starts with `/portfolio`, otherwise `"budgeting"` |
| `setWorkspace` | `(ws: Workspace) => void` | Navigate to the workspace root: `/portfolio` or `/` |

### Usage

```tsx
import { useWorkspace } from "@/contexts/WorkspaceContext";

function WorkspaceSwitcher() {
  const { workspace, setWorkspace } = useWorkspace();

  return (
    <Button
      onClick={() => setWorkspace(workspace === "portfolio" ? "budgeting" : "portfolio")}
    >
      Switch to {workspace === "portfolio" ? "Budgeting" : "Portfolio"}
    </Button>
  );
}
```

### Design Notes

- **No Context Provider**: Unlike other contexts in the app, `WorkspaceContext` does not export a React Context or Provider. It uses `useLocation` and `useNavigate` from React Router directly, treating the router as the state container.
- **Route-derived**: The workspace is determined solely by whether the current path starts with `/portfolio`.
- **Used by**: `AppSidebar` (see [[docs/components/layout|Layout Components]]) for workspace switching in the navigation.

**Code**: [[apps/frontend/src/contexts/WorkspaceContext.tsx]]

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/features/views]] - All views
- [[docs/i18n/index]] - Internationalization
- [[docs/components/state-management|State Management]] - Context providers
