---
title: Layout Components
type: component
status: active
date: 2026-04-25
updated: 2026-06-11
tags: [components, layout, navigation, design-system, phase-9, performance, workspace, liquid-glass-v2, command-palette, route-preload, electron-native, electron-bridge, ipc, macos, june-2026]
description: Core layout components including sidebar, header, and app structure with emerald + gold aesthetic. June 2026 Liquid Glass v2 — atmosphere layer restored, PageTransition re-added as enter-only spring, sidebar ActiveRail is a framer layoutId element, CommandPalette wired, scroll-linked topbar, route-chunk hover prefetch. June 2026 V12 (ADR-072) — ElectronBridge mounted in AppLayout handles native menu actions, CSV drag-drop, fullscreen class toggling, and dock badge via window.electronAPI.
aliases: [layout, app layout, sidebar, navigation, ElectronBridge]
related_code: ["apps/frontend/src/components/layout", "apps/frontend/src/components/layout/ElectronBridge.tsx"]
---

# Layout Components

Core layout components that structure the application shell.

> [!info] June 2026 — Liquid Glass v2 (ADR-070)
> Layout components were significantly updated in June 2026. The liquid canvas atmosphere layer was restored, `PageTransition` re-added as an enter-only spring, `CommandPalette` wired to the topbar, sidebar `ActiveRail` converted to a framer `layoutId` element, and the topbar made scroll-linked. See [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] for full details.

> [!note] Prior Performance Optimization (2026-04-17)
> Layout components originally removed the liquid-canvas background and PageTransition in response to Electron M1 GPU regression ([[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]]). The June 2026 pass restored them in a more targeted form — atmosphere layer is compositor-only transforms, page transition is enter-only (no exit double-render).

## Component List

| Component | Description | File |
|-----------|-------------|------|
| AppLayout | Main app wrapper with sidebar, atmosphere, topbar, CommandPalette, ElectronBridge | [[apps/frontend/src/components/layout/AppLayout.tsx\|AppLayout.tsx]] |
| AppSidebar | Navigation sidebar with ActiveRail + route prefetch | [[apps/frontend/src/components/layout/AppSidebar.tsx\|AppSidebar.tsx]] |
| ElectronBridge | Electron IPC bridge — menu actions, CSV handoff, fullscreen, dock badge (Electron-only, mounted in AppLayout inside SidebarProvider) | [[apps/frontend/src/components/layout/ElectronBridge.tsx\|ElectronBridge.tsx]] |
| PageTransition | Enter-only spring route wrapper (re-added June 2026) | [[apps/frontend/src/components/layout/PageTransition.tsx\|PageTransition.tsx]] |
| CommandPalette | ⌘K global command palette | [[apps/frontend/src/components/shared/CommandPalette.tsx\|CommandPalette.tsx]] |

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

### Features (Liquid Glass v2)

- **Atmosphere layer**: Fixed `liquid-canvas` layer with two slow-drifting aurora blobs (compositor-only `transform`, 64s/76s alternate) + radial wash + SVG grain. Drift pauses under `prefers-reduced-motion`. Colors derive from `--primary`/`--accent`.
- **Scroll-linked topbar**: `::before` pseudo-element fades with `[data-scrolled]` attribute; passive scroll listener; gradients cannot `transition` directly so the material lives in the pseudo-element.
- **CommandPalette**: Mounted here, triggered by topbar ⌘K button or keyboard shortcut.
- **PageTransition**: Wraps children in an enter-only spring (pathname-keyed `motion.div`).
- **Responsive sidebar integration**: Full collapsible sidebar with workspace switching.
- **Workspace context provider**: Workspace detection via route path.
- **Notification system integration**: Sonner toast notifications.
- **Dark/light theme support**: Full theme switching via `ThemeContext` + `document.startViewTransition`.
- **Glass chrome sidebar**: `.glass-chrome` (24px blur + saturate) navigation with `ActiveRail` framer `layoutId` element. Background alphas lowered to 0.55→0.72 (light) / 0.55→0.74 (dark) so the aurora and Electron vibrancy glow through; a `@supports not (backdrop-filter)` rule keeps a near-opaque ramp for unsupported browsers.

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

### Features (Liquid Glass v2)

- **Collapsible**: Toggle between expanded and icon-only modes
- **Workspace-aware**: Changes navigation based on workspace
- **ActiveRail**: Active-route indicator is a framer-motion `layoutId="active-rail"` element that animates (glides) between nav items on route change; instant under `prefers-reduced-motion`
- **Route prefetch**: `onMouseEnter` on each nav item calls `routePreload(path)` via `lib/routePreload.ts`, warming the lazy chunk before the user clicks
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

