---
title: UI Components
type: component
status: active
date: 2026-04-17
updated: 2026-04-25
tags: [components, ui, radix, shadcn, design-system, phase-9, phase-5, performance, glass-downgrade, dependency-slim-down]
description: Reusable UI components built on Radix UI primitives with Tailwind CSS, styled with emerald + champagne-gold palette and optimized design tokens. Phase 5 removes unused Carousel, Resizable, and Drawer wrappers.
aliases: [ui-components, radix-components, shadcn-components, primitive-components]
related_code: ["apps/frontend/src/components/ui"]
---

# UI Components

Vision uses a comprehensive set of UI components (45 total, Phase 5 slim-down removed 3 unused wrappers) built on [Radix UI](https://radix-ui.com) primitives, styled with Tailwind CSS and design tokens, and using [class-variance-authority](https://cva.style) for variant management.

## Overview

All UI components are located in `apps/frontend/src/components/ui/` and are based on [shadcn/ui](https://ui.shadcn.com) design patterns. As of Phase 9 + performance optimization (2026-04-17), all components have been tuned to use the emerald + champagne-gold palette, centralized design tokens, and selective glass surfaces optimized for Electron M1 performance.

## Surface Styling (Performance-Optimized Glass)

The UI primitives use a shared surface system defined in [[apps/frontend/src/index.css\|index.css]], with glass blur selectively applied to high-priority overlays only:

**Glass-based surfaces** (retained blur, 6-12px):

- `.glass-thin` (6px) — subtle interactive elements
- `.glass-regular` (8px) — standard overlay (default)
- `.glass-thick` (12px) — modal dialogs (Dialog, AlertDialog)
- `.glass-chrome` (8px) — navigation chrome (Sidebar, AppLayout)

Applied to modals only:
- `Dialog`, `AlertDialog`, `Sheet` (modal overlays) use `.glass-thick` with `bg-card/95` fallback
- `Sidebar`/`AppLayout` navigation chrome uses `.glass-chrome`
- Popovers + Tooltips use `.glass-regular` (lowest-impact overlays)

**Solid-surface pattern** (removed blur, 95% opacity):

Dense components now use `bg-card/95` + single subtle border + ≤8px shadow:
- `Card` root (standard app surface)
- `Button` variants (removed `.liquid-glass-soft`)
- Input, Textarea, Checkbox, RadioGroup, Switch, Slider, Label
- Tabs, Select, DropdownMenu, ContextMenu, MenuBar
- Accordion, Collapsible, Toggle, ToggleGroup
- Alert, HoverCard
- Sonner toast notifications

**Removed UI wrappers (Phase 5 slim-down)**:
- `Carousel` — unused wrapper around embla-carousel-react; removed with package
- `Resizable` — unused wrapper around react-resizable-panels; removed with package
- `Drawer` — unused wrapper around vaul; removed with package (using Sheet instead)

**Rationale**: Electron M1 GPU regression from blur + saturation filtering on frequently-occluded surfaces. Solid opacity-based layering (95% color + transparency) achieves visual depth with zero GPU blur cost. See [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] for details.

**Removed components**:
- `.liquid-canvas` animated background mesh (see AppLayout, below)
- `liquid-drift` / `liquid-canvas-drift` keyframes (static grain overlay retained)
- `saturate()` filters (drop color saturation amplification; rely on opacity for readability)

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/components/ui/card.tsx]], [[apps/frontend/src/components/ui/dialog.tsx]], [[apps/frontend/src/components/ui/input.tsx]], [[apps/frontend/src/components/ui/button.tsx]]

**Minimal motion and premium polish utilities**:

- `.micro-lift` — very small hover elevation (transform only, GPU-safe; `will-change: transform` on `:hover` only)
- `.press-feedback` — subtle click/tap compression feedback
- `.premium-icon-action` — premium icon-button hover/focus polish in chrome controls
- `.premium-frame` — elevated depth without glass blur (shadows + opacity)
- `.icon-touch-target` — consistent touch-safe icon action hit areas (2.5rem square)
- `.surface-default` / `.surface-elevated` / `.surface-glass` — sanctioned surface recipes

Shared table shells (`DataTable`, `VirtualDataTable`) use `premium-frame` + `micro-lift` (non-glass) for cleaner density and readability.

Reduced-motion behavior explicitly disables transitions/animations when `prefers-reduced-motion: reduce` is active.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/components/ui/button.tsx]], [[apps/frontend/src/components/layout/AppLayout.tsx]]

---

## AppLayout & Shell Components

**AppLayout.tsx** — Main app container:
- Removed: `.liquid-canvas` animated gradient mesh + `liquid-drift` keyframe animation
- Retained: Static grain overlay (CSS rule, no animation)
- Sidebar + chrome use `.glass-chrome` (8px blur retained)
- Page transitions: Direct route outlet render (PageTransition wrapper removed)

**AppSidebar.tsx** — Navigation chrome:
- `.glass-chrome` with emerald accent rail on active route
- `micro-lift` on hover

**PageTransition.tsx** — Removed entirely (confirmed unused):
- Previous: Spring-based route choreography (enter: 300ms spring, exit: 200ms fade)
- Now: Direct React Router outlet (instant transitions)
- Rationale: Spring physics on route changes added GPU complexity for marginal UX benefit

Code links: [[apps/frontend/src/components/layout/AppLayout.tsx]], [[apps/frontend/src/components/layout/AppSidebar.tsx]]

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
- `EmptyState` for standardized empty-state messaging and CTA composition
- `PageError` for standardized recoverable error presentation

`EmptyState` supports rich content for `title` and `description` via `ReactNode`, enabling multi-line and mixed-content copy while preserving one visual pattern.

Code links: [[apps/frontend/src/components/shared/PageHeader.tsx]], [[apps/frontend/src/components/shared/EmptyState.tsx]], [[apps/frontend/src/components/shared/PageError.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]], [[apps/frontend/src/pages/ImportPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx]], [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]], [[apps/frontend/src/pages/RecipientInsightsPage.tsx]], [[apps/frontend/src/pages/TaxOverviewPage.tsx]], [[apps/frontend/src/pages/OwesPage.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]]

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

`Card` uses standard app surface defaults and glass can be applied selectively via `className` utilities.

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

### Components

- `Dialog` - Root
- `DialogTrigger` - Open trigger
- `DialogContent` - Modal content
- `DialogHeader` - Header section
- `DialogTitle` - Title
- `DialogDescription` - Description
- `DialogFooter` - Footer with actions

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
