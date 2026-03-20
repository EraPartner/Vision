---
title: Architecture Decision Records Index
type: adr-index
---

# Architecture Decision Records

An ADR (Architecture Decision Record) documents a significant architectural decision along with its context and consequences.

## All ADRs

```dataview
TABLE status, date, title
FROM "docs/adr"
WHERE !contains(title, "template")
SORT date DESC
```

## Active Decisions

```dataview
LIST
FROM "docs/adr"
WHERE status = "Accepted"
SORT date DESC
```

## Creating a New ADR

See [[docs/adr/template|the ADR template]] for the format to use when creating a new decision record.
