# ADR-001: Standardised Repository Contract

Date: 2026-02-05

## Status

Accepted

## Context

Recipients and categories had slightly divergent repository method names and filter semantics, which led to friction
when implementing uniform list, count, and pagination behaviours at the API layer. In a financial domain, consistency
aids auditability, testability, and predictable API responses.

## Decision

Introduce a minimal abstract base class `BaseRepository` that defines a uniform contract for repositories:

- `get_by_id(id)`
- `create(entity)`
- `update(entity)`
- `soft_delete(entity)`
- `hard_delete(entity)`
- `list_active(limit, offset, active=True, **filters)`
- `get_total_count(active=True)`
- `get_filtered_count(active=True, **filters)`

Additionally, add a `list_active(...)` delegating alias to the `RecipientRepository` to standardise naming without
breaking existing code paths that use `get_all_active(...)`.

### Conventions

- Filters accepted by `list_active` MUST be mirrored by `get_filtered_count`.
- Apply `active=True` filtering consistently; `active=False` returns both active and inactive.
- Use deterministic ordering to ensure stable pagination (prefer `id ASC` unless business dictates otherwise).
- Log operations with a consistent JSON structure including: `operation`, `resource_type`, `resource_id` (if
  applicable), `filters`, `limit`, `offset`, and `count/total`.

## Alternatives Considered

- Generics-heavy base with type parameters: adds complexity without clear benefits at current scale.
- Mixins for soft-delete/pagination only: partial solution, does not enforce method names.
- Status quo: leaves room for drift and inconsistent API behaviour.

## Consequences

- Improved uniformity between repositories, simpler service layer and API code.
- Easier to write and run tests across resources.
- Minor additional maintenance to keep method signatures aligned.

## Implementation Notes

- `BaseRepository` added in `repositories/base_repository.py`.
- `RecipientRepository` gains `list_active(...)` alias delegating to existing `get_all_active(...)` with aligned
  logging.
- Category repository should be aligned next to implement the same contract.

## Audit and Compliance

This change supports consistent audit logging across repositories and predictable behaviour required for financial
systems. British English is used throughout documentation as per project standards.
