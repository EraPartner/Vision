---
title: Layout Components
type: component
status: active
date: 2026-10-07
updated: 2026-10-07
tags:
  [
    components,
    layout,
    navigation,
    design-system,
    phase-9,
    performance,
    sidebar-sections,
    liquid-glass-v2,
    command-palette,
    route-preload,
    electron-native,
    electron-bridge,
    ipc,
    macos,
    june-2026,
  ]
description: Core layout components including sidebar, header, and app structure with emerald + gold aesthetic. October 2026 (ADR-180) — one labelled sidebar with hideable Money, Wealth and Research sections replaces the workspaces; topbar reduced to trigger, title, search and background indicator. June 2026 Liquid Glass v2 — atmosphere layer restored, PageTransition re-added as enter-only spring, CommandPalette wired, scroll-linked topbar, route-chunk hover prefetch. June 2026 V12 (ADR-072) — ElectronBridge mounted in AppLayout handles native menu actions, CSV drag-drop, fullscreen class toggling, and dock badge via window.electronAPI.
aliases: [layout, app layout, sidebar, navigation, ElectronBridge]
related_code:
  [
    "apps/frontend/src/components/layout",
    "apps/frontend/src/components/layout/ElectronBridge.tsx",
  ]
---

# Layout Components

Core layout components that structure the application shell.

> [!info] June 2026 — Liquid Glass v2 (ADR-070)
> Layout components were significantly updated in June 2026. The liquid canvas atmosphere layer was restored, `PageTransition` re-added as an enter-only spring, `CommandPalette` wired to the topbar, sidebar `ActiveRail` converted to a framer `layoutId` element, and the topbar made scroll-linked. See [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] for full details.

> [!note] Prior Performance Optimization (2026-04-17)
> Layout components originally removed the liquid-canvas background and PageTransition in response to Electron M1 GPU regression ([[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]]). The June 2026 pass restored them in a more targeted form — atmosphere layer is compositor-only transforms, page transition is enter-only (no exit double-render).

## Component List

| Component      | Description                                                                                                                          | File                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| AppLayout      | Main app wrapper with sidebar, atmosphere, topbar, CommandPalette, ElectronBridge                                                    | [[apps/frontend/src/components/layout/AppLayout.tsx\|AppLayout.tsx]]           |
| AppSidebar     | One labelled sidebar: sections, live counts, route prefetch                                                                                | [[apps/frontend/src/components/layout/AppSidebar.tsx\|AppSidebar.tsx]]         |
| ElectronBridge | Electron IPC bridge — menu actions, CSV handoff, fullscreen, dock badge (Electron-only, mounted in AppLayout inside SidebarProvider) | [[apps/frontend/src/components/layout/ElectronBridge.tsx\|ElectronBridge.tsx]] |
| PageTransition | Enter-only spring route wrapper (re-added June 2026)                                                                                 | [[apps/frontend/src/components/layout/PageTransition.tsx\|PageTransition.tsx]] |
| CommandPalette | ⌘K global command palette                                                                                                            | [[apps/frontend/src/components/shared/CommandPalette.tsx\|CommandPalette.tsx]] |

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
  <a href="#main">Skip to content</a>
  <AppSidebar>
    <nav aria-label="Primary navigation" />
  </AppSidebar>
  <main id="main" tabIndex={-1} className="flex-1">
    {/* Page content */}
  </main>
