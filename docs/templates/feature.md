---
title: {Feature Name}
type: feature
status: active
date: {YYYY-MM-DD}
tags: [feature, {domain}, frontend, backend]
description: {Brief description of the feature}
aliases: [feature, {feature-name}]
related_code: ["apps/frontend/src/pages/{page-folder}/", "apps/node-backend/src/services/{service}.js"]
---

# {Feature Name}

> [!abstract] Overview
> {One-sentence description of what this feature does and why it exists}

## Feature Overview

### User Story

> As a {user type}, I want to {goal} so that {benefit}

### Key Capabilities

- {Capability 1}
- {Capability 2}
- {Capability 3}

## Architecture

```
{Flow diagram description}
```

### Components Involved

| Component | Type | Description |
|-----------|------|-------------|
| `{Component}` | Frontend Page | {Description} |
| `{Component}` | Frontend Hook | {Description} |
| `{Component}` | API Endpoint | {Description} |
| `{Component}` | Backend Service | {Description} |

## Data Model

### Database Tables

- `{table_name}` — {Description}

### API Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/{resource}` | GET, POST | List and create |
| `/api/{resource}/:id` | GET, PATCH, DELETE | Read, update, delete |

## User Interface

### Screens

1. **Main View** — {Description of main screen}
2. **Detail/Edit View** — {Description of detail screen}

### Interactions

| Action | Trigger | Result |
|--------|---------|--------|
| {Action} | {Trigger} | {Result} |

## Configuration

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `{setting}` | string | default | {Description} |

### Environment Variables

- `{ENV_VAR}` — {Description}

## Edge Cases

- {Edge case 1} — How it's handled
- {Edge case 2} — How it's handled

## Related

- [[docs/api/{endpoint}|{Endpoint} API]]
- [[docs/components/{component}|{Component} Component]]
- [[docs/guides/{guide}|{Guide} Guide]]