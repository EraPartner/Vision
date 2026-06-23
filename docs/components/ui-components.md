---
title: UI Components
type: component
status: active
date: 2026-04-17
updated: 2026-06-17
tags: [components, ui, radix, shadcn, design-system, phase-9, phase-5, performance, glass-downgrade, dependency-slim-down, liquid-glass-v2, premium-v3, june-2026, command-palette, rolling-number, money-typography, delta-pill, shortcuts-overlay, chart-skeleton, virtual-data-table, context-menu, quick-look, keyboard-nav, dialog-genie, icon-bounce, semantic-tokens, focus-visible, overscroll, glass-chrome, liquid-glass-sidebar, canvas-text, aurora-legibility, glass-consistency, popover-glass-thick, role-based-glass]
description: Reusable UI components built on Radix UI primitives with Tailwind CSS, styled with emerald + champagne-gold palette and optimized design tokens. Phase 5 removes unused Carousel, Resizable, and Drawer wrappers. June 2026 Liquid Glass v2 — Card gains universal premium-frame hover, Dialog/AlertDialog use dialog-in/out keyframes, Sonner toasts are glass-thick, EmptyState upgraded, CommandPalette added. June 2026 Premium v3 — RollingNumber, Money, DeltaPill, ShortcutsOverlay, ChartSkeleton shared components; tabs.tsx animated active-pill indicator. June 2026 Premium v3 V5-V7 — VirtualDataTable gains per-row context menu, keyboard row navigation (↑/↓/Enter/Space), and onRowOpen/onRowQuickLook/rowContextMenu props; TransactionQuickLook added. V8: icon-success-bounce animation on Sonner success toast icons. V10: Dialog/AlertDialog genie exit (pointer-driven transform-origin via lib/dialogGenie.ts). June 2026 (UI sweep): ~130 raw palette colors replaced with semantic tokens; focus: → focus-visible: ring idiom; body overscroll-behavior-y: none. June 2026 (glass consistency): full popover family (Popover, DropdownMenu, Select, ContextMenu, MenuBar, HoverCard, Tooltip) converted to glass-thick, matching the dialog/sheet/toast tier.
aliases: [ui-components, radix-components, shadcn-components, primitive-components]
related_code: ["apps/frontend/src/components/ui"]
---

# UI Components

