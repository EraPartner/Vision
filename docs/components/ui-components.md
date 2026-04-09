---
title: UI Components
type: component
status: active
date: 2026-04-10
tags: [components, ui, radix, shadcn]
description: Reusable UI components built on Radix UI primitives with Tailwind CSS
aliases: [ui-components, radix-components, shadcn-components, primitive-components]
related_code: ["apps/frontend/src/components/ui"]
---

# UI Components

Vision uses a comprehensive set of UI components built on [Radix UI](https://radix-ui.com) primitives, styled with Tailwind CSS, and using [class-variance-authority](https://cva.style) for variant management.

## Overview

All UI components are located in `apps/frontend/src/components/ui/` and are based on [shadcn/ui](https://ui.shadcn.com) design patterns.

## Surface Styling (Liquid Glass)

The UI primitives use a shared liquid-glass surface system defined in [[apps/frontend/src/index.css\|index.css]]:

- `.liquid-glass` — stronger frosted surface for overlays and selected surfaces
- `.liquid-glass-soft` — softer frosted surface for subtle controls/shell areas
- `.liquid-glass-hero` — enhanced high-emphasis glass surface for spotlight widgets
- `.liquid-glass-trend-up` / `.liquid-glass-trend-down` — trend-tinted glass variants used for performance semantics

The utilities include a graceful fallback for environments without `backdrop-filter` and automatically adapt in dark mode via `--glass-*` tokens.

Current recipe aligns more closely with Glass UI-style glassmorphism:

- vivid layered gradient canvas behind translucent surfaces (`.liquid-canvas`)
- semitransparent glass panels with brighter top highlight and soft edge border
- moderate blur + saturation for readability-first depth (`blur(10px) saturate(170%)`)

Applied defaults:

- `Card` root uses standard app surface (`bg-card`) and does not force glass globally ([[apps/frontend/src/components/ui/card.tsx\|card.tsx]])
- `Button` `outline` and `secondary` variants use `.liquid-glass-soft` ([[apps/frontend/src/components/ui/button.tsx\|button.tsx]])
- Overlay content surfaces (`Dialog`, `Sheet`, `Popover`, `DropdownMenu`) use `.liquid-glass`
  ([[apps/frontend/src/components/ui/dialog.tsx\|dialog.tsx]], [[apps/frontend/src/components/ui/sheet.tsx\|sheet.tsx]], [[apps/frontend/src/components/ui/popover.tsx\|popover.tsx]], [[apps/frontend/src/components/ui/dropdown-menu.tsx\|dropdown-menu.tsx]])

Overlay positioning safety:

- shared glass utilities no longer force `position: relative`, preventing conflicts with Radix overlays that require `fixed` positioning
- `Dialog` and `Sheet` content explicitly use `!fixed` to guarantee modal visibility with backdrop

Hero usage:

- Dashboard stat cards use `.liquid-glass-hero` for stronger foreground hierarchy
  ([[apps/frontend/src/components/dashboard/StatCard.tsx\|StatCard.tsx]])

Selective summary-card usage:

- summary cards in Statistics, Planned Payments, Portfolio Overview, Net Worth, and investment pages (Stocks/Crypto/Real Estate/Savings, including Metals via Stocks reuse) now use `.liquid-glass` with subtle `micro-lift`
- Performance metric cards use `.liquid-glass` plus trend tints (`.liquid-glass-trend-up` / `.liquid-glass-trend-down`) to preserve green/red semantics

Code links: [[apps/frontend/src/pages/StatisticsPage.tsx]], [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]], [[apps/frontend/src/pages/portfolio/NetWorthPage.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/pages/portfolio/StocksPage.tsx]], [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]], [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]], [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]]

Minimal motion and premium polish utilities:

- `.micro-lift` for very small hover elevation
- `.press-feedback` for subtle click/tap compression
- `.premium-icon-action` for premium icon-button hover/focus polish in chrome controls
- `.premium-frame` for non-glass cards that still need elevated premium depth
- `liquid-canvas` uses a low-amplitude ambient drift animation with `prefers-reduced-motion` fallback

Shared table shells (`DataTable`, `VirtualDataTable`) now favor `premium-frame` + `micro-lift` (non-glass) for cleaner density and readability.

Code links: [[apps/frontend/src/index.css]], [[apps/frontend/src/components/ui/button.tsx]], [[apps/frontend/src/components/layout/AppLayout.tsx]]

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
| Toast | Temporary notification | [[apps/frontend/src/components/ui/toast.tsx\|toast.tsx]] |
| Sonner | Toast notification system | [[apps/frontend/src/components/ui/sonner.tsx\|sonner.tsx]] |
| Progress | Progress bar | [[apps/frontend/src/components/ui/progress.tsx\|progress.tsx]] |
| Skeleton | Loading placeholder | [[apps/frontend/src/components/ui/skeleton.tsx\|skeleton.tsx]] |

### Layout

| Component | Description | File |
|-----------|-------------|------|
| Card | Content container | [[apps/frontend/src/components/ui/card.tsx\|card.tsx]] |
| Sheet | Side drawer panel | [[apps/frontend/src/components/ui/sheet.tsx\|sheet.tsx]] |
| Drawer | Bottom/side drawer | [[apps/frontend/src/components/ui/drawer.tsx\|drawer.tsx]] |
| Separator | Visual divider | [[apps/frontend/src/components/ui/separator.tsx\|separator.tsx]] |
| Accordion | Collapsible sections | [[apps/frontend/src/components/ui/accordion.tsx\|accordion.tsx]] |
| Collapsible | Collapsible content | [[apps/frontend/src/components/ui/collapsible.tsx\|collapsible.tsx]] |
| Resizable | Resizable panel | [[apps/frontend/src/components/ui/resizable.tsx\|resizable.tsx]] |
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
| Chart | Base chart component | [[apps/frontend/src/components/ui/chart.tsx\|chart.tsx]] |

### Utilities

| Component | Description | File |
|-----------|-------------|------|
| Pagination | Page navigation | [[apps/frontend/src/components/ui/pagination.tsx\|pagination.tsx]] |
| ScrollArea | Scrollable container | [[apps/frontend/src/components/ui/scroll-area.tsx\|scroll-area.tsx]] |
| Calendar | Date picker calendar | [[apps/frontend/src/components/ui/calendar.tsx\|calendar.tsx]] |
| Toggle | Binary toggle | [[apps/frontend/src/components/ui/toggle.tsx\|toggle.tsx]] |
| ToggleGroup | Toggle button group | [[apps/frontend/src/components/ui/toggle-group.tsx\|toggle-group.tsx]] |
| InputOTP | One-time password input | [[apps/frontend/src/components/ui/input-otp.tsx\|input-otp.tsx]] |
| Carousel | Carousel/slider | [[apps/frontend/src/components/ui/carousel.tsx\|carousel.tsx]] |

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

Code links: [[apps/frontend/src/components/ui/chart.tsx]], [[apps/frontend/src/utils/currency.ts]], [[apps/frontend/src/pages/StatisticsPage.tsx]]
