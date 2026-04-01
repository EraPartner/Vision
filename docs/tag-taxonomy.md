---
title: Tag Taxonomy
type: reference
status: active
date: 2026-03-31
tags: [tags, taxonomy, reference, organization]
description: Controlled vocabulary of tags used across the Vision knowledge base for consistent filtering and search
aliases: [tag guide, tagging, categories, labels]
---

# Tag Taxonomy

> [!abstract] Purpose
> This document defines the controlled vocabulary of tags used across the Vision knowledge base. Use these tags when creating or updating documentation to ensure consistent filtering via `get_tags` and `search_by_tag`.

## Tag Categories

### Content Type (use exactly one)

| Tag | Use For |
|-----|---------|
| `index` | Index/overview pages |
| `endpoint` | API endpoint documentation |
| `feature` | Feature documentation |
| `integration` | External service integration docs |
| `performance` | Performance optimization docs |
| `testing` | Testing documentation |
| `guide` | How-to guides |
| `adr` | Architecture Decision Records |
| `component` | Frontend component documentation |
| `architecture` | Architecture documentation |
| `i18n` | Localization documentation |
| `security` | Security documentation |
| `reference` | Reference docs (glossary, tag taxonomy) |
| `map-of-content` | Maps of Content (MOCs) |

### Domain (use 1-3)

| Tag | Use For |
|-----|---------|
| `api` | Anything API-related |
| `frontend` | Frontend React code |
| `backend` | Backend Node.js code |
| `database` | Database schema, migrations, queries |
| `portfolio` | Investment/portfolio features |
| `transactions` | Transaction management |
| `import` | CSV import functionality |
| `charts` | Chart/visualization components |
| `hooks` | React custom hooks |
| `ui` | UI components |
| `security` | Security-related content |
| `i18n` | Internationalization |
| `tax` | Belgian tax features |
| `splits` | Transaction splitting |
| `planned` | Planned/recurring transactions |
| `settings` | User settings |
| `analytics` | Statistics and reporting |

### Technology (use 0-3)

| Tag | Use For |
|-----|---------|
| `react` | React-specific content |
| `typescript` | TypeScript-specific content |
| `postgresql` | PostgreSQL-specific content |
| `plantuml` | PlantUML diagrams |
| `alembic` | Alembic migrations |
| `vitest` | Vitest testing |
| `react-query` | React Query data fetching |
| `tailwind` | Tailwind CSS styling |
| `electron` | Electron desktop |
| `docker` | Docker deployment |

### Status (use exactly one, from frontmatter)

| Status | Meaning |
|--------|---------|
| `active` | Current and maintained |
| `draft` | Work in progress |
| `deprecated` | Outdated, being replaced |
| `template` | Template for new docs |

## Tagging Rules

1. **Every doc must have**: `title`, `type`, `status`, `date`, `tags`, `description`
2. **Use singular form**: `feature` not `features`, `guide` not `guides`
3. **Be specific but not excessive**: 3-6 tags per document is ideal
4. **No orphan tags**: Every tag should appear in at least 2 documents
5. **No technology jargon as tags**: Use `react` not `react-18`, use `postgresql` not `postgres-15`

## Examples

### API Endpoint Doc
```yaml
tags: [endpoint, api, transactions, backend]
```

### Feature Doc
```yaml
tags: [feature, portfolio, investments, frontend, backend]
```

### Component Doc
```yaml
tags: [component, frontend, ui, hooks]
```

### Guide
```yaml
tags: [guide, setup, development, database]
```

### ADR
```yaml
tags: [adr, architecture, database, postgresql]
```

## Deprecated Tags (Do Not Use)

| Old Tag | Replacement | Reason |
|---------|-------------|--------|
| `jest` | `vitest` | Project uses Vitest exclusively |
| `features` | `feature` | Singular convention |
| `guides` | `guide` | Singular convention |
| `integrations` | `integration` | Singular convention |
| `coingecko` | `binance` | Provider replaced |
| `kraken` | `binance` | Provider replaced |

## Related

- [[docs/glossary\|Glossary]] - Key terms and disambiguation
- [[docs/index\|Knowledge Base Home]] - Main entry point