Vision uses a comprehensive set of UI components (45 total, Phase 5 slim-down removed 3 unused wrappers) built on [Radix UI](https://radix-ui.com) primitives, styled with Tailwind CSS and design tokens, and using [class-variance-authority](https://cva.style) for variant management.

## Overview

All UI components are located in `apps/frontend/src/components/ui/` and are based on [shadcn/ui](https://ui.shadcn.com) design patterns. As of Phase 9 + performance optimization (2026-04-17), all components have been tuned to use the emerald + champagne-gold palette, centralized design tokens, and selective glass surfaces optimized for Electron M1 performance.

## Surface Styling (Liquid Glass v2, June 2026)

> [!info] Updated — ADR-070
> The glass surface system was overhauled in June 2026. Blur tiers are higher and saturate is active. See [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] for full rationale.

The UI primitives use a shared surface system defined in [[apps/frontend/src/index.css\|index.css]] and [[apps/frontend/src/styles/tokens.css\|tokens.css]]:

**Glass-based surfaces** (blur + saturate, `backdrop-filter`):

| Class | Blur | Usage |
|-------|------|-------|
| `.glass-thin` | 12px | Subtle interactive elements |
| `.glass-regular` | 20px | **All content / chart / stat / state cards** (role-based glass, June 2026 — see note below); also AI-chat panes |
| `.glass-chrome` | 24px | Sidebar, AppLayout topbar — background alpha 0.55→0.72 (light) / 0.55→0.74 (dark) so aurora and Electron vibrancy glow through the blur |
| `.glass-thick` | 28px | All floating overlays: Modal dialogs (Dialog, AlertDialog, Sheet), Sonner toasts **and** the full popover family (Popover, DropdownMenu/SubContent, SelectContent, ContextMenu, MenuBar, HoverCard, Tooltip) |
| `.glass-elevated` | 32px | Dashboard hero cards (StatCard, NetSummaryCard) |

All glass tiers include `saturate(var(--glass-saturate))` — 180% in light mode, 150% in dark. Thick and elevated tiers add lensing edges (inset specular + concave shade + drop shadow).

> [!info] June 2026 — `.glass-sticky-col` (tier-aware frozen-column helper)
> A `position: sticky` first column inside a glass card needs a background opaque enough to occlude the value cells scrolling beneath it. Plain `bg-card` reads as a matte slab against the translucent card; a per-cell **gradient** is worse (it bands row-to-row down the stack of frozen cells); and `saturate()` over the blur amplifies the aurora behind the card into a muddy tint on the narrow column. `.glass-sticky-col` instead uses a **flat** tint that blends into the card material plus a plain (no-saturate) backdrop blur, scaled by the visual-effects tier (ADR-075):
> - **reduced** (`.fx-reduced`) / `prefers-reduced-transparency` / no `backdrop-filter` support → fully opaque `hsl(var(--card))`, no blur.
> - **standard** (base) → `hsl(var(--card) / 0.72)` + `blur(12px)`.
> - **enhanced** (`.fx-enhanced`) → `hsl(var(--card) / 0.55)` + `blur(16px)` — the card glass reads softly through the column.
>
> The freeze edge is a **soft drop shadow** (`box-shadow: 7px 0 12px -9px …`) — a depth cue, not a hairline border (an earlier hairline read as a "weird border"). `VisualEffectsController` also tags `<html>` with `fx-enhanced` (standard carries no tier class — it is the CSS base). Used by the Category Pivot Table (`CategoryPivotTable.tsx`) on its frozen Category column: header, group/detail rows, and total row.

> [!info] June 2026 — Role-based glass broadening (no ADR yet; a future ADR may formalize this)
> ADR-070 (Liquid Glass v2) established a selective rule: "glass only on ~6 KPI/hero/chart surfaces per viewport; default Card stays opaque." In practice that produced inconsistency — content cards, chart wrappers, and stat cards on the same page were visibly mixed (some glass, some opaque) in the enhanced/vibrancy visual tier. The rule was broadened in June 2026 to a **role-based** model: `glass-regular` is now applied to ALL content / chart / stat / state (loading/empty/error) cards so peers shine consistently. The base `Card` component was NOT modified — glass remains opt-in via `className`. GPU trade-off: card-dense pages now exceed the old ~6-surface-per-viewport budget in standard/enhanced tier; mitigated by ADR-075 tier auto-adapt (auto-degrades to near-opaque under `fx-reduced` and on large displays). Profiling the packaged Electron app on Apple Silicon before each release remains the recommended watchpoint.

**`.glass-chrome` sidebar transparency (June 2026):** Background alphas were lowered from 0.72→0.88 (light) / 0.82→0.96 (dark) to 0.55→0.72 / 0.55→0.74, making the sidebar visibly liquid: the aurora blobs and Electron vibrancy glow through the blur. The blur + saturate veil keeps text legibility even at the lowest alpha. Browsers that lack `backdrop-filter` support fall back to a near-opaque ramp (0.92→0.98) via an `@supports not` rule. `prefers-reduced-transparency` fallback is unchanged.

**`prefers-reduced-transparency`** — strips `backdrop-filter` and applies near-opaque fallbacks. (Previously incorrectly gated on `prefers-reduced-motion`; corrected in ADR-070.)

**Opaque surfaces** (no `backdrop-filter` — role-based exceptions):
- `DataTable`, `VirtualDataTable`, Watchlist grid, holdings tables (pivot/summary/RatesTable) — stay opaque; dense row rendering under a backdrop-filter exceeds GPU budget with no readability benefit
- Dense form/import cards — opaque by design
- Dashed "add" placeholder cards (`bg-muted/30 border-dashed`) — intentionally flat
- Accent/danger callout cards (`bg-primary/5`, `bg-destructive/5`) — colored tint defeats glass
- Cards nested inside an already-glass dialog (e.g., `InvestmentDetailDialog`) — avoids double-blur
- Dashboard recent-transactions skeleton — pairs with its opaque `DataTable`
- `Input`, `Textarea`, `Checkbox`, `RadioGroup`, `Switch`, `Slider`, `Label`
- `Tabs`, `Accordion`, `Collapsible`, `Toggle`, `ToggleGroup`
- `Alert`
- Select/Menu **triggers** (`SelectTrigger`, `MenubarTrigger`) — use `bg-background/80`; their floating content layers are glass-thick

> [!info] Popover family converted to glass-thick (June 2026)
> Previously only the dialog family (Dialog, AlertDialog, Sheet) and Sonner toasts used `glass-thick`. The full popover family (Popover, DropdownMenu, SelectContent, ContextMenu, MenuBar content, HoverCard, Tooltip) was on the flat `bg-popover` fallback. All content/overlay layers in this family now use `glass-thick`, achieving uniform material across every floating surface. The `bg-popover` token, redundant `border border-border/50`, and `shadow-lg/md` were dropped from each primitive (glass-thick supplies them). Reduced-transparency and dark-mode fallbacks in `index.css` already covered glass-thick and are inherited automatically.

**Removed UI wrappers (Phase 5 slim-down)**:
- `Carousel` — unused wrapper around embla-carousel-react; removed with package
- `Resizable` — unused wrapper around react-resizable-panels; removed with package
- `Drawer` — unused wrapper around vaul; removed with package (using Sheet instead)

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/styles/tokens.css]], [[apps/frontend/src/components/ui/card.tsx]], [[apps/frontend/src/components/ui/dialog.tsx]], [[apps/frontend/src/components/ui/input.tsx]], [[apps/frontend/src/components/ui/button.tsx]]

**Motion and premium polish utilities**:

- `.micro-lift` — hover elevation (`translateY(-2px)` + shadow increase, GPU-safe)
- `.press-feedback` — subtle click/tap compression feedback
- `.premium-icon-action` — premium icon-button hover/focus polish in chrome controls
- `.premium-frame` — baked into base `Card` (since ADR-070) — primary-tinted hover outline; previously had to be added per callsite. Declares the same full `transition` list as `micro-lift` (border-color, box-shadow, transform) so both classes harmonize when combined.
- `.icon-touch-target` — consistent touch-safe icon action hit areas (2.5rem square)
- `.liquid-canvas` — fixed-position atmosphere wrapper rendered by `AppLayout`
- `.liquid-canvas-grain` — SVG grain child of the atmosphere layer
- `.canvas-text` — canvas-text legibility guarantee (see below)

Shared table shells (`DataTable`, `VirtualDataTable`) use `premium-frame` + `micro-lift` (opaque, non-glass) for density and readability.

