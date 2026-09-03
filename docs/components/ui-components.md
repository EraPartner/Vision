---
title: UI Components
type: component
status: active
date: 2026-04-17
updated: 2026-09-03
tags:
  [
    components,
    ui,
    radix,
    shadcn,
    design-system,
    phase-9,
    phase-5,
    performance,
    glass-downgrade,
    dependency-slim-down,
    liquid-glass-v2,
    premium-v3,
    june-2026,
    command-palette,
    rolling-number,
    money-typography,
    delta-pill,
    shortcuts-overlay,
    chart-skeleton,
    virtual-data-table,
    context-menu,
    quick-look,
    keyboard-nav,
    dialog-genie,
    icon-bounce,
    semantic-tokens,
    focus-visible,
    overscroll,
    glass-chrome,
    liquid-glass-sidebar,
    canvas-text,
    aurora-legibility,
    glass-consistency,
    popover-glass-thick,
    role-based-glass,
    small-viewport-robustness,
    badge-size-variant,
  ]
description: Reusable UI components built on Radix UI primitives with Tailwind CSS, styled with emerald + champagne-gold palette and optimized design tokens. Phase 5 removes unused Carousel, Resizable, and Drawer wrappers. June 2026 Liquid Glass v2 established the glass and premium-frame system; current Card behavior keeps the resting frame and glass material in the base and gates hover lift, elevated shadow, and press feedback behind `variant="interactive"`. Dialog/AlertDialog use dialog-in/out keyframes; Sonner toasts are glass-thick; EmptyState and CommandPalette are shared primitives. June 2026 Premium v3 added RollingNumber, Money, DeltaPill, ShortcutsOverlay, ChartSkeleton, animated tabs, VirtualDataTable context menus/keyboard navigation, TransactionQuickLook, success-icon motion, and dialog genie exits. June 2026 consistency work tokenized raw palette/focus/overscroll behavior and converted the full popover family to glass-thick. Aug 2026 small-viewport work added Badge sizes, bounded DialogContent, horizontally scrolling TabsList, and Accordion trailing controls. 2026-08-27 synchronizes the Card and press-feedback motion contract.
aliases:
  [ui-components, radix-components, shadcn-components, primitive-components]
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

