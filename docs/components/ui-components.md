---
title: UI Components
type: component
status: active
date: 2026-03-23
tags: [components, ui, radix, shadcn]
description: Reusable UI components built on Radix UI primitives with Tailwind CSS
related_code: ["apps/frontend/src/components/ui"]
---

# UI Components

Vision uses a comprehensive set of UI components built on [Radix UI](https://radix-ui.com) primitives, styled with Tailwind CSS, and using [class-variance-authority](https://cva.style) for variant management.

## Overview

All UI components are located in `apps/frontend/src/components/ui/` and are based on [shadcn/ui](https://ui.shadcn.com) design patterns.

## Component List

### Actions

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/button|Button]] | Versatile button with multiple variants | `button.tsx` |
| [[docs/components/button|IconButton]] | Square icon-only button | `button.tsx` |
| [[docs/components/command|Command]] | Searchable command menu | `command.tsx` |

### Forms

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/input|Input]] | Text input field | `input.tsx` |
| [[docs/components/textarea|Textarea]] | Multi-line text input | `textarea.tsx` |
| [[docs/components/select|Select]] | Dropdown select | `select.tsx` |
| [[docs/components/checkbox|Checkbox]] | Binary checkbox | `checkbox.tsx` |
| [[docs/components/radio-group|RadioGroup]] | Radio button group | `radio-group.tsx` |
| [[docs/components/switch|Switch]] | Toggle switch | `switch.tsx` |
| [[docs/components/slider|Slider]] | Range slider | `slider.tsx` |
| [[docs/components/label|Label]] | Form label | `label.tsx` |
| [[docs/components/form|Form]] | Form wrapper with validation | `form.tsx` |

### Feedback

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/alert|Alert]] | Alert message box | `alert.tsx` |
| [[docs/components/alert-dialog|AlertDialog]] | Confirmation dialog | `alert-dialog.tsx` |
| [[docs/components/toast|Toast]] | Temporary notification | `toast.tsx` |
| [[docs/components/sonner|Sonner]] | Toast notification system | `sonner.tsx` |
| [[docs/components/progress|Progress]] | Progress bar | `progress.tsx` |
| [[docs/components/skeleton|Skeleton]] | Loading placeholder | `skeleton.tsx` |

### Layout

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/card|Card]] | Content container | `card.tsx` |
| [[docs/components/sheet|Sheet]] | Side drawer panel | `sheet.tsx` |
| [[docs/components/drawer|Drawer]] | Bottom/side drawer | `drawer.tsx` |
| [[docs/components/separator|Separator]] | Visual divider | `separator.tsx` |
| [[docs/components/accordion|Accordion]] | Collapsible sections | `accordion.tsx` |
| [[docs/components/collapsible|Collapsible]] | Collapsible content | `collapsible.tsx` |
| [[docs/components/resizable|Resizable]] | Resizable panel | `resizable.tsx` |
| [[docs/components/aspect-ratio|AspectRatio]] | Fixed aspect ratio | `aspect-ratio.tsx` |

### Navigation

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/sidebar|Sidebar]] | Collapsible sidebar | `sidebar.tsx` |
| [[docs/components/tabs|Tabs]] | Tabbed content | `tabs.tsx` |
| [[docs/components/navigation-menu|NavigationMenu]] | Navigation menu | `navigation-menu.tsx` |
| [[docs/components/breadcrumb|Breadcrumb]] | Breadcrumb trail | `breadcrumb.tsx` |
| [[docs/components/dropdown-menu|DropdownMenu]] | Dropdown menu | `dropdown-menu.tsx` |
| [[docs/components/context-menu|ContextMenu]] | Right-click menu | `context-menu.tsx` |
| [[docs/components/menubar|MenuBar]] | Menu bar | `menubar.tsx` |

### Data Display

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/table|Table]] | Data table | `table.tsx` |
| [[docs/components/badge|Badge]] | Status badge | `badge.tsx` |
| [[docs/components/avatar|Avatar]] | User avatar | `avatar.tsx` |
| [[docs/components/hover-card|HoverCard]] | Popup info card | `hover-card.tsx` |
| [[docs/components/tooltip|Tooltip]] | Hover tooltip | `tooltip.tsx` |
| [[docs/components/popover|Popover]] | Popup content | `popover.tsx` |

### Charts

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/chart|Chart]] | Base chart component | `chart.tsx` |

### Utilities

| Component | Description | File |
|-----------|-------------|------|
| [[docs/components/pagination|Pagination]] | Page navigation | `pagination.tsx` |
| [[docs/components/scroll-area|ScrollArea]] | Scrollable container | `scroll-area.tsx` |
| [[docs/components/calendar|Calendar]] | Date picker calendar | `calendar.tsx` |
| [[docs/components/toggle|Toggle]] | Binary toggle | `toggle.tsx` |
| [[docs/components/toggle-group|ToggleGroup]] | Toggle button group | `toggle-group.tsx` |
| [[docs/components/input-otp|InputOTP]] | One-time password input | `input-otp.tsx` |
| [[docs/components/radio-group|Carousel]] | Carousel/slider | `carousel.tsx` |

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