`prefers-reduced-motion`: transitions/animations disabled; aurora drift paused; sidebar `ActiveRail` transitions are instant.

### Canvas-Text Legibility Guarantee (June 2026)

Text rendered directly over the aurora canvas can be washed out when a bright blob drifts behind a glyph — especially visible at aurora peaks in dark mode. A background-colored text-shadow halo restores local contrast exactly at the intersection, and is invisible over surfaces that already match the background.

**Scope**: The halo is applied in dark mode only (`.dark`-scoped). Light mode text is darker than any canvas peak so it needs no supplement.

**Coverage**:
- `dark:` `h1`, `h2`, `h3`, `.font-display` — unconditionally, app-wide
- `.canvas-text` subtree — all `h1/h2/h3/p/span/div` children inside the subtree receive the same halo

**Muted text lift**: Inside a `.canvas-text` subtree, `.text-muted-foreground` is lifted to `foreground/0.72` in dark mode. Muted text is tuned for card surfaces and can fall below legibility comfort at aurora peaks; this selective lift keeps subtitles readable without affecting muted text elsewhere. Applied with `!important` because the rule lives in `@layer base` and must outrank the utilities layer.

**`PageHeader` integration**: `PageHeader` (`components/shared/PageHeader.tsx`) applies `canvas-text` to its root wrapper, so every page's title + subtitle area is covered automatically without per-page changes.

**ShaderAurora opacity (dark mode)**: `ShaderAurora`'s `<canvas>` element uses `dark:opacity-50` (previously `dark:opacity-80`). The reduced opacity keeps the WebGL aurora atmospheric without overpowering the text halo at peak brightness.

**Aurora blob alpha tokens (dark mode)**: `--aurora-primary-alpha` / `--aurora-accent-alpha` / `--aurora-wash-alpha` in `tokens.css` dark-mode block were lowered from `0.16/0.12/0.10` to `0.13/0.10/0.08`. The CSS aurora blobs (always-on fallback under the WebGL shader) are less intense but still visible, reducing the baseline brightness against which text must compete.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/styles/tokens.css]], [[apps/frontend/src/components/layout/ShaderAurora.tsx]], [[apps/frontend/src/components/shared/PageHeader.tsx]]

### Semantic Color Token Sweep (June 2026)

Approximately 130 raw Tailwind palette colors (`text-green-600 dark:text-green-400`, `text-red-500`, amber warning tints, etc.) have been replaced with semantic tokens across import pages/cards, watchlist, performance, market lookup, tax components, settings tabs, notifications, onboarding, ai-chat banner, and UI primitives.

**Semantic tokens in use:**

| Token | Meaning | Usage |
|-------|---------|-------|
| `text-success` / `bg-success` / `border-success` / `ring-success` | Positive/income/green | Profit indicators, income amounts, success states |
| `text-destructive` / `bg-destructive` / `border-destructive` / `ring-destructive` | Negative/expense/red | Loss indicators, expense amounts, error states |
| `text-warning` / `bg-warning` / `border-warning` | Caution/amber | Warning banners, caution states |

These tokens resolve to the correct color for both light and dark modes and respect the macOS system-accent overlay (ADR-072) and all five theme variants.

**Deliberately preserved raw colors (not converted):**

- Categorical palettes: watchlist asset-class hue map, performance allocation series colors, PerformanceBreakdown heatmap ramp, onboarding step decorations, devtools HTTP-method color map
- Blue info accents (`text-blue-*`) — no `--info` semantic token exists yet
- Chart series colors (visx color scales)

**`alert` + `badge` success variants:** The `alert.tsx` and `badge.tsx` primitives gained a `success` CVA variant using `bg-success/10 text-success border-success/20`.

**Sonner success icon:** The Sonner success toast icon uses `text-success` instead of `text-emerald-500` so it inherits theme-variant green.

### focus-visible Ring Convention (June 2026)

Interactive elements use `focus-visible:ring-*` rather than `focus:ring-*`. Two stragglers (a `Select` trigger and a devtools filter input) were corrected. This matches the existing convention (33 uses of `focus-visible:ring` in the codebase) and avoids showing focus rings on mouse clicks.

### Overscroll Behavior (June 2026)

`body` now sets `overscroll-behavior-y: none` in `index.css`. In the packaged Electron shell, unsetting this caused rubber-band overscroll to expose the body background seam and — with vibrancy active — the compositor backdrop behind the window. This is a one-line global fix with no impact on in-page scroll containers.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/components/ui/button.tsx]], [[apps/frontend/src/components/layout/AppLayout.tsx]]

---

## AppLayout & Shell Components (Liquid Glass v2)

> [!info] June 2026 update — atmosphere layer, topbar, CommandPalette, PageTransition re-added

**AppLayout.tsx** — Main app container:
- Renders a fixed `liquid-canvas` atmosphere layer (two aurora blobs + radial wash + SVG grain). Blobs animate via compositor-only `transform`; drift pauses under `prefers-reduced-motion`. Sets `data-workspace` on the liquid canvas for workspace-aware hue swaps (premium v3).
- Conditionally renders `ShaderAurora` inside the liquid canvas when `appSettings.enhancedEffects === true` (premium v3). The CSS aurora blobs are always rendered underneath as a fallback.
- Scroll-linked topbar: material lives in a `::before` pseudo-element that fades in when `[data-scrolled]` is set; passive scroll listener sets the attribute. Also shows page title (from `PageTitleContext`) past 96px scroll (premium v3).
- Mounts `CommandPalette` with topbar ⌘K trigger button.
- Mounts `ShortcutsOverlay` (`?` key) alongside `CommandPalette` (premium v3).
- Wraps child routes in `PageTransition` (enter-only spring).
- Sidebar + chrome: `.glass-chrome` (24px blur, saturated).