| Class             | Blur | Usage                                                                                                                                                                                                        |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.glass-thin`     | 12px | Subtle standalone controls and top chrome; nested table/composer chrome stays opaque                                                                                                                         |
| `.glass-regular`  | 20px | **All content / chart / stat / state cards** (role-based glass, June 2026 — see note below); also AI-chat panes                                                                                              |
| `.glass-chrome`   | 24px | Sidebar, AppLayout topbar — background alpha 0.55→0.72 (light) / 0.55→0.74 (dark) so aurora and Electron vibrancy glow through the blur                                                                      |
| `.glass-thick`    | 28px | All floating overlays: Modal dialogs (Dialog, AlertDialog, Sheet), Sonner toasts **and** the full popover family (Popover, DropdownMenu/SubContent, SelectContent, ContextMenu, MenuBar, HoverCard, Tooltip) |
| `.glass-elevated` | 32px | Dashboard hero cards (StatCard, NetSummaryCard)                                                                                                                                                              |

All glass tiers include `saturate(var(--glass-saturate))` — 180% in light mode, 150% in dark. Thick and elevated tiers add lensing edges (inset specular + concave shade + drop shadow).

> [!info] August 2026 — opaque frozen-column and nested-chrome policy
> A `position: sticky` first column must occlude value cells scrolling beneath it, but applying a backdrop filter to every sticky `<td>` creates one live blur region per rendered row. `.table-sticky-col` therefore uses opaque `card` color plus the existing soft freeze-edge shadow, with no blur in any effects tier. The Category Pivot Table uses it for header, group/detail, and total cells. AI tool-table headers and the chat composer follow the same rule when nested inside an already-glass card: opaque semantic card color and borders preserve contrast without re-blurring the parent surface.

> [!info] June 2026 — Role-based glass broadening (no ADR yet; a future ADR may formalize this)
> ADR-070 (Liquid Glass v2) established a selective rule: "glass only on ~6 KPI/hero/chart surfaces per viewport; default Card stays opaque." In practice that produced inconsistency — content cards, chart wrappers, and stat cards on the same page were visibly mixed (some glass, some opaque) in the enhanced/vibrancy visual tier. The rule was broadened to a **role-based** model: the base `Card` now carries `glass-regular` so content/chart/stat/state peers shine consistently. Dense tables, forms, placeholders, callouts, and nested cards opt out with their own opaque surface classes. GPU trade-off: card-dense pages can exceed the old ~6-surface-per-viewport budget in standard/enhanced tier; mitigated by ADR-075 tier auto-adapt. Profile the packaged Electron app on Apple Silicon before each release.

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

Floating overlays keep a quieter motion hierarchy than modal dialogs. Popover, DropdownMenu,
SelectContent, ContextMenu, and Tooltip retain their subtle scale/directional transitions but use
`--duration-fast` with `--ease-out-expo`. Both entry and exit animation are disabled under
`prefers-reduced-motion`. Sheet retains its larger side-slide at `--duration-slow` on entry and
`--duration-normal` on exit; content and dimming overlay share those tokens and the same two-state
reduced-motion gate.

**Removed UI wrappers (Phase 5 slim-down)**:

- `Carousel` — unused wrapper around embla-carousel-react; removed with package
- `Resizable` — unused wrapper around react-resizable-panels; removed with package
- `Drawer` — unused wrapper around vaul; removed with package (using Sheet instead)

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/styles/tokens.css]], [[apps/frontend/src/components/ui/card.tsx]], [[apps/frontend/src/components/ui/dialog.tsx]], [[apps/frontend/src/components/ui/input.tsx]], [[apps/frontend/src/components/ui/button.tsx]]

`CardTitle` has three named typography roles: `default` for a 2xl display title,
`sm` for the smallest supported display title (`text-lg`), and `label` for the
body-font eyebrow role used by KPI labels. Call sites do not downsize the display
face with `text-xs`, `text-sm`, or `text-base` overrides.

Its semantic heading level is independent of typography. `CardTitle` defaults to
`level={2}` so a page card follows the page `h1` without skipping a level. Use
`level={3}` or `level={4}` only when the card is genuinely nested beneath a visible
parent section heading; do not choose a level to obtain a visual size.

**Motion and premium polish utilities**:

- `.micro-lift` — a non-Card hover elevation (`translateY(-1px)`); it does not add a shadow.
- `.press-feedback` — subtle click/tap compression feedback (`transform: scale(0.97)` at `--duration-press`/`ease-out`). It owns the element's `transition` **shorthand**. Direct TSX consumers therefore put their full transition list in the non-inheriting `--press-compose` custom property and restate `transform var(--duration-press) ease-out`; the source contract test enforces both entries. Do not use `transition-*` utilities beside `.press-feedback`, because the shorthand clobbers them. Interactive Card is the sole exception: its higher-specificity CSS rule composes one fixed list for every instance.
- `.premium-icon-action` — premium icon-button hover/focus polish in chrome controls
- `.premium-frame` — the resting frame baked into the Card base.
- `.premium-frame-interactive` — added only by `Card variant="interactive"`; owns the hover outline, lift, pre-rendered elevated-shadow crossfade, composed press response, and reduced-motion cancellation.
- `.icon-touch-target` — consistent touch-safe icon action hit areas (2.5rem square)
- `.liquid-canvas` — fixed-position atmosphere wrapper rendered by `AppLayout`
- `.liquid-canvas-grain` — SVG grain child of the atmosphere layer
- `.canvas-text` — canvas-text legibility guarantee (see below)

Dense table shells override the base material with an opaque surface. They do not add Card hover motion unless the table itself has a real activation affordance.

`prefers-reduced-motion`: transitions/animations disabled; aurora drift paused; sidebar `ActiveRail` transitions are instant.

### Canvas-Text Legibility Guarantee (June 2026)

Text rendered directly over the aurora canvas can be washed out when a bright blob drifts behind a glyph — especially visible at aurora peaks in dark mode. A single background-colored text-shadow halo restores local contrast on the canonical page title and subtitle without adding two blurred paint layers to every heading and descendant text node.

**Scope**: The halo is applied in dark mode only (`.dark`-scoped). Light mode text is darker than any canvas peak so it needs no supplement.

**Coverage**:

- `dark:` `h1`, `h2`, `h3`, `.font-display` — unconditionally, app-wide
- `.page-header-title` and `.page-header-subtitle` — the two direct PageHeader text roles receive the halo

**Muted text lift**: Inside a `.canvas-text` subtree, `.text-muted-foreground` is lifted to `foreground/0.72` in dark mode. Muted text is tuned for card surfaces and can fall below legibility comfort at aurora peaks; this selective lift keeps subtitles readable without affecting muted text elsewhere. Applied with `!important` because the rule lives in `@layer base` and must outrank the utilities layer.

**`PageHeader` integration**: `PageHeader` (`components/shared/PageHeader.tsx`) applies `canvas-text` to its root wrapper for the muted-text lift and marks its title/subtitle with the two narrow halo roles. Action controls and arbitrary nested spans/divs do not inherit a text shadow.

**ShaderAurora opacity (dark mode)**: `ShaderAurora`'s `<canvas>` element uses `dark:opacity-50` (previously `dark:opacity-80`). The reduced opacity keeps the WebGL aurora atmospheric without overpowering the text halo at peak brightness.

**Aurora blob alpha tokens (dark mode)**: `--aurora-primary-alpha` / `--aurora-accent-alpha` / `--aurora-wash-alpha` in `tokens.css` dark-mode block were lowered from `0.16/0.12/0.10` to `0.13/0.10/0.08`. The CSS aurora blobs (always-on fallback under the WebGL shader) are less intense but still visible, reducing the baseline brightness against which text must compete.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/styles/tokens.css]], [[apps/frontend/src/components/layout/ShaderAurora.tsx]], [[apps/frontend/src/components/shared/PageHeader.tsx]]

### Semantic Color Token Sweep (June 2026)

Approximately 130 raw Tailwind palette colors (`text-green-600 dark:text-green-400`, `text-red-500`, amber warning tints, etc.) have been replaced with semantic tokens across import pages/cards, watchlist, performance, market lookup, tax components, settings tabs, notifications, onboarding, ai-chat banner, and UI primitives.

**Semantic tokens in use:**

| Token                                                                             | Meaning                  | Usage                                             |
| --------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------- |
| `text-success` / `bg-success` / `border-success` / `ring-success`                 | Positive/income/green    | Profit indicators, income amounts, success states |
| `text-destructive` / `bg-destructive` / `border-destructive` / `ring-destructive` | Negative/expense/red     | Loss indicators, expense amounts, error states    |
| `text-warning` / `bg-warning` / `border-warning`                                  | Caution/amber            | Warning banners, caution states                   |
| `text-info` / `bg-info` / `border-info`                                           | Neutral information/blue | Import status, HTTP GET, frozen-year information  |

These tokens resolve to the correct color for both light and dark modes and respect the macOS system-accent overlay (ADR-072) and all five theme variants.

**Deliberately preserved raw colors (not converted):**

- Categorical palettes: watchlist asset-class hue map, performance allocation series colors, PerformanceBreakdown heatmap ramp, onboarding step decorations
- Chart series colors (visx color scales)

**`alert` + `badge` success variants:** The `alert.tsx` and `badge.tsx` primitives gained a `success` CVA variant using `bg-success/10 text-success border-success/20`.

**Sonner success icon:** The Sonner success toast icon uses `text-success` instead of `text-emerald-500` so it inherits theme-variant green.

### focus-visible Ring Convention (June 2026)

The default treatment, where component geometry permits, is the semantic house ring `focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2` rather than `focus:ring-*` or a raw primary-colour ring. This avoids mouse-click rings and keeps keyboard focus visible across theme variants. Constrained nested controls may use semantic `ring-ring` variants without an offset, sidebar-owned rings, or deliberately suppress an inherited ring.

### Overscroll Behavior (June 2026)

`body` now sets `overscroll-behavior-y: none` in `index.css`. In the packaged Electron shell, unsetting this caused rubber-band overscroll to expose the body background seam and — with vibrancy active — the compositor backdrop behind the window. This is a one-line global fix with no impact on in-page scroll containers.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/components/ui/button.tsx]], [[apps/frontend/src/components/layout/AppLayout.tsx]]

---

## AppLayout & Shell Components (Liquid Glass v2)

> [!info] June 2026 update — atmosphere layer, topbar, CommandPalette, PageTransition re-added

**AppLayout.tsx** — Main app container:

- Renders a fixed `liquid-canvas` atmosphere layer (two aurora blobs + radial wash + SVG grain). Blobs animate via compositor-only `transform`; drift pauses under `prefers-reduced-motion`. Sets `data-workspace` on the liquid canvas for workspace-aware hue swaps (premium v3).
- Conditionally renders `ShaderAurora` inside the liquid canvas when the effective ADR-075 visual-effects tier is `enhanced`. After a drawable WebGL program exists, `ShaderAurora` adds `fx-webgl-live` and the CSS blobs remain visible underneath as a static fallback. Context loss or teardown removes the class immediately, so the CSS fallback resumes animating when WebGL is unavailable.
- Scroll-linked topbar: material lives in a `::before` pseudo-element that fades in when `[data-scrolled]` is set; passive scroll listener sets the attribute. Also shows page title (from `PageTitleContext`) past 96px scroll (premium v3).
- Mounts `CommandPalette` with topbar ⌘K trigger button.
- Mounts `ShortcutsOverlay` (`?` key) alongside `CommandPalette` (premium v3).
- Wraps child routes in `PageTransition` (enter-only spring).
- Sidebar + chrome: `.glass-chrome` (24px blur, saturated).
- The first keyboard stop is a focus-visible skip link that moves focus to `main#main`. `AppSidebar` exposes its shared desktop/mobile menu as a localized navigation landmark, and its trigger and rail use the same localized toggle label.

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
- **Body**: Inter (static weights: 400/500/600/700 plus 400 italic, latin subset) — copy, labels, form inputs, and monetary values
- **Mono**: SF Mono / JetBrains Mono fallback stack — identifiers and code such as tickers, IBANs, SQL, and API paths; never monetary amounts. `<Money>` owns the canonical Inter/body tabular treatment for currency.
- **Dense microcopy**: `text-2xs` (11px/14px) is the named minimum for chart labels, compact badges, and developer chrome. Do not mint arbitrary `text-[10px]` or `text-[11px]` utilities.
- **Eyebrow labels**: `.eyebrow` owns the uppercase 11px/14px, medium-weight, 0.12em-tracking muted label role. Semantic color utilities may override its muted default; do not rebuild the typography recipe per file.
- **Self-hosted**: Font files loaded via `@fontsource/fraunces` + `@fontsource/inter` (smaller files, no preload needed)