</AppLayout>
```

### Features (Liquid Glass v2)

- **Atmosphere layer**: Fixed `liquid-canvas` layer with two slow-drifting aurora blobs (compositor-only `transform`, 64s/76s alternate) + radial wash + SVG grain. Drift pauses under `prefers-reduced-motion`. Colors derive from `--primary`/`--accent`.
- **Scroll-linked topbar**: `::before` pseudo-element fades with `[data-scrolled]` attribute; passive scroll listener; gradients cannot `transition` directly so the material lives in the pseudo-element.
- **CommandPalette**: Mounted here, triggered by topbar ⌘K button or keyboard shortcut.
- **New-transaction shortcut**: bare `N` navigates to `/transactions?new=1`, which opens the Add Transaction sheet ([[docs/components/form-dialogs#AddTransactionSheet]]). Browsers keep ⌘N, so the web shortcut is the bare key; it is inert while typing in an input and while a dialog or alert-dialog overlay is open (`isShortcutSafeTarget`) and ignores modified keys. The desktop menu keeps ⌘N through the same deep link ([[docs/components/layout#ElectronBridge]]).
- **PageTransition**: Wraps children in an enter-only spring (pathname-keyed `motion.div`).
- **Responsive sidebar integration**: Labelled sidebar that collapses to an icon rail (remembered); see [[#AppSidebar]].
- **Topbar**: sidebar trigger, scroll-linked page title, a search button below the `md` breakpoint (the search field lives in the sidebar) and the background-query indicator. The theme dropdown and the update badge were removed ([[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]); theme modes live in Settings › Appearance, the command palette and Electron View › Appearance, and update status in the sidebar Settings dot and Settings › About.
- **Canvas tint**: `data-tint="wealth"` under `/portfolio`, otherwise `"money"` (replaces `data-workspace`).
- **Notification system integration**: Sonner toast notifications.
- **Dark/light theme support**: Full theme switching via `ThemeHydration` + `document.startViewTransition`, driven from Settings, the palette and the Electron menu.
- **Glass chrome sidebar**: `.glass-chrome` (24px blur + saturate) navigation with a `primary` selection fill on the active row. Background alphas lowered to 0.55→0.72 (light) / 0.55→0.74 (dark) so the aurora and Electron vibrancy glow through; a `@supports not (backdrop-filter)` rule keeps a near-opaque ramp for unsupported browsers.
- **Keyboard structure**: A focus-visible skip link is the first shell control and moves focus to `main#main`. Route changes also focus that main landmark. The shared desktop/mobile sidebar menu is a localized `<nav>` landmark, and its trigger and rail use the localized sidebar-toggle name.

### Props

```typescript
interface AppLayoutProps {
  children: React.ReactNode;
}
```

---

## AppSidebar

