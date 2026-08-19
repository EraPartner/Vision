---
title: ADR-111 Complete legacy investment delete cascades during flat-schema conversion
type: adr
status: accepted
date: 2026-08-19
tags: [adr, database, migrations, investments, portfolio, data-repair, rollback, adr-109]
description: Completes the cascade left unenforced by the legacy inheritance schema by omitting orphan portfolio transactions from migration 0087's flat copy, warning with their IDs, and retaining the original rows in the rollback tables.
aliases: [legacy investment delete cascades, ADR-109 orphan transaction repair]
---

# ADR-111: Complete legacy investment delete cascades during flat-schema conversion

## Status

Accepted — 2026-08-19. This supersedes only ADR-109's decision to abort conversion when a legacy
portfolio transaction references an investment that no longer exists. The rest of
[[docs/adr/109-flat-investments-schema-canonical|ADR-109]] remains unchanged.

## Context

The legacy inheritance schema could not enforce
`portfolio_transactions.investment_id → investments(id)`. Its investment delete path removed a
row through `investments_base`, including the asset-class child row, but did not remove matching
rows from the separate transaction child tables. A successful delete through Vision could
therefore leave portfolio transactions whose investment was gone.

Migration `0087_flat_investments_conversion` originally classified every such row as unknown
corruption and aborted. That safeguard prevents the app from starting even though this state is a
predictable result of the former application path. The canonical flat schema already defines the
intended behavior with `ON DELETE CASCADE`.

The deleted investment's asset class, name, and other metadata no longer exist, so creating a
placeholder would invent user data. Removing the source rows before conversion would also weaken
the rename-based rollback.

## Decision

Migration 0087 completes the cascade that the legacy schema could not enforce:

1. Identify portfolio transactions whose `investment_id` is absent from the legacy investments
   view.
2. Emit a migration warning listing the omitted transaction IDs.
3. Copy only transactions with a surviving investment into the canonical flat table.
4. Run the transaction parity count and hash against that same valid subset.
5. Keep every original row, including the orphans, in the renamed `legacy_inh_*` inheritance
   relations. A downgrade restores them with the rest of the legacy shape.
6. Preserve the legacy sequence high-water mark so an omitted transaction ID is not reused.

The new flat foreign key then enforces `ON DELETE CASCADE` for every future investment deletion.

## Consequences

**Positive**

- Legacy installs no longer boot-loop on residue created by Vision's own former delete path.
- The converted database matches the delete semantics of a fresh flat-schema install.
- No placeholder investment or guessed asset metadata is created.
- Rollback retains the exact legacy rows for inspection or recovery.

**Negative**

- Orphan transactions are not present in the canonical table after upgrade. They were already
  detached from any existing investment, and the migration warning makes the cleanup explicit.
- A later migration that drops the `legacy_inh_*` rollback tables will make that omission
  permanent and must account for the same blast radius.

**Neutral**

- Other ADR-109 data guards still abort on shapes that require guessing or truncation.
- Flat installs remain a strict no-op.

## Rollback

Downgrading to `0086_portfolio_transactions_import_batch_id` drops the converted flat tables and
restores the renamed inheritance relations. The omitted orphan transactions therefore reappear in
the legacy `portfolio_transactions` view. As before, rows written after conversion are lost by a
downgrade.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/109-flat-investments-schema-canonical|ADR-109: Flat investments schema is canonical]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/troubleshooting#ADR-109 conversion reports transactions for missing investments|Troubleshooting the ADR-109 conversion]]
- [[docs/features/portfolio|Portfolio Feature]]