Previous: Variable font ranges (`@fontsource-variable/*`) superseded by static weight selection (5kb savings, faster download).

CSS cleanup:

- Removed: `-webkit-font-smoothing: antialiased` (redundant in modern webkit)
- Removed: `text-rendering: optimizeLegibility` (can cause layout jank on dynamic text)

Code links: [[apps/frontend/package.json]], [[apps/frontend/src/index.css]]

## Shared Page Composition Components

Page-level consistency is provided by reusable shared components:

- `PageHeader` for canonical page title/subtitle/icon/actions layout
- Destination identity icons come from `lib/pageIcons.ts`. Sidebar, command palette, page headers, and identity empty states must not choose separate icons for the same route.
- Ordinary section and chart headings are text-first. Keep an icon only when it communicates identity, state, action, or distinguishes sibling cards; do not add an icon that merely repeats the heading noun.
- `EmptyState` for standardized empty-state messaging and CTA composition (see below)
- `PageError` for standardized recoverable error presentation

`EmptyState` supports rich content for `title` and `description` via `ReactNode`, enabling multi-line and mixed-content copy while preserving one visual pattern.

### EmptyState (upgraded — Liquid Glass v2)

`EmptyState` was upgraded in June 2026 (ADR-070 Tier 3):

- Icon container is now a `glass-regular` tile over a blurred brand glow (glass material, not a flat background square).
- Title uses the display-serif (Fraunces) `font-display` class for premium emphasis.
- All existing `title` / `description` / `action` props preserved; no API change.