**AppSidebar.tsx** — Navigation chrome:
- `.glass-chrome` with active-route accent rail.
- Active rail is now a framer-motion `layoutId="active-rail"` element (`ActiveRail`) that animates between nav items on route change; instant under reduced motion.
- Item `onMouseEnter` triggers `routePreload(path)` via `lib/routePreload.ts` to warm route chunks before click.
- `micro-lift` on hover.

**PageTransition.tsx** — New in June 2026 (enter-only spring):
- Enter-only `motion.div` spring keyed on `location.pathname` — no `AnimatePresence` exit to avoid double-rendering React Suspense boundaries around lazy routes.
- Instant transition when `prefers-reduced-motion` is active.
- Was removed in 2026-04-17 (ADR-020); re-added as enter-only in 2026-06-10 (ADR-070).

**CommandPalette.tsx** — New in June 2026:
- ⌘K / Ctrl+K keyboard shortcut, also triggered by topbar button.
- Built on `cmdk` library; covers all budgeting/portfolio/admin pages, theme variant switch, and settings navigation.
- Cross-workspace jumps sync the sidebar workspace automatically.
- 5 new i18n keys: `commandPalette.*` in en/nl.

Code links: [[apps/frontend/src/components/layout/AppLayout.tsx]], [[apps/frontend/src/components/layout/AppSidebar.tsx]], [[apps/frontend/src/components/layout/PageTransition.tsx]], [[apps/frontend/src/components/shared/CommandPalette.tsx]], [[apps/frontend/src/lib/routePreload.ts]]

---

## Fonts & Typography

**Typography stack** (after font optimization, 2026-04-17):

- **Display**: Fraunces (static weights: 400/600/700, latin subset) — headlines, hero text, stats
- **Body**: Inter (static weights: 400/500/600, latin subset) — copy, labels, form inputs
- **Self-hosted**: Font files loaded via `@fontsource/fraunces` + `@fontsource/inter` (smaller files, no preload needed)

Previous: Variable font ranges (`@fontsource-variable/*`) superseded by static weight selection (5kb savings, faster download).

CSS cleanup:
- Removed: `-webkit-font-smoothing: antialiased` (redundant in modern webkit)
- Removed: `text-rendering: optimizeLegibility` (can cause layout jank on dynamic text)

Code links: [[apps/frontend/package.json]], [[apps/frontend/src/index.css]]

## Shared Page Composition Components

Page-level consistency is provided by reusable shared components:

- `PageHeader` for canonical page title/subtitle/icon/actions layout
- `EmptyState` for standardized empty-state messaging and CTA composition (see below)
- `PageError` for standardized recoverable error presentation

`EmptyState` supports rich content for `title` and `description` via `ReactNode`, enabling multi-line and mixed-content copy while preserving one visual pattern.

### EmptyState (upgraded — Liquid Glass v2)

`EmptyState` was upgraded in June 2026 (ADR-070 Tier 3):

- Icon container is now a `glass-regular` tile over a blurred brand glow (glass material, not a flat background square).
- Title uses the display-serif (Fraunces) `font-display` class for premium emphasis.
- All existing `title` / `description` / `action` props preserved; no API change.

Code links: [[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/components/shared/PageError.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]], [[apps/frontend/src/pages/ImportPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/pages/RecipientInsightsPage.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/pages/OwesPage.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]]

## Notifications (Toast)

Frontend notification rendering is standardized on Sonner:

- `App` mounts only `Sonner`
- New and existing flows should use `toast` from `sonner`
- Legacy Radix toast plumbing (`use-toast` hook wrappers and Radix toaster bridge) has been removed from the frontend package

Code links: [[apps/frontend/src/App.tsx]], [[apps/frontend/src/components/ui/sonner.tsx]], [[apps/frontend/src/components/portfolio/AddToWatchlistDialog.tsx]], [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]], [[apps/frontend/package.json]]

## Component List

### Actions

| Component | Description | File |
|-----------|-------------|------|
| Button | Versatile button with multiple variants | [[apps/frontend/src/components/ui/button.tsx\|button.tsx]] |
| IconButton | Square icon-only button | [[apps/frontend/src/components/ui/button.tsx\|button.tsx]] |
| Command | Searchable command menu | [[apps/frontend/src/components/ui/command.tsx\|command.tsx]] |

### Forms

| Component | Description | File |
|-----------|-------------|------|
| Input | Text input field | [[apps/frontend/src/components/ui/input.tsx\|input.tsx]] |
| Textarea | Multi-line text input | [[apps/frontend/src/components/ui/textarea.tsx\|textarea.tsx]] |
| Select | Dropdown select | [[apps/frontend/src/components/ui/select.tsx\|select.tsx]] |
| Checkbox | Binary checkbox | [[apps/frontend/src/components/ui/checkbox.tsx\|checkbox.tsx]] |
| RadioGroup | Radio button group | [[apps/frontend/src/components/ui/radio-group.tsx\|radio-group.tsx]] |
| Switch | Toggle switch | [[apps/frontend/src/components/ui/switch.tsx\|switch.tsx]] |
| Slider | Range slider | [[apps/frontend/src/components/ui/slider.tsx\|slider.tsx]] |
| Label | Form label | [[apps/frontend/src/components/ui/label.tsx\|label.tsx]] |
| Form | Form wrapper with validation | [[apps/frontend/src/components/ui/form.tsx\|form.tsx]] |

