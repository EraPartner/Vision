---
title: ADR-109 Flat investments schema is canonical — one-time legacy-install conversion
type: adr
status: accepted
date: 2026-09-04
tags:
  [
    adr,
    database,
    migrations,
    investments,
    portfolio,
    table-inheritance,
    adr-004,
    adr-052,
    accounts,
    schema,
  ]
description: Declares the flat investments/portfolio_transactions shape (what fresh installs get from 0001) the single canonical schema and specifies a guarded one-time conversion migration for legacy inheritance-shape installs (base + 7 children + view), ending runtime shape-probing, conditionally-absent FKs, and the side-table idiom for new columns. Supersedes ADR-004's inheritance decision.
aliases: [flat investments schema, inheritance conversion, adr-109]
---

# ADR-109: Flat investments schema is canonical — one-time legacy-install conversion

## Status

Accepted — 2026-07-10. Supersedes the schema-shape portion of
[[docs/adr/004-postgresql-table-inheritance|ADR-004]].

**Implemented 2026-08-02:** the conversion migration is `0087_flat_investments_conversion`
(in-chain, so it applies on the next boot like every revision — `docker-entrypoint.sh` /
`main.js` run `alembic upgrade head` before the backend listens). Because conversion is
therefore guaranteed before any newer code serves requests, the runtime `to_regclass`
shape-probing and inheritance-aware branching were removed from the backend in the same
change. The renamed `legacy_inh_*` relations remain as the rollback until the operator-gated
`alembic/manual/drop_adr109_legacy_relations/` cleanup runs after a verified logical backup.

## Context

Fresh installs create flat `investments` / `portfolio_transactions` tables
(`0001_initial_database_schema.py`). Legacy installs still carry the ADR-004 shape:
`investments_base` + 7 asset-class child tables + a `portfolio_transactions` view. The cost of
the fork is structural and recurring, not a one-off:

- **Conditionally-absent FKs** — PostgreSQL rejects FK references to views, so on legacy
  installs columns that should be FKs stay plain INTEGERs (`0026`, `0040`, `0052` all carry this
  branch). Most relevantly, `portfolio_transactions.account_id` is unenforced on legacy installs
  — a dangling-account risk that matters directly once per-account holdings go live
  ([[docs/adr/103-per-account-holdings-ui-flag|ADR-103 addendum]], accounts-rewrite Phase E).
- **Runtime shape-probing** — `to_regclass('portfolio_transactions_base')` branches in
  `investmentRepository.js`, `portfolioTxRepo.common.js`, `accountMergeService.js` and ≥11
  backend files total.
- **The side-table idiom** — every new investments column needs the `0061`-style side-table
  workaround on legacy installs.
- **Docs drift** — `docs/reference/data-model.md` documents the inheritance shape as canonical,
  which is exactly what a fresh install does not have (filed separately).

The 2026-07-09 accounts plan review surfaced the fork as a decision the rewrite depends on;
options were (a) one-time conversion or (b) accept the fork forever. **Decision 2026-07-10
(accounts-rewrite round 2): option (a) — convert.**

## Decision

The **flat shape is the single canonical schema**. A guarded, one-time conversion migration
brings legacy installs onto it:

1. Inside one transaction: `CREATE TABLE investments_flat AS SELECT … FROM investments`(view) and
   `portfolio_transactions_flat AS SELECT … FROM portfolio_transactions`(view), with column
   definitions matching `0001`'s flat DDL exactly (types, defaults, NOT NULLs).
2. Recreate constraints and indexes to the `0001` names — including the real FKs the view shape
   could never hold (`portfolio_transactions.account_id → accounts(id) ON DELETE RESTRICT`,
   staging-table references from `0040`, tag/link references from `0026`/`0052`).
3. Swap names (view + children renamed aside, flat tables take the canonical names), reattach
   triggers, refresh dependent MVs.
4. Keep the old base/child tables **renamed in place** (e.g. `legacy_inh_*`) rather than dropped
   — they are the rollback: reverse the renames to restore the pre-conversion state. A later
   housekeeping revision may drop them once the conversion has soaked.
5. The migration is a no-op on installs that are already flat (`to_regclass` guard — the last
   time that probe should ever be needed in a migration).
6. **Pre-flight parity check** (same discipline as the ADR-088 contract runbook): row counts and
   a checksum over id + money columns must match between view and flat copy before the swap
   commits; any mismatch aborts the transaction.

After conversion ships and soaks:

- Remove the `to_regclass` shape-probing branches from the backend (≥11 files) and
  `accountMergeService`'s dual UPDATE targets.
- New investments columns are ordinary `ALTER TABLE` — the side-table idiom retires.
- `data-model.md` documents the flat shape as primary with a short legacy-conversion appendix.

## Consequences

**Positive**

- One schema everywhere: FKs enforceable on all installs (including `account_id` on lots before
  the ADR-103 flip), migrations stop branching, an entire class of workarounds retires.
- The unenforced-FK risk to per-account holdings (accounts-rewrite Phase E) is closed at the
  root instead of being revalidated per feature.

**Negative / cost**

- A data-copying migration on legacy installs — the heaviest migration this project has shipped.
  It lives in the auto-applied chain, so it runs **unattended at boot** (docker-entrypoint /
  main.js run `alembic upgrade head` before the backend listens) — there is no operator in the
  loop. The real mitigations are therefore in the migration itself: shape + data pre-flights and
  the parity check abort the whole transaction on anything unexpected, leaving the database
  untouched at 0086 with the legacy view still working; the renamed `legacy_inh_*` relations are
  the rollback (`downgrade()` reverses the renames). The deliberate trade: an aborted conversion
  means the app **does not boot** until the pre-flight's listed rows are fixed (each error names
  the offending rows and the fix) — refusing loudly beats guessing or truncating portfolio data.
- Disk briefly doubles for the copied tables until the legacy renames are dropped.

## Housekeeping (2026-09-04)

The soak-period cleanup is deliberately not an auto-applied revision. The manual script verifies
the canonical relations are flat tables and requires an explicit verified-backup acknowledgement
before dropping the old views, inheritance tables, snapshots, indexes, constraints, and inert
foreign keys. Because those relations contain the only rename-based downgrade state, rollback is a
logical restore from that backup; no empty-table reconstruction is presented as recovery. The
rollback copies are outside the head-schema backup coverage registry, but the required full
`pg_dump` captures them before removal.

**Neutral**

- Fresh installs are untouched (guard no-ops).
- ADR-004 remains as history; its Status should be updated to "Superseded by ADR-109".

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/004-postgresql-table-inheritance|ADR-004: PostgreSQL table inheritance]] (superseded)
- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]] · [[docs/adr/091-per-account-positioning|ADR-091]] (carriers of the conditional-FK branch)
- [[docs/adr/103-per-account-holdings-ui-flag|ADR-103 addendum]] (Phase E depends on the enforced `account_id`)
- [[docs/reference/data-model|Data Model Reference]] (to be updated post-conversion)