Code links: [[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/components/shared/PageError.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]], [[apps/frontend/src/pages/ImportPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/research/WatchlistPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/features/statistics/RecipientInsightsTab.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/pages/OwesPage.tsx]], [[apps/frontend/src/pages/research/MarketLookupPage.tsx]]

## Notifications (Toast)

Frontend notification rendering is standardized on Sonner:

- `App` mounts only `Sonner`
- New and existing flows should use `toast` from `sonner`
- Legacy Radix toast plumbing (`use-toast` hook wrappers and Radix toaster bridge) has been removed from the frontend package

Code links: [[apps/frontend/src/App.tsx]], [[apps/frontend/src/components/ui/sonner.tsx]], [[apps/frontend/src/features/portfolio/AddToWatchlistDialog.tsx]], [[apps/frontend/src/features/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/pages/research/WatchlistPage.tsx]], [[apps/frontend/package.json]]

## Component List

### Actions

| Component  | Description                             | File                                                         |
| ---------- | --------------------------------------- | ------------------------------------------------------------ |
| Button     | Versatile button with multiple variants | [[apps/frontend/src/components/ui/button.tsx\|button.tsx]]   |
| IconButton | Square icon-only button                 | [[apps/frontend/src/components/ui/button.tsx\|button.tsx]]   |
| Command    | Searchable command menu                 | [[apps/frontend/src/components/ui/command.tsx\|command.tsx]] |

### Forms

| Component  | Description                  | File                                                                 |
| ---------- | ---------------------------- | -------------------------------------------------------------------- |
| Input      | Text input field             | [[apps/frontend/src/components/ui/input.tsx\|input.tsx]]             |
| Textarea   | Multi-line text input        | [[apps/frontend/src/components/ui/textarea.tsx\|textarea.tsx]]       |
| Select     | Dropdown select              | [[apps/frontend/src/components/ui/select.tsx\|select.tsx]]           |
| Checkbox   | Binary checkbox              | [[apps/frontend/src/components/ui/checkbox.tsx\|checkbox.tsx]]       |
| RadioGroup | Radio button group           | [[apps/frontend/src/components/ui/radio-group.tsx\|radio-group.tsx]] |
| Switch     | Toggle switch                | [[apps/frontend/src/components/ui/switch.tsx\|switch.tsx]]           |
| Slider     | Range slider                 | [[apps/frontend/src/components/ui/slider.tsx\|slider.tsx]]           |
| Label      | Form label                   | [[apps/frontend/src/components/ui/label.tsx\|label.tsx]]             |
| Form       | Form wrapper with validation | [[apps/frontend/src/components/ui/form.tsx\|form.tsx]]               |