### Feedback

| Component | Description | File |
|-----------|-------------|------|
| Alert | Alert message box | [[apps/frontend/src/components/ui/alert.tsx\|alert.tsx]] |
| AlertDialog | Confirmation dialog | [[apps/frontend/src/components/ui/alert-dialog.tsx\|alert-dialog.tsx]] |
| Sonner | Toast notification system | [[apps/frontend/src/components/ui/sonner.tsx\|sonner.tsx]] |
| Progress | Progress bar | [[apps/frontend/src/components/ui/progress.tsx\|progress.tsx]] |
| Skeleton | Loading placeholder | [[apps/frontend/src/components/ui/skeleton.tsx\|skeleton.tsx]] |

### Layout

| Component | Description | File |
|-----------|-------------|------|
| Card | Content container | [[apps/frontend/src/components/ui/card.tsx\|card.tsx]] |
| Sheet | Side/modal drawer panel | [[apps/frontend/src/components/ui/sheet.tsx\|sheet.tsx]] |
| Separator | Visual divider | [[apps/frontend/src/components/ui/separator.tsx\|separator.tsx]] |
| Accordion | Collapsible sections | [[apps/frontend/src/components/ui/accordion.tsx\|accordion.tsx]] |
| Collapsible | Collapsible content | [[apps/frontend/src/components/ui/collapsible.tsx\|collapsible.tsx]] |
| AspectRatio | Fixed aspect ratio | [[apps/frontend/src/components/ui/aspect-ratio.tsx\|aspect-ratio.tsx]] |

### Navigation

| Component | Description | File |
|-----------|-------------|------|
| Sidebar | Collapsible sidebar | [[apps/frontend/src/components/ui/sidebar.tsx\|sidebar.tsx]] |
| Tabs | Tabbed content | [[apps/frontend/src/components/ui/tabs.tsx\|tabs.tsx]] |
| NavigationMenu | Navigation menu | [[apps/frontend/src/components/ui/navigation-menu.tsx\|navigation-menu.tsx]] |
| Breadcrumb | Breadcrumb trail | [[apps/frontend/src/components/ui/breadcrumb.tsx\|breadcrumb.tsx]] |
| DropdownMenu | Dropdown menu | [[apps/frontend/src/components/ui/dropdown-menu.tsx\|dropdown-menu.tsx]] |
| ContextMenu | Right-click menu | [[apps/frontend/src/components/ui/context-menu.tsx\|context-menu.tsx]] |
| MenuBar | Menu bar | [[apps/frontend/src/components/ui/menubar.tsx\|menubar.tsx]] |

### Data Display

| Component | Description | File |
|-----------|-------------|------|
| Table | Data table | [[apps/frontend/src/components/ui/table.tsx\|table.tsx]] |
| Badge | Status badge | [[apps/frontend/src/components/ui/badge.tsx\|badge.tsx]] |
| Avatar | User avatar | [[apps/frontend/src/components/ui/avatar.tsx\|avatar.tsx]] |
| HoverCard | Popup info card | [[apps/frontend/src/components/ui/hover-card.tsx\|hover-card.tsx]] |
| Tooltip | Hover tooltip | [[apps/frontend/src/components/ui/tooltip.tsx\|tooltip.tsx]] |
| Popover | Popup content | [[apps/frontend/src/components/ui/popover.tsx\|popover.tsx]] |

### Charts

| Component | Description | File |
|-----------|-------------|------|
| Chart | Base chart component | `chart.tsx` (removed in ADR-018; current chart components live under `apps/frontend/src/components/charts/`) |

### Utilities

| Component | Description | File |
|-----------|-------------|------|
| Pagination | Page navigation | [[apps/frontend/src/components/ui/pagination.tsx\|pagination.tsx]] |
| ScrollArea | Scrollable container | [[apps/frontend/src/components/ui/scroll-area.tsx\|scroll-area.tsx]] |
| Calendar | Date picker calendar | [[apps/frontend/src/components/ui/calendar.tsx\|calendar.tsx]] |
| Toggle | Binary toggle | [[apps/frontend/src/components/ui/toggle.tsx\|toggle.tsx]] |
| ToggleGroup | Toggle button group | [[apps/frontend/src/components/ui/toggle-group.tsx\|toggle-group.tsx]] |
| InputOTP | One-time password input | [[apps/frontend/src/components/ui/input-otp.tsx\|input-otp.tsx]] |

---

## Button

Primary action component with multiple variants.

### Variants

```tsx
// Primary action
<Button>Save</Button>

// Destructive action
<Button variant="destructive">Delete</Button>

// Secondary action
<Button variant="secondary">Cancel</Button>

// Outline style
<Button variant="outline">Edit</Button>

// Ghost style
<Button variant="ghost">More</Button>

// Link style
<Button variant="link">Learn more</Button>
```

### Sizes

```tsx
<Button size="default">Default</Button>
<Button size="sm">Small</Button>
<Button size="lg">Large</Button>
<Button size="icon"><Icon /></Button>
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'default' \| 'destructive' \| 'outline' \| 'secondary' \| 'ghost' \| 'link'` | `'default'` | Visual style |
| `size` | `'default' \| 'sm' \| 'lg' \| 'icon'` | `'default'` | Size |
| `asChild` | `boolean` | `false` | Render as child element |
| `disabled` | `boolean` | `false` | Disabled state |

