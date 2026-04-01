---
title: Architecture Decision Records Index
type: adr-index
status: active
date: 2026-03-31
tags: [adr, index, architecture, decisions]
description: Architecture Decision Records documenting significant technical choices and their rationale
aliases: [ADRs, decisions, architecture decisions]
---

# Architecture Decision Records

> [!abstract] What is an ADR?
> An ADR (Architecture Decision Record) documents a significant architectural decision along with its context, consequences, and status. Use these to understand **why** the system is built the way it is.

## All ADRs

```dataview
TABLE WITHOUT FILE status AS "Status", date AS "Date", description AS "Summary"
FROM "docs/adr"
WHERE !contains(file.name, "template") AND type = "adr"
SORT date DESC
```

## Active Decisions

```dataview
LIST WITHOUT FILE
FROM "docs/adr"
WHERE status = "Accepted"
SORT date DESC
```

## Creating a New ADR

See [[docs/adr/template\|the ADR template]] for the format to use when creating a new decision record.

> [!tip] When to Create an ADR
> - Choosing a new technology or framework
> - Changing a fundamental architectural pattern
> - Documenting a significant bug fix with architectural implications
> - Recording a decision that affects multiple parts of the system

## Related Documentation

- [[docs/architecture/index\|Architecture Overview]] - System diagrams
- [[docs/adr/002-database-schema\|Database Schema]] - Current schema design
- [[docs/guides/migrations\|Migration Guide]] - How schema changes are managed