### Feedback

| Component   | Description               | File                                                                   |
| ----------- | ------------------------- | ---------------------------------------------------------------------- |
| Alert       | Alert message box         | [[apps/frontend/src/components/ui/alert.tsx\|alert.tsx]]               |
| AlertDialog | Confirmation dialog       | [[apps/frontend/src/components/ui/alert-dialog.tsx\|alert-dialog.tsx]] |
| Sonner      | Toast notification system | [[apps/frontend/src/components/ui/sonner.tsx\|sonner.tsx]]             |
| Progress    | Progress bar              | [[apps/frontend/src/components/ui/progress.tsx\|progress.tsx]]         |
| Skeleton    | Loading placeholder       | [[apps/frontend/src/components/ui/skeleton.tsx\|skeleton.tsx]]         |

### Layout

| Component   | Description             | File                                                                   |
| ----------- | ----------------------- | ---------------------------------------------------------------------- |
| Card        | Content container       | [[apps/frontend/src/components/ui/card.tsx\|card.tsx]]                 |
| Sheet       | Side/modal drawer panel | [[apps/frontend/src/components/ui/sheet.tsx\|sheet.tsx]]               |
| Separator   | Visual divider          | [[apps/frontend/src/components/ui/separator.tsx\|separator.tsx]]       |
| Accordion   | Collapsible sections    | [[apps/frontend/src/components/ui/accordion.tsx\|accordion.tsx]]       |
| Collapsible | Collapsible content     | [[apps/frontend/src/components/ui/collapsible.tsx\|collapsible.tsx]]   |
| AspectRatio | Fixed aspect ratio      | [[apps/frontend/src/components/ui/aspect-ratio.tsx\|aspect-ratio.tsx]] |

### Navigation

| Component      | Description         | File                                                                         |
| -------------- | ------------------- | ---------------------------------------------------------------------------- |
| Sidebar        | Collapsible sidebar | [[apps/frontend/src/components/ui/sidebar.tsx\|sidebar.tsx]]                 |
| Tabs           | Tabbed content      | [[apps/frontend/src/components/ui/tabs.tsx\|tabs.tsx]]                       |
| NavigationMenu | Navigation menu     | [[apps/frontend/src/components/ui/navigation-menu.tsx\|navigation-menu.tsx]] |
| Breadcrumb     | Breadcrumb trail    | [[apps/frontend/src/components/ui/breadcrumb.tsx\|breadcrumb.tsx]]           |
| DropdownMenu   | Dropdown menu       | [[apps/frontend/src/components/ui/dropdown-menu.tsx\|dropdown-menu.tsx]]     |
| ContextMenu    | Right-click menu    | [[apps/frontend/src/components/ui/context-menu.tsx\|context-menu.tsx]]       |
| MenuBar        | Menu bar            | [[apps/frontend/src/components/ui/menubar.tsx\|menubar.tsx]]                 |

### Data Display

| Component | Description     | File                                                               |
| --------- | --------------- | ------------------------------------------------------------------ |
| Table     | Data table      | [[apps/frontend/src/components/ui/table.tsx\|table.tsx]]           |
| Badge     | Status badge    | [[apps/frontend/src/components/ui/badge.tsx\|badge.tsx]]           |
| Avatar    | User avatar     | [[apps/frontend/src/components/ui/avatar.tsx\|avatar.tsx]]         |
| HoverCard | Popup info card | [[apps/frontend/src/components/ui/hover-card.tsx\|hover-card.tsx]] |
| Tooltip   | Hover tooltip   | [[apps/frontend/src/components/ui/tooltip.tsx\|tooltip.tsx]]       |
| Popover   | Popup content   | [[apps/frontend/src/components/ui/popover.tsx\|popover.tsx]]       |

### Charts

| Component | Description          | File                                                                                                         |
| --------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Chart     | Base chart component | `chart.tsx` (removed in ADR-018; current chart components live under `apps/frontend/src/components/charts/`) |

### Utilities

| Component   | Description             | File                                                                   |
| ----------- | ----------------------- | ---------------------------------------------------------------------- |
| Pagination  | Page navigation         | [[apps/frontend/src/components/ui/pagination.tsx\|pagination.tsx]]     |
| ScrollArea  | Scrollable container    | [[apps/frontend/src/components/ui/scroll-area.tsx\|scroll-area.tsx]]   |
| Calendar    | Date picker calendar    | [[apps/frontend/src/components/ui/calendar.tsx\|calendar.tsx]]         |
| Toggle      | Binary toggle           | [[apps/frontend/src/components/ui/toggle.tsx\|toggle.tsx]]             |
| ToggleGroup | Toggle button group     | [[apps/frontend/src/components/ui/toggle-group.tsx\|toggle-group.tsx]] |
| InputOTP    | One-time password input | [[apps/frontend/src/components/ui/input-otp.tsx\|input-otp.tsx]]       |

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