---

## Card

Content container with header, content, and footer sections.

### Usage

```tsx
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Description</CardDescription>
  </CardHeader>
  <CardContent>
    Content goes here
  </CardContent>
  <CardFooter>
    <Button>Action</Button>
  </CardFooter>
</Card>
```

### Components

- `Card` - Root container
- `CardHeader` - Header section
- `CardTitle` - Title text
- `CardDescription` - Description text
- `CardContent` - Main content
- `CardFooter` - Footer/actions

`Card` now has `premium-frame` baked into its base class (June 2026, ADR-070). All cards receive the primary-tinted hover outline and transition list (border-color, box-shadow, transform) without adding any class manually. Add `glass-regular` / `glass-elevated` via `className` to opt into the glass material — the role-based glass rule (June 2026) means all content/chart/stat/state cards should carry `glass-regular`; the base Card itself is intentionally left opaque for tables, forms, and other exceptions (see opaque surfaces list above).

---

## Input

Standard text input field.

### Usage

```tsx
<Input 
  type="number"
  placeholder="Enter amount"
  value={value}
  onChange={(e) => setValue(e.target.value)}
/>
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `type` | `string` | Input type (text, number, email, password) |
| `placeholder` | `string` | Placeholder text |
| `value` | `string` | Controlled value |
| `disabled` | `boolean` | Disabled state |

---

## Dialog

Modal dialog overlay.

### Usage

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogTrigger asChild>
    <Button>Open Dialog</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
      <Button onClick={handleSave}>Save</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### Animation (Liquid Glass v2 + V10 Genie Exit)

Dialog and `AlertDialog` animations were rebuilt in June 2026 (ADR-070):

- Enter: `animate-dialog-in` keyframe with overshoot bezier `cubic-bezier(0.34, 1.45, 0.64, 1)` — spring feel without JS, fixes Tailwind v4 `translate`-property double-offset glitch from the prior `slide-in-from-left-1/2` recipe.
- Exit: `animate-dialog-out` keyframe.
- `motion-reduce` media query disables both keyframes.

#### Genie Exit (V10 — `lib/dialogGenie.ts`)

V10 adds pointer-driven transform-origin for dialog close animations:

- **`lib/dialogGenie.ts`**: A module-level `pointerdown` capture listener records the last pointer position and timestamp. `useGenieOrigin()` returns a ref callback; attaching it to `DialogContent` (or `AlertDialogContent`) sets three CSS custom properties on the element at mount time when the opening pointer event is less than 1.5 s old: `--genie-origin` (transform-origin as `{x}% {y}%`), `--genie-scale`, `--genie-y`.
- **`dialog-out` keyframe target** (tailwind.config.ts): now animates to `scale(var(--genie-scale, 0.97)) translateY(var(--genie-y, 6px))` — pointer-opened dialogs shrink toward the pointer; keyboard-opened dialogs fall back to the previous neutral exit. Duration increased from 160 ms to 200 ms for readable travel.
- **Closed-state**: `data-[state=closed]:[transform-origin:var(--genie-origin,50%_50%)]` is applied in `dialog.tsx` and `alert-dialog.tsx`.
- **`composeRefs` helper**: exported from `dialogGenie.ts` for merging multiple React refs on the same element.
- **Sheets**: not affected (Sheet polish remains on the v4 candidate list).
- **Reduced motion**: unaffected — `animate-none` already kills both keyframes.

```typescript
// Consuming the hook (already wired into dialog.tsx / alert-dialog.tsx)
import { useGenieOrigin, composeRefs } from "@/lib/dialogGenie";

