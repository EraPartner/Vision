---
title: ADR-206 Bank chronology for balance anchors
type: adr
status: accepted
date: 2026-10-11
tags: [adr, accounts, imports, balances, chronology]
description: Preserve bank ordering independently of insertion order when selecting same-day balance anchors.
---

# ADR-206: Bank chronology for balance anchors

## Context

Belfius exports can arrive newest-first, and later imports can add older rows on the same day.
Choosing the largest database ID as the closing balance can therefore select an earlier bank
balance. Editable comments and insertion order do not establish bank chronology.

## Decision

Migration `0127_bank_chronology` adds nullable nonnegative `NUMERIC(18,0)` bank sequence metadata
to staging and posted transactions. The Belfius adapter retains its two sequence components as
one ordered value. Staging and commit preserve it. Shared balance SQL uses date, bank sequence,
and ID consistently for anchors, provenance and running balances.

Within a day, rows without bank sequence follow sequenced rows and retain insertion ordering.
This makes manual same-day activity a post-statement delta. It is a deterministic fallback,
not a claim that unknown historical chronology has been recovered.

Historical backfill uses retained Belfius raw records with a source hash, matching batch, date,
amount and currency. It does not infer sequence from editable comments. An expression index
supports active account/currency/date ordering. Public write contracts do not accept this metadata.

## Consequences and rollback

Imported balances and amounts are unchanged; selection of the correct same-day anchor changes.
Unknown chronology remains explicitly unresolved. The migration scans eligible archived staging
records and adds an index, so upgrade time depends on the retained history.

Downgrade drops the index and sequence columns, reverting to insertion-order behavior. It loses
ordering metadata but preserves financial rows and archived source records. Upgrade and downgrade
have been reviewed, not executed in this session: disposable PostgreSQL startup is blocked by
shared-memory permissions. Neither has been applied to user data. Parser checks passed; database
chronology and migration fidelity checks remain open in [[TODO]].

## Related

- [[docs/adr/index|Architecture decisions]]
- [[docs/reference/data-model|Data model]]
- [[docs/features/accounts|Account balances]]
- [[docs/features/import|Bank imports]]