| Prop       | Type                                                                          | Default     | Description             |
| ---------- | ----------------------------------------------------------------------------- | ----------- | ----------------------- |
| `variant`  | `'default' \| 'destructive' \| 'outline' \| 'secondary' \| 'ghost' \| 'link'` | `'default'` | Visual style            |
| `size`     | `'default' \| 'sm' \| 'lg' \| 'icon'`                                         | `'default'` | Size                    |
| `asChild`  | `boolean`                                                                     | `false`     | Render as child element |
| `disabled` | `boolean`                                                                     | `false`     | Disabled state          |

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
  <CardContent>Content goes here</CardContent>
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

`Card` now has `glass-regular` and the resting `premium-frame` baked into its base class. Static cards do not lift or glow on hover. Use `variant="interactive"` only for activatable cards and deliberately promoted KPI/hero surfaces; that variant adds `premium-frame-interactive`, hover lift, press feedback, and reduced-motion handling. Dense tables, forms, and other opaque exceptions override the base material through their surface class. Do not add `premium-frame` or `micro-lift` manually to a Card.

`CardContent` owns repeated padding shapes through named roles. Use `default` after a header or when nested content owns its vertical inset, `headerless` for ordinary first-child content needing the full 24px inset, `flush` for edge-to-edge tables or media, `compact` for dense controls, `row` for vertically compact rows and summaries, and `state` for short centered empty/error states. Keep `className` for layout and one-off spacing only; do not restate a named role's padding classes at the call site. Component-owned exceptions are the compact `p-1` search result shell, the one-off `py-3` match banner, the investment dialog's asymmetric `pt-4` sections, large empty canvases, and `StatCard`'s size-coupled padding.

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

| Prop          | Type      | Description                                |
| ------------- | --------- | ------------------------------------------ |
| `type`        | `string`  | Input type (text, number, email, password) |
| `placeholder` | `string`  | Placeholder text                           |
| `value`       | `string`  | Controlled value                           |
| `disabled`    | `boolean` | Disabled state                             |

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

#### Genie Exit (V10 — `hooks/useGenieOrigin.ts`)

V10 adds pointer-driven transform-origin for dialog close animations:

- **`hooks/useGenieOrigin.ts`**: A module-level `pointerdown` capture listener records the last pointer position and timestamp. `useGenieOrigin()` returns a ref callback; attaching it to `DialogContent` (or `AlertDialogContent`) sets three CSS custom properties on the element at mount time when the opening pointer event is less than 1.5 s old: `--genie-origin` (element-relative pixels), `--genie-scale`, `--genie-y`.
- **`dialog-out` keyframe target** (tailwind.config.ts): now animates to `scale(var(--genie-scale, 0.97)) translateY(var(--genie-y, 6px))` — pointer-opened dialogs shrink toward the pointer; keyboard-opened dialogs fall back to the previous neutral exit. Duration increased from 160 ms to 200 ms for readable travel.
- **Closed-state**: `data-[state=closed]:[transform-origin:var(--genie-origin,50%_50%)]` is applied in `dialog.tsx` and `alert-dialog.tsx`.
- **`composeRefs` helper**: exported from `lib/composeRefs.ts` for merging multiple React refs on the same element.
- **Sheets**: do not use the pointer-driven genie origin. Their directional slide is deliberately
  quieter than Dialog: tokenized slow entry, normal exit, matching overlay timing, and complete
  entry/exit reduced-motion gates.
- **Reduced motion**: unaffected — `animate-none` already kills both keyframes.

```typescript
// Consuming the hook (already wired into dialog.tsx / alert-dialog.tsx)
import { useGenieOrigin } from "@/hooks/useGenieOrigin";
import { composeRefs } from "@/lib/composeRefs";

function MyDialogContent({ ref, ...props }) {
  const genieRef = useGenieOrigin();
  return <DialogPrimitive.Content ref={composeRefs(ref, genieRef)} {...props} />;
}
```

Code links: [[apps/frontend/src/hooks/useGenieOrigin.ts]], [[apps/frontend/src/lib/composeRefs.ts]], [[apps/frontend/src/components/ui/dialog.tsx]], [[apps/frontend/src/components/ui/alert-dialog.tsx]]

### Components

- `Dialog` - Root
- `DialogTrigger` - Open trigger
- `DialogContent` - Modal content (`.glass-thick`)
- `DialogHeader` - Header section
- `DialogTitle` - Title
- `DialogDescription` - Description
- `DialogFooter` - Footer with actions

### Viewport Height Cap (Aug 2026)