function MyDialogContent({ ref, ...props }) {
  const genieRef = useGenieOrigin();
  return <DialogPrimitive.Content ref={composeRefs(ref, genieRef)} {...props} />;
}
```

Code links: [[apps/frontend/src/lib/dialogGenie.ts]], [[apps/frontend/src/components/ui/dialog.tsx]], [[apps/frontend/src/components/ui/alert-dialog.tsx]]

### Components

- `Dialog` - Root
- `DialogTrigger` - Open trigger
- `DialogContent` - Modal content (`.glass-thick`)
- `DialogHeader` - Header section
- `DialogTitle` - Title
- `DialogDescription` - Description
- `DialogFooter` - Footer with actions

---

## Sonner (Liquid Glass v2 + V8 Icon Bounce)

Toasts use `.glass-thick` material (28px blur + saturate) as of June 2026 (ADR-070). Previously a solid/semi-transparent surface.

### Icon Success Bounce (V8)

All Sonner success toast icons receive an SF-Symbols-style bounce animation automatically via a global CSS rule (no per-callsite changes needed):

```css
/* index.css — covers all ~75 toast.success() call sites */
[data-sonner-toast][data-type="success"] [data-icon] {
  animation: icon-success-bounce 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes icon-success-bounce {
  0%   { transform: scale(0.4) rotate(-8deg); opacity: 0; }
  60%  { transform: scale(1.15) rotate(4deg); opacity: 1; }
  100% { transform: scale(1) rotate(0deg); }
}
```

- The `.icon-success-bounce` utility class is also available for ad-hoc use on any icon element (e.g., the `CheckCircle2` in `TransactionImportCard`'s import-complete summary).
- `prefers-reduced-motion: reduce` sets `animation: none` on the class and the global rule.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/components/ui/sonner.tsx]], [[apps/frontend/src/features/imports/TransactionImportCard.tsx]]

---

## Table

Data table for displaying lists.

### Usage

```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Amount</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {data.map((item) => (
      <TableRow key={item.id}>
        <TableCell>{item.name}</TableCell>
        <TableCell>{item.amount}</TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

### Components

- `Table` - Root
- `TableHeader` - Header row group
- `TableBody` - Body row group
- `TableFooter` - Footer row group
- `TableRow` - Row
- `TableHead` - Header cell
- `TableCell` - Data cell
- `TableCaption` - Caption

---

## Tabs

Tabbed interface for organizing content.

### Animated Active-Pill Indicator (Premium v3, June 2026)

`components/ui/tabs.tsx` was rewritten in June 2026 (ADR-071):

- **Active-value context**: `Tabs` now intercepts `value`, `defaultValue`, and `onValueChange` props and mirrors the active tab value through a React context. Both controlled and uncontrolled usage is handled.
- **Framer `layoutId` pill**: Each `TabsTrigger` renders a `motion.span` background pill with `layoutId` scoped per-tablist via `useId()`. Framer Motion smoothly animates the pill between triggers on tab change. The static active background color / ring class is removed in favor of the pill.
- **Constraint**: New `Tabs` consumers must route through this wrapper (they already do, since all existing consumers use `components/ui/tabs.tsx`).

Code link: [[apps/frontend/src/components/ui/tabs.tsx]]

### Usage

```tsx
<Tabs defaultValue="overview">
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="details">Details</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">
    Overview content
  </TabsContent>
  <TabsContent value="details">
    Details content
  </TabsContent>
</Tabs>
```

---

## Premium v3 Shared Components (June 2026)

> [!info] Added in Premium v3 — ADR-071
> The following shared components were added in the Premium v3 batch. They live in `components/shared/` and `components/charts/`.

### RollingNumber

**File:** [[apps/frontend/src/components/shared/RollingNumber.tsx]]

Odometer-style digit animation for hero numeric values.

- Renders per-digit vertical 0–9 strips animated via `translateY` in em units.
- Digits are keyed from the right so digit identity is preserved across length changes (e.g., "9" → "10" only the new digit animates in, the "0" is stable).
- Non-digit characters (currency symbol, decimal separator, thousands separator) are rendered as static spans.
- `aria-label` on the parent container; `aria-hidden` on the digit reels.
- `prefers-reduced-motion` → renders a plain `<span>` with no animation.

**Adoption:** StatCard and NetSummaryCard hero values. Replaces `useCountUp` interpolation in those components (the `useCountUp` hook itself is retained — other consumers may still use it).

### Money

**File:** [[apps/frontend/src/components/shared/Money.tsx]]

`Intl.NumberFormat.formatToParts`-based currency micro-typography:

- Currency symbol: ~0.65em, raised (superscript-aligned), muted color.
- Integer part: normal weight.
- Fraction + decimal separator: ~0.7em, 70% opacity — visually de-emphasized without hiding.
- Negative amounts now display an explicit "−" prefix (was color-only on the dashboard).

**Adoption:** Transactions table amount cell, DashboardPage recent-transactions amount column.

**Not adopted (deferred):** NetSummaryCard income/spending sub-stats (compact format conflicts with decimals treatment); portfolio asset pages (sweep later).

### DeltaPill

**File:** [[apps/frontend/src/components/shared/DeltaPill.tsx]]

Standardized tinted change chip:

- **success** tint for positive deltas; **destructive** tint for negative; **muted** for neutral.
- Direction arrow (↑/↓) included.
- `invert?: boolean` prop for spend-down-is-good semantics (e.g., expense reduction should be green).
- **Adoption:** StatCard `change` prop; portfolio holdings tables and summary cards (StocksPage unrealized-percent cell, CryptoPage unrealized-percent cell, RealEstatePage Total Return ROI subtitle and per-property card ROI — B3 of the Premium v3 batch, completed 2026-06-11).

### ShortcutsOverlay

**File:** [[apps/frontend/src/components/shared/ShortcutsOverlay.tsx]]

Glass dialog listing real keyboard shortcuts:

- Triggered by the `?` key (when focus is not in an `input`/`textarea`/`contenteditable`).
- Lists: ⌘K (command palette), ⌘, (settings), ⌘B (toggle sidebar), ⌘Z (undo delete), ↑/↓ (table row navigation), ↵ (open transaction details), Space (Quick Look), ? (this overlay), Esc (close dialog), the chart scrub drag hint, and a right-click row tip.
- Mounted in `AppLayout` alongside `CommandPalette`.
- i18n keys (premium v3 V5 additions): `shortcuts.tableNav`, `shortcuts.tableOpen`, `shortcuts.quickLook`, `shortcuts.rowMenu` (tip line); prior batch: `shortcuts.title`, `shortcuts.showHelp`, `shortcuts.closeDialog`, `shortcuts.chartScrub`, `shortcuts.undoDelete`, `shortcuts.goTo`.

### ChartSkeleton

**File:** [[apps/frontend/src/components/charts/ChartSkeleton.tsx]]

Ghost waveform placeholder for chart loading states:

- Renders an SVG waveform path + shimmer animation.
- Replaces plain rectangle `Skeleton` components in `DashboardPage` chart card skeletons.
- Accepts a `height` prop; defaults to the standard chart card height.

---

## VirtualDataTable — Row Interactions (Premium v3 V5-V7, June 2026)

**File:** [[apps/frontend/src/components/shared/VirtualDataTable.tsx]]

`VirtualDataTable` received three new interaction capabilities in the premium-v3 V5-V7 batch. All are optional and backward-compatible — consumers that pass none of these props retain the existing double-click-only behavior.

### New Props

| Prop | Type | Description |
|------|------|-------------|
| `onRowOpen` | `(row, index) => void` | Called on Enter key when a row is focused. Falls back to `onRowDoubleClick` if absent. |
| `onRowQuickLook` | `(row, index) => void` | Called on Space key when a row is focused. Falls back to `onRowDoubleClick` if absent. |
| `rowContextMenu` | `(row, index, helpers: { startEditing() }) => ReactNode` | Per-row right-click menu. Return a `<ContextMenuContent>`. Each row is wrapped in a Radix `ContextMenu` root. |

### Keyboard Row Navigation

When any of `onRowDoubleClick`, `onRowOpen`, or `onRowQuickLook` is present, rows become focusable (`tabIndex=0`) and support:

- **↑ / ↓** — move focus to the previous/next row. Uses `virtualizer.scrollToIndex()` to bring the target row into the virtual window, then retries `focus()` via `requestAnimationFrame` (up to 5 attempts) until the `[data-index]` element is mounted.
- **Enter** — fires `onRowOpen ?? onRowDoubleClick`.
- **Space** — fires `onRowQuickLook ?? onRowDoubleClick`.
- Keys are suppressed if the event target is a descendant (e.g., an inline-edit input), so typing in edit fields is not hijacked.

Rows display a `focus-visible:ring-2 focus-visible:ring-primary/50` focus ring when keyboard-focused.

### Per-Row Context Menu

The `rowContextMenu` callback receives:

```tsx
rowContextMenu={(row, sourceIndex, helpers) => (
    <ContextMenuContent>
        <ContextMenuItem onSelect={() => doSomething(row)}>Action</ContextMenuItem>
        <ContextMenuItem onSelect={helpers.startEditing}>Edit in row</ContextMenuItem>
    </ContextMenuContent>
)}
```

`helpers.startEditing` begins the table's built-in inline edit for that row (equivalent to clicking the pencil icon).

> [!warning] `modal={false}` on ContextMenu root
> Each row's `ContextMenu` is mounted with `modal={false}`. A modal Radix menu locks `pointer-events` on the document body while open. When a menu item opens a page-level `Dialog`, the dialog's own pointer-event lock races the menu's lock and can leave the page in an inert state. `modal={false}` avoids this. The menu still closes on selection and on outside clicks — only the body pointer-event lock is skipped.

### TransactionQuickLook

**File:** [[apps/frontend/src/features/transactions/components/TransactionQuickLook.tsx]]

Read-only glanceable peek dialog toggled by Space on a focused transaction row (Finder-style behavior — Space also closes it):

- Displays: large money amount (sign + color), recipient, date · bank, category badge, inactive badge if applicable, tag chips, memo/comment block, "Press Space to close" hint.
- `Dialog` opened by `quickLookTransaction` state in `TransactionsPage`; closed by Space inside `DialogContent` or by Esc (Radix default).
- Focus returns to the originating row after close so ↑/↓ navigation continues uninterrupted.
- Distinct from `TransactionInfoDialog` (which allows editing). Quick Look is intentionally read-only.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/features/transactions/components/TransactionQuickLook.tsx]], [[apps/frontend/src/features/transactions/components/TransactionsTable.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]]

---

## Select

Dropdown selection component.

### Usage

```tsx
<Select onValueChange={setValue}>
  <SelectTrigger>
    <SelectValue placeholder="Select option" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="option1">Option 1</SelectItem>
    <SelectItem value="option2">Option 2</SelectItem>
  </SelectContent>
</Select>
```

---

## Design Patterns

### Variant System

Components use `class-variance-authority` (CVA) for managing multiple variants:

```tsx
const buttonVariants = cva("base-classes", {
  variants: {
    variant: {
      default: "variant-classes",
      destructive: "destructive-classes",
    },
    size: {
      default: "size-classes",
      sm: "sm-classes",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});
```

### Composition

Components are composed together for complex UIs:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
  </CardHeader>
  <CardContent>
    <Table>...</Table>
  </CardContent>
  <CardFooter>
    <Button>Action</Button>
  </CardFooter>
</Card>
```

### Accessibility

All components follow WAI-ARIA patterns via Radix primitives:
- Keyboard navigation
- Screen reader support
- Focus management
- Proper ARIA attributes

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/features/views]] - Views using these components
- [Radix UI Docs](https://radix-ui.com)
- [shadcn/ui](https://ui.shadcn.com)

## Chart Tooltip Notes

Shared chart tooltip numeric rendering is hardened to be zero-safe and robust for mixed numeric payloads (including `0`, undefined-like values, and formatted values).

Numeric fallback formatting now uses `getCurrencyFormatDefaults().locale` from [[apps/frontend/src/utils/currency.ts]] (instead of bare `Intl.NumberFormat()` locale defaults) for settings-consistent locale output.

Code links: `apps/frontend/src/components/charts/` (chart.tsx removed in ADR-018 visx/d3 migration), [[apps/frontend/src/utils/currency.ts]], [[apps/frontend/src/pages/StatisticsPage.tsx]]