One labelled sidebar replaces the former three workspaces and their switcher ([[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]). Every page is visible at once, grouped into sections that the user can hide.

The sidebar trigger and resize rail use the localized `menu.toggleSidebar` accessible name, so
screen readers follow the active application language.

### Navigation Structure

`lib/navigation.ts` is the single registry. `AppSidebar` renders `NAV_SECTIONS` (plus `ADMIN_SECTION` when `appSettings.adminMode` is on) inside one `<nav aria-label>` landmark:

| Section  | Items                                                                                                                                       | Default |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| top      | Home, Transactions, Accounts, Planned Payments                                                                                              | always  |
| Money    | Categories, Recipients, Statistics, Who owes you, Taxes, Import / Export                                                                    | shown   |
| Wealth   | Portfolio, Net Worth, Stocks & ETFs, Crypto, Metals, Real estate, Savings & bonds, Performance, Rebalance, Portfolio taxes, Import portfolio history | shown   |
| Research | Research home, Markets, Market lookup, Compare, Chart builder, Forecast, Watchlist, Dossiers, Analysis workspace, Analysis monitors         | hidden  |
| Admin    | Overview, Database maintenance, Data Sources, Endpoints, Exchange rates                                                                           | admin mode |

The footer holds AI chat (a registry item) and Settings (a button that opens the settings dialog, `⌘,`). The header holds the logo (toggles the sidebar), the app name, a collapse button and a search field that opens the command palette. Market Lookup and Watchlist live in Research (moved from Portfolio by [[docs/adr/079-multi-provider-research-aggregation|ADR-079]]).

### Features

- **Labelled by default, icons-only remembered**: the sidebar opens with labels (15rem). Collapsing it to the 48px icon rail (⌘B, the collapse button, the logo, Electron View › Toggle Sidebar, or Settings › Appearance › *Sidebar: Labels / Icons only*) is written to `localStorage` key `vision.sidebar.collapsed` and read back through `SidebarProvider`'s `defaultOpen` on the next launch. The primitive no longer writes a cookie, and its page gap now follows the open state, so an expanded sidebar pushes the page instead of covering it.
- **Hideable sections**: each headed section has a *Hide* / *Show* button. Hidden section ids are stored as a JSON object under `vision.sidebar.hiddenSections` (`useHiddenSections` in `hooks/useSidebarPreferences.ts`); Research is hidden until the user shows it. Landing on a page inside a hidden section (deep link, palette, go-to key, Electron menu) shows that section and persists it.
- **Selection and rows**: rows are 30px with the chip radius, primary-coloured icons and a `primary` selection fill (12% light, 16% dark). The former framer `ActiveRail` is gone. Rows with a go-to key show `G <key>` on hover; the collapsed rail shows it in the tooltip. The active row scrolls into view on navigation.
- **Live counts**: `NavItemBadge` renders the registry `badge` ids as counts: `needs-category` on Transactions (uncategorised active transactions via `useNeedsCategoryCount`, filled), `planned-due` on Planned Payments (payments due in the next seven days via `useUpcomingPlannedPayments`, filled), `insights` on Statistics (`useInsightsCount`, quiet) and `monitors` on Analysis monitors (unread notifications via `useMonitorNotifications`, quiet). On the icon rail the count becomes a pill on the icon corner. `InsightsNavBadge` and `MonitorInboxBadge` were replaced by this component.
- **Update dot**: the Settings row shows a dot with a screen-reader label (`layout.updateReady`) when `useUpdateStatus` reports an update. See [[docs/features/application-updates|Application updates]].
- **Route prefetch**: `onMouseEnter` / `onFocus` on each nav item calls `preloadRoute(path)` via `lib/routePreload.ts`, warming the lazy chunk, and prefetches Net Worth and Performance data.
- **Keyboard accessible**: full keyboard navigation; the section toggles are buttons with `aria-expanded` / `aria-controls`, and a hidden section's content is `inert`.

### Navigation Items

```typescript
interface NavItem {
  titleKey: string; // i18n key for the label
  url: string; // Route path
  icon: LucideIcon;
  shortcutKey?: string; // second key of the `g`-then-key sequence
  badge?: "needs-category" | "planned-due" | "insights" | "monitors";
  exact?: boolean; // match the pathname exactly (section roots)
}

interface NavSection {
  id: "top" | "money" | "wealth" | "research" | "admin";
  labelKey?: string; // the top section has no heading
  collapsible: boolean;
  defaultHidden?: boolean;
  items: NavItem[];
}
```

`lib/navigation.ts` also exports `ADMIN_SECTION`, `FOOTER_NAV_ITEMS`, `ALL_NAV_ITEMS`, `PALETTE_SECTIONS`, `GO_TO_ROUTES`, `SECTION_CYCLE` (Home, Portfolio and Research roots, stepped by `[` / `]`), `SECTION_ID_BY_URL`, `isActiveNavItem`, `matchNavItem`, `matchNavTitleKey` and `matchNavSectionId`. `lib/__tests__/navigation.test.ts` asserts that every parameterless route in `appRouteManifest` has exactly one entry and that admin routes live only in the Admin section.

### Internationalization

Navigation labels are i18n keys resolved at render time:

```tsx
<span className="truncate">{t(item.titleKey)}</span>
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

## Sidebar preferences and update status

Two small hooks replace the removed `useWorkspace` hook ([[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]). Neither needs a context provider.

| Hook                                                   | Role                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useHiddenSections()` in `hooks/useSidebarPreferences.ts` | `useSyncExternalStore` store over `localStorage` key `vision.sidebar.hiddenSections`; returns `isHidden(id)` and `setSectionHidden(id, value)`. `readSidebarCollapsed` / `writeSidebarCollapsed` handle `vision.sidebar.collapsed` (`"1"` when icons-only). |
| `useUpdateStatus()` in `hooks/useUpdateStatus.ts`      | React Query over `apiClient.checkForUpdates()`, key `["update-status"]`, polled every 5 minutes while the document is visible and refetched on window focus; no retry. Shared by the sidebar Settings dot and Settings › About. |

Both keys are registered in `lib/localStorage-keys.ts` (`SIDEBAR_COLLAPSED`, `SIDEBAR_HIDDEN_SECTIONS`). The canvas tint follows the route: `AppLayout` sets `data-tint="wealth"` on the `.liquid-canvas` under `/portfolio`, otherwise `"money"`.

**Code**: [[apps/frontend/src/hooks/useSidebarPreferences.ts]], [[apps/frontend/src/hooks/useUpdateStatus.ts]]

---

## PageTransition

**Status**: Re-added in June 2026 (ADR-070) as enter-only spring.

`components/layout/PageTransition.tsx` wraps routed children in an `m.div` keyed on `location.pathname`. It is enter-only (no `AnimatePresence` exit) to avoid double-rendering React Suspense boundaries around lazy-loaded routes.

**Timing**: uses `durations.page` with `easings.outExpo` from `lib/motion.ts`; under `prefers-reduced-motion`, the wrapper is omitted and children render directly.

**History**:

- Added in ADR-017 (April 2026) as full enter + exit spring.
- Removed in ADR-020 (April 2026) due to Electron M1 GPU regression.
- Re-added in ADR-070 (June 2026) as enter-only — resolves the Suspense double-render issue that made full AnimatePresence unworkable.

Code link: [[apps/frontend/src/components/layout/PageTransition.tsx]]

## CommandPalette

**Status**: Added June 2026 (ADR-070).

`components/shared/CommandPalette.tsx` provides a ⌘K / Ctrl+K global command palette built on the `cmdk` library. Mounted by `AppLayout` with a topbar button trigger. `lib/commandPalette.ts` owns its pure FX, arithmetic, and ticker-query helpers plus the recent-route storage adapter.

**Coverage**:

- Every non-admin page, grouped by `PALETTE_SECTIONS` as Money (top items plus Money), Wealth and Research (plus AI chat)
- Admin pages when `adminMode` is enabled
- A **New transaction** action (shortcut hint `N`) in the Actions group, which navigates to `/transactions?new=1`
- Theme modes in the Actions group: Light, Dark, System, Schedule
- Settings navigation

**Navigation**: selecting a page just navigates; there is no workspace to switch. If the destination is inside a hidden sidebar section, the sidebar shows that section.

**i18n**: 5 new keys under `commandPalette.*` (en + nl).

Code links: [[apps/frontend/src/components/shared/CommandPalette.tsx]], [[apps/frontend/src/lib/commandPalette.ts]]

---

## ElectronBridge

**Status**: Added June 2026 (ADR-072).

`components/layout/ElectronBridge.tsx` is a side-effect-only component mounted once in `AppLayout` inside `SidebarProvider`. It is a no-op in browser (non-Electron) builds — every call is gated on `isElectronMac()` or `getElectronAPI()`.

**Responsibilities:**

| Responsibility                 | Detail                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ready handshake                | Calls `electronAPI.ready()` on mount — drains the pending IPC send queue in main                                                                                         |
| Menu action routing            | Subscribes to `onMenuAction`; maps `{action, payload}` to React Router navigation, settings/shortcuts dialog dispatch, sidebar toggle, theme mode (`set-theme`, from View › Appearance), or `/transactions?new=1` navigate |
| CSV drag-drop                  | Window-level `dragover`/`drop` intercept; `.csv` → `importHandoff`; exempts `[data-dropzone]` ancestors                                                                  |
| CSV open-with                  | Subscribes to `onCsvOpen`; receives `{name, content}` from main; pushes to `importHandoff` and navigates to `/import`                                                    |
| Fullscreen class               | Subscribes to `onFullScreenChange`; adds/removes `electron-fullscreen` on `<html>`                                                                                       |
| html/native effects management | Adds `electron-mac` on mount; adds/removes the `vibrancy` class and mirrors the same effective ADR-075 tier to the native Electron window material                       |

All IPC subscriptions are attached via stable refs (`useRef`) so React re-renders do not tear down and re-attach listeners. Unsubscribe functions are called in the effect cleanup.

Code link: [[apps/frontend/src/components/layout/ElectronBridge.tsx]]

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/features/views]] - All views
- [[docs/i18n/index]] - Internationalization
- [[docs/components/state-management|State Management]] - Context providers
- [[docs/adr/072-electron-native-desktop-integration|ADR-072: Electron-Native Desktop Integration]] (June 2026 — ElectronBridge, native menu, CSV handoff, system accent)
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]] (June 2026 — atmosphere, PageTransition, CommandPalette)
- [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180: Sidebar sections replace workspaces]] (October 2026 — labelled sidebar, hideable sections, topbar reduction)
- [[docs/adr/099-sidebar-navigation-ia|ADR-099: Sidebar navigation IA]] (workspace layout superseded by ADR-180)
- [[docs/features/application-updates|Application updates]]
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade & Liquid Canvas Removal]]
- [[docs/architecture/electron|Electron Architecture]] — Full IPC surface and native integration docs
- [[docs/reference/code-patterns#motion-consumer-pattern-phase-9|Motion Consumer Pattern]]
- [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]]

## Visual Surface Notes

`AppLayout` renders a fixed `liquid-canvas` atmosphere layer (two aurora blobs + radial wash + SVG grain) behind all page content. This gives glass surfaces real background content to refract. Sidebar navigation uses `.glass-chrome` (24px blur + saturate) with a `primary` selection fill on the active row.

Code links: [[apps/frontend/src/components/layout/AppLayout.tsx]], [[apps/frontend/src/components/layout/AppSidebar.tsx]], [[apps/frontend/src/index.css]], [[apps/frontend/src/styles/tokens.css]]
