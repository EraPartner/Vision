---
title: {Component Name}
type: component
status: active
date: {YYYY-MM-DD}
tags: [component, frontend, react, {domain}]
description: {Brief description of what this component does}
aliases: [component, react, {component-name}]
related_code: ["apps/frontend/src/components/{path}/{Component}.tsx"]
---

# {Component Name}

> [!abstract] Overview
> {One-sentence description of what this component does}

## Component Details

| Property | Value |
|----------|-------|
| **Type** | {Presentation / Container / Compound} |
| **Location** | `apps/frontend/src/components/{path}/{Component}.tsx` |
| **Used By** | {Page/Component that uses this} |

## Props Interface

```typescript
interface {Component}Props {
  // Props here
  className?: string;
}
```

## Usage

### Basic Usage

```tsx
<{Component} />
```

### With Props

```tsx
<{Component}
  prop1="value"
  prop2={42}
/>
```

## States

| State | Description | Visual |
|-------|-------------|--------|
| Default | Normal state | Normal styling |
| Loading | Async data loading | Spinner/skeleton |
| Error | Error state | Error message |
| Empty | No data | Empty state message |

## Behavior

### Events Handled

| Event | Handler | Description |
|-------|---------|-------------|
| `onClick` | `{Component}Props.onClick` | Click handler |
| `onChange` | `{Component}Props.onChange` | Change handler |

### Edge Cases

- {Edge case 1} — How it's handled
- {Edge case 2} — How it's handled

## Related

- [[docs/components/index|Components Index]]
- [[docs/features/{feature}|{Feature}]]
- [[docs/api/{endpoint}|API {Endpoint}]]