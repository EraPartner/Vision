---
title: Layout Components
type: component
status: active
date: 2026-04-25
tags: [components, layout, navigation, design-system, phase-9, performance, workspace]
description: Core layout components including sidebar, header, and app structure with emerald + gold aesthetic, optimized for Electron M1 performance
aliases: [layout, app layout, sidebar, navigation]
related_code: ["apps/frontend/src/components/layout"]
---

# Layout Components

Core layout components that structure the application shell, optimized for performance on Electron M1.

> [!note] Performance Optimization (2026-04-17)
> Layout components were updated to remove liquid-canvas animated background and PageTransition wrapper in response to Electron M1 GPU regression. See [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] for details.

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

- **Responsive sidebar integration**: Full collapsible sidebar with workspace switching
- **Workspace context provider**: Workspace detection via route path
- **Notification system integration**: Sonner toast notifications
- **Dark/light theme support**: Full theme switching
- **Optimized background**: Static grain texture overlay (animated liquid-canvas removed for M1 GPU optimization)
- **Glass chrome sidebar**: `glass-chrome` (8px blur) navigation with emerald accent rail on active route

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

The `useWorkspace()` hook provides workspace-aware navigation and persists the active workspace across admin routes.

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
- **Route-derived**: The workspace is determined by whether the current path starts with `/portfolio` (portfolio), or defaults to budgeting. For `/admin/*` routes, which are workspace-agnostic, the last active workspace is restored from `sessionStorage` (key: `vision_workspace`).
- **Admin Routes**: When navigating to `/admin/*` pages from portfolio context, the sidebar retains the portfolio workspace instead of snapping to budgeting. Workspace switcher tabs still work — clicking "portfolio" navigates to `/portfolio`, clicking "budgeting" navigates to `/`.
- **Used by**: `AppSidebar` (see [[docs/components/layout|Layout Components]]) for workspace switching in the navigation.

**Code**: [[apps/frontend/src/contexts/WorkspaceContext.tsx]]

---

## PageTransition (Removed)

**Status**: Deleted in 2026-04-17 performance optimization

The `PageTransition` wrapper component was removed to improve Electron M1 GPU performance. Previously, it applied spring-based route-change animations (spring entrance + fade exit). Route transitions now use instant/CSS-based transitions instead.

**Rationale**: Spring physics on route transitions added GPU complexity for marginal UX benefit. Framer Motion retained for modal/dialog entry animations and chart effects, which have higher UX impact with lower GPU cost.

See [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade & Liquid Canvas Removal]] for details.

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/features/views]] - All views
- [[docs/i18n/index]] - Internationalization
- [[docs/components/state-management|State Management]] - Context providers
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade & Liquid Canvas Removal]]
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

## Visual Surface Notes

`AppLayout` uses a static grain texture overlay for visual richness without animation overhead. Sidebar navigation uses `.glass-chrome` (8px blur, GPU-safe) with emerald accent rail on active route.

Previous animated `liquid-canvas` gradient backdrop removed in 2026-04-17 optimization to eliminate Electron M1 GPU regression from sustained background animation.

Code links: [[apps/frontend/src/components/layout/AppLayout.tsx]], [[apps/frontend/src/index.css]]
