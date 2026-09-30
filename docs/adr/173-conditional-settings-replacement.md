---
title: "ADR-173: Conditional settings replacement"
type: adr
status: accepted
date: 2026-09-30
tags: [adr, settings, concurrency]
description: Whole-value settings replacements compare the persisted baseline and reject stale saves without merging arbitrary JSON.
---

# ADR-173: Conditional settings replacement

## Context

Browser hydration saves complete settings values. Two tabs can load the same object and
silently overwrite each other's fields. Settings also contain nested values, arrays and
optional fields, so an implicit JSON merge would make removal and replacement ambiguous.

## Decision

Public PUT and DELETE operations require the persisted baseline from the read that produced
the edit: `{ exists: false }` for absence, or `{ exists: true, value: ... }` for a stored value.
JSON null is a stored value. Single-key reads return `expected` separately from display defaults.
`GET /api/settings?withBaselines=true` returns `settings` and `expected` maps from one query;
legacy JSON strings are revived for display but baselines keep their exact stored JSON.

The repository compares JSONB atomically in the UPDATE or DELETE predicate. Creation uses
INSERT with ON CONFLICT DO NOTHING. A mismatch returns 409 CONFLICT. A replacement removes
omitted fields and replaces nested objects and arrays in full. No automatic merge occurs.
Bulk PUT accepts `{ settings, expected }`, orders keys, and applies all replacements in one
transaction; any conflict rolls back the whole operation. Content comparison permits a save
when intervening edits restore exactly the same value. It does not provide a monotonic revision.

Each browser tab freezes read baselines, serializes writes per key, and advances a baseline only
on an acknowledged save. A failed or conflicting save blocks later writes to that key until an
application reload. Background reads do not authorize stale local replacements. Failed preload
cannot authorize writing fallback defaults. Conditional saves do not retry uncertain HTTP outcomes.

Electron backup and service preferences use one main-process conditional writer, followed by the
local mirror only after acknowledged database persistence. The renderer awaits and propagates
failure. An offline local mirror does not authorize a database write.

Internal scalar preference commands, one-shot flags and daily-job completion timestamps remain
intentional unconditional repository writes. The transfer repair flag remains insert-only.
The administrative database editor and an explicitly authorized backup restore intentionally
replace database state; their changes invalidate any different browser baseline. There is no
current AI tool that mutates settings. Future read-derived object writers must use conditional
replacement rather than the internal unconditional methods.

## Consequences

The mutation API is breaking: old requests without baselines receive 400. Stale saves receive
409 and require reload. The UI can show an unsaved local choice until reload; it must not report
persistence success. First-party error handling reports failed saves. Same-tab consumers must
continue deriving their replacements from their shared current state.

No schema migration is needed. Conditional SQL protects against administrative mutations too.
Real concurrency and bulk rollback acceptance require the disposable PostgreSQL suite; portable
mock tests do not establish those database properties.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/api/settings|Settings API]]
- [[docs/features/settings|Settings Feature]]
- [[docs/reference/frontend-api-client|Frontend API Client]]
