---
title: Reference Documentation Index
type: reference-index
status: active
date: 2026-04-21
tags: [reference, index, code-patterns, types, algorithms, phase-1]
description: Index of all reference documentation — code patterns, types, algorithms, environment variables, and more
aliases: [reference docs, reference index, code reference]
---

# Reference Documentation

> [!abstract] Overview
> Technical reference material for Vision. These documents provide detailed specifications, patterns, and data that developers and AI agents need when working with the codebase.

## All References

```dataview
TABLE WITHOUT FILE title AS "Reference", description AS "Description", date AS "Updated"
FROM "docs/reference"
WHERE type = "reference"
SORT title ASC
```

## Code & Architecture

| Document | Description |
|----------|-------------|
| [[docs/reference/data-model\|Data Model]] | Complete entity reference — core, portfolio, planning, supporting |
| [[docs/reference/code-patterns\|Code Patterns]] | Standard patterns for all layers (routes, services, repositories, components) |
| [[docs/reference/service-layer\|Service Layer Reference]] | Complete reference for all 16 backend services |
| [[docs/reference/repository-layer\|Repository Layer Reference]] | Complete reference for all 13 backend repositories |
| [[docs/reference/database-query-patterns\|Database Query Patterns]] | PostgreSQL query patterns, index strategies, optimization techniques |
| [[docs/reference/frontend-routes\|Frontend Routes]] | Complete route table for all 23 pages |
| [[docs/reference/react-query-keys\|React Query Keys]] | All frontend query keys for cache invalidation |
| [[docs/reference/typescript-types\|TypeScript Types]] | All frontend type definitions |
| [[docs/reference/agent-navigation-map\|AI Agent Navigation Map]] | File navigation map organized by feature, layer, and task |
| [[docs/reference/frontend-api-client\|Frontend API Client Architecture]] | Transport, types, and facade layers of the HTTP client (Phase 1 refactor) |
| [[docs/reference/schema-initialization\|Schema Initialization (Archived)]] | Legacy schema initialization reference — replaced by Alembic |

## Algorithms & Computer Science

| Document | Description |
|----------|-------------|
| [[docs/reference/algorithms\|Algorithms & Data Structures]] | LTTB, SHA-256 dedup, recurring detection, currency conversion, Modified Dietz |

## Database

| Document | Description |
|----------|-------------|
| [[docs/reference/database-triggers\|Database Triggers]] | All PostgreSQL triggers |
| [[docs/reference/migration-dependencies\|Migration Dependencies]] | Migration chain and groups |

## Configuration

| Document | Description |
|----------|-------------|
| [[docs/reference/environment-variables|Environment Variables]] | All env vars for frontend and backend |
| [[docs/reference/scripts|Scripts Reference]] | All bun/npm commands |
| [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]] | Complete matrix of all 108 API endpoints |

## Error Handling

| Document | Description |
|----------|-------------|
| [[docs/reference/error-codes\|Error Codes]] | All API error responses and status codes |
| [[docs/guides/debugging\|Debugging Guide]] | Error handling patterns, debugging techniques, common failure modes |

## Related Documentation

- [[docs/architecture/index\|Architecture Diagrams]]
- [[docs/api/index\|API Documentation]]
- [[docs/components/index\|Components]]
- [[docs/testing/index\|Testing]]
