---
title: Hook Template
type: component
status: template
date: 2026-04-02
tags: [component, template, hooks, react]
description: Template for documenting React custom hooks
aliases: [hook template]
---

# Hook Template

> [!abstract] Overview
> Copy this template to document a new React custom hook

## Hook Details

| Property | Value |
|----------|-------|
| **Name** | `use{Resource}` |
| **Location** | `apps/frontend/src/hooks/use{Resource}.ts` |
| **Used By** | {Page/Component} |

## Function Signature

```typescript
export function use{Resource}(params?: { /* params */ }) {
  // Hook implementation
}
```

## API

### Query Hooks

```typescript
// List query
use{Resource}({ limit: 50, offset: 0 })

// Single query  
use{Resource}(id: number)
```

### Mutation Hooks

```typescript
// Create
useCreate{Resource}()

// Update
useUpdate{Resource}()

// Delete
useDelete{Resource}()
```

## Query Key

```typescript
['resources', params]  // list
['resources', id]      // single
```

## Related

- [[docs/components/index|Components Index]]
- [[docs/api/{endpoint}|{Endpoint} API]]
- [[docs/reference/react-query-keys|React Query Keys]]