`DialogContent` applies `max-h-[90vh] overflow-y-auto` directly on the primitive, so a tall dialog on a short viewport (landscape phone, on-screen keyboard open) scrolls inside itself instead of clipping both ends and pushing the submit button out of reach. Per-dialog `max-h`/`overflow` overrides still win via `tailwind-merge` (`cn()`), so no dialog ends up with two nested scrollbars.

---

## Sonner (Liquid Glass v2 + V8 Icon Bounce)

Toasts use `.glass-thick` material (28px blur + saturate) as of June 2026 (ADR-070). Previously a solid/semi-transparent surface.

### Icon Success Bounce (V8)

All Sonner success toast icons receive an SF-Symbols-style bounce animation automatically via a global CSS rule (no per-callsite changes needed):

```css
/* index.css — covers all ~75 toast.success() call sites */
[data-sonner-toast][data-type="success"] [data-icon] {
  animation: icon-success-bounce var(--duration-reveal) var(--ease-out-expo)
    150ms both;
}

@keyframes icon-success-bounce {
  0% {
    transform: scale(0.4);
    opacity: 0;
  }
  45% {
    transform: scale(1.22);
    opacity: 1;
  }
  70% {
    transform: scale(0.92);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
```

- The `.icon-success-bounce` utility class is also available for ad-hoc use on any icon element (e.g., the `CheckCircle2` in `TransactionImportCard`'s import-complete summary).
- Vision overrides Sonner's runtime-injected motion with the shared `--duration-*` and `--ease-*` tokens for stack reflow, arrival, dismissal, swipe-out, toast children, promise icons, close and action buttons, and the loader. The declarations use `!important` because Sonner injects its stylesheet after the application stylesheet.
- `prefers-reduced-motion: reduce` disables the success bounce and all Sonner stack, toast, child, promise, swipe, and loader motion.
- The visible, Alt+T-focusable Sonner region has `aria-live="off"`. `Toaster` mirrors new and updated ordinary messages into a polite screen-reader region and errors into an assertive region, avoiding duplicate announcements while preserving the keyboard shortcut.

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

## Badge

Small status/label pill built on `class-variance-authority`.

### Variants

```tsx
<Badge>Default</Badge>
<Badge variant="secondary">Secondary</Badge>
<Badge variant="destructive">Destructive</Badge>
<Badge variant="outline">Outline</Badge>
<Badge variant="warning">Warning</Badge>
<Badge variant="success">Success</Badge>
<Badge variant="muted">Muted</Badge>
```

`muted` (Aug 2026) is a flat neutral pill (`border-transparent bg-muted text-muted-foreground`) for dense table/inspector rows — the opaque counterpart to `secondary`'s translucent glass tone.

### Sizes (Aug 2026)

```tsx
<Badge size="default">Default</Badge>
<Badge size="sm">Small</Badge>
```

`sm` is a dense pill (`px-2 py-0.5 text-xs normal-case tracking-normal`) for table rows and toolbars, where a count or raw identifier needs to stay legible rather than styled as a small-caps label. `size` defaults to `default` (the original small-caps label style) so existing callers are unaffected.

**Adoption:** `ProviderHealthPage` (row status + kind pills) and `ApiInspector` (in-flight request count) now route through `Badge` instead of ad hoc `<span>` pill markup, closing a design-system consistency gap flagged in `TODO.md`.

Code link: [[apps/frontend/src/components/ui/badge.tsx]]

---

## Tabs

Tabbed interface for organizing content.

### Animated Active-Pill Indicator (Premium v3, June 2026)

`components/ui/tabs.tsx` was rewritten in June 2026 (ADR-071):

- **Active-value context**: `Tabs` now intercepts `value`, `defaultValue`, and `onValueChange` props and mirrors the active tab value through a React context. Both controlled and uncontrolled usage is handled.
- **Framer `layoutId` pill**: Each `TabsTrigger` renders a `motion.span` background pill with `layoutId` scoped per-tablist via `useId()`. Framer Motion smoothly animates the pill between triggers on tab change. The static active background color / ring class is removed in favor of the pill.
- **Constraint**: New `Tabs` consumers must route through this wrapper (they already do, since all existing consumers use `components/ui/tabs.tsx`).

Code link: [[apps/frontend/src/components/ui/tabs.tsx]]

### Horizontal Scroll on Narrow Viewports (Aug 2026)

`TabsList` carries `max-w-full overflow-x-auto` with the scrollbar hidden (`[scrollbar-width:none]` + `[&::-webkit-scrollbar]:hidden`). A trigger list with 5–7 tabs (e.g. Statistics' 6 tabs) now scrolls horizontally inside itself at phone widths instead of overhanging the viewport and dragging the whole page into horizontal panning. Desktop layout is unchanged — the list only becomes a scroll container once its triggers overflow the available width.

### Usage

```tsx
<Tabs defaultValue="overview">
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="details">Details</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">Overview content</TabsContent>
  <TabsContent value="details">Details content</TabsContent>
</Tabs>
```

For page-level tabs whose active value should survive reload/Back, see [[docs/components/hooks#usetabparam-aug-2026|useTabParam]] — it binds `Tabs value`/`onValueChange` to a `?tab=` URL param.

---

## Accordion

Collapsible sections built on `@radix-ui/react-accordion`.

### Usage

```tsx
<Accordion type="single" collapsible>
  <AccordionItem value="item-1">
    <AccordionTrigger>Section title</AccordionTrigger>
    <AccordionContent>Section body</AccordionContent>
  </AccordionItem>
</Accordion>
```

### `trailing` / `headerClassName` Props (Aug 2026)

`AccordionTrigger` accepts an optional `trailing` prop for interactive content (e.g. a combobox or a spinner) that belongs on the header row but must not live **inside** the trigger `<button>` — a focusable control nested inside another `<button>` is invalid HTML and unreachable for assistive tech.

```tsx
<AccordionTrigger
  headerClassName="px-4"
  trailing={<RecipientCombobox value={value} onSelect={onSelect} />}
>
  <span>Row label</span>
</AccordionTrigger>
```

When `trailing` is set:

- The `AccordionPrimitive.Header` itself becomes the flex row; the trigger shrinks to just the label, `trailing` is rendered as its sibling, and the chevron moves **outside** the trigger button so it still paints last.
- `headerClassName` carries the row-box classes (padding, etc.) since the header now owns the row box — `className` on `AccordionTrigger` still targets the trigger button itself.
- The chevron keeps its open/close rotation and hover color via a `group/accordion-row` class on the header (Radix mirrors `data-state` onto the header element), and forwards clicks to the trigger so the "click the chevron to toggle" affordance survives the move out of the button.
- Omitting `trailing` renders the original unchanged markup (trigger + inline chevron, header just wraps it).

**Adoption:** `ImportReviewPage`'s per-group accordion row — the recipient-override combobox is a real `<button>`-based combobox and previously lived inside the trigger with a `stopPropagation()` guard; it now rides in `trailing` instead.

Code link: [[apps/frontend/src/components/ui/accordion.tsx]]

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

- **gain** tint for positive deltas; **loss** tint for negative; **muted** for neutral.
- Direction arrow (↑/↓) included.
- `invert?: boolean` prop for spend-down-is-good semantics (e.g., expense reduction should be green).
- **Adoption:** StatCard `change` prop; portfolio holdings tables and summary cards; Research Home benchmark/watchlist quotes; Market Lookup quote changes; Watchlist target/since-added deltas; Research Compare total return; and Statistics subscription price changes. Numeric delta labels use the locale-aware `formatPercent` contract. Signed values use `{ signed: true }`, whose `exceptZero` rule leaves zero unsigned and keeps money and percent signs aligned. Prose such as "above target" passes an unsigned absolute percent because the words already carry the direction.

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

| Prop             | Type                                                     | Description                                                                                                   |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `onRowOpen`      | `(row, index) => void`                                   | Called on Enter key when a row is focused. Falls back to `onRowDoubleClick` if absent.                        |
| `onRowQuickLook` | `(row, index) => void`                                   | Called on Space key when a row is focused. Falls back to `onRowDoubleClick` if absent.                        |
| `rowContextMenu` | `(row, index, helpers: { startEditing() }) => ReactNode` | Per-row right-click menu. Return a `<ContextMenuContent>`. Each row is wrapped in a Radix `ContextMenu` root. |

### Keyboard Row Navigation

When any of `onRowDoubleClick`, `onRowOpen`, or `onRowQuickLook` is present, rows become focusable (`tabIndex=0`) and support:

- **↑ / ↓** — move focus to the previous/next row. Uses `virtualizer.scrollToIndex()` to bring the target row into the virtual window, then retries `focus()` via `requestAnimationFrame` (up to 5 attempts) until the `[data-index]` element is mounted.
- **Enter** — fires `onRowOpen ?? onRowDoubleClick`.
- **Space** — fires `onRowQuickLook ?? onRowDoubleClick`.
- Keys are suppressed if the event target is a descendant (e.g., an inline-edit input), so typing in edit fields is not hijacked.

Rows display the shared `focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2` ring when keyboard-focused.

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

Currency and percent formatting now resolves locale and decimal settings through [[apps/frontend/src/hooks/useCurrencyFormatter.ts]]. `Money` and chart currency adapters compose the same resolver and the pure utilities accept explicit configuration, so rendering no longer depends on an `App.tsx` bootstrap effect.

Code links: `apps/frontend/src/components/charts/` (chart.tsx removed in ADR-018 visx/d3 migration), [[apps/frontend/src/utils/currency.ts]], [[apps/frontend/src/pages/StatisticsPage.tsx]]