## PageTransition

**Status**: Re-added in June 2026 (ADR-070) as enter-only spring.

`components/layout/PageTransition.tsx` wraps routed children in a `motion.div` keyed on `location.pathname`. It is enter-only (no `AnimatePresence` exit) to avoid double-rendering React Suspense boundaries around lazy-loaded routes.

**Spring parameters**: uses `SPRING_SMOOTH` from `lib/motion.ts`; under `prefers-reduced-motion`, transition is instant (empty initial/animate props).

**History**:
- Added in ADR-017 (April 2026) as full enter + exit spring.
- Removed in ADR-020 (April 2026) due to Electron M1 GPU regression.
- Re-added in ADR-070 (June 2026) as enter-only — resolves the Suspense double-render issue that made full AnimatePresence unworkable.

Code link: [[apps/frontend/src/components/layout/PageTransition.tsx]]

## CommandPalette

**Status**: Added June 2026 (ADR-070).

`components/shared/CommandPalette.tsx` provides a ⌘K / Ctrl+K global command palette built on the `cmdk` library. Mounted by `AppLayout` with a topbar button trigger.

**Coverage**:
- All budgeting pages (Dashboard, Transactions, Categories, Recipients, Statistics, Planned, Import, Owes, Tax)
- All portfolio pages (Overview, Stocks, Crypto, Metals, Real Estate, Savings, Performance, Net Worth, Exchange Rates, Watchlist, Portfolio Tax)
- Admin pages when `adminMode` is enabled
- Theme variant switcher
- Settings navigation

**Workspace sync**: jumping to a cross-workspace page calls `setWorkspace` so the sidebar updates to match the destination page's workspace.

**i18n**: 5 new keys under `commandPalette.*` (en + nl).

Code link: [[apps/frontend/src/components/shared/CommandPalette.tsx]]

---

## ElectronBridge

**Status**: Added June 2026 (ADR-072).

`components/layout/ElectronBridge.tsx` is a side-effect-only component mounted once in `AppLayout` inside `SidebarProvider`. It is a no-op in browser (non-Electron) builds — every call is gated on `isElectronMac()` or `getElectronAPI()`.

**Responsibilities:**

| Responsibility | Detail |
|----------------|--------|
| Ready handshake | Calls `electronAPI.ready()` on mount — drains the pending IPC send queue in main |
| Menu action routing | Subscribes to `onMenuAction`; maps `{action, payload}` to React Router navigation, settings/shortcuts dialog dispatch, sidebar toggle, or `/transactions?new=1` navigate |
| CSV drag-drop | Window-level `dragover`/`drop` intercept; `.csv` → `importHandoff`; exempts `[data-dropzone]` ancestors |
| CSV open-with | Subscribes to `onCsvOpen`; receives `{name, content}` from main; pushes to `importHandoff` and navigates to `/import` |
| Fullscreen class | Subscribes to `onFullScreenChange`; adds/removes `electron-fullscreen` on `<html>` |
| html class management | Adds `electron-mac` on mount; adds/removes `vibrancy` based on `appSettings.enhancedEffects` |

All IPC subscriptions are attached via stable refs (`useRef`) so React re-renders do not tear down and re-attach listeners. Unsubscribe functions are called in the effect cleanup.

Code link: [[apps/frontend/src/components/layout/ElectronBridge.tsx]]

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/features/views]] - All views
- [[docs/i18n/index]] - Internationalization
- [[docs/components/state-management|State Management]] - Context providers
- [[docs/adr/072-electron-native-desktop-integration|ADR-072: Electron-Native Desktop Integration]] (June 2026 — ElectronBridge, native menu, CSV handoff, system accent)
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]] (June 2026 — atmosphere, PageTransition, CommandPalette, ActiveRail)
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade & Liquid Canvas Removal]]
- [[docs/architecture/electron|Electron Architecture]] — Full IPC surface and native integration docs
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

## Visual Surface Notes

`AppLayout` renders a fixed `liquid-canvas` atmosphere layer (two aurora blobs + radial wash + SVG grain) behind all page content. This gives glass surfaces real background content to refract. Sidebar navigation uses `.glass-chrome` (24px blur + saturate) with the `ActiveRail` framer `layoutId` element gliding between active nav items.

Code links: [[apps/frontend/src/components/layout/AppLayout.tsx]], [[apps/frontend/src/components/layout/AppSidebar.tsx]], [[apps/frontend/src/index.css]], [[apps/frontend/src/styles/tokens.css]]
