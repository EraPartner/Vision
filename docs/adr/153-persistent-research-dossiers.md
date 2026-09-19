---
title: ADR-153 - Persistent Research Dossiers
type: adr
status: Accepted
date: 2026-09-19
tags: [adr, research, dossiers, evidence, provenance, persistence]
description: Keep authored research, citation snapshots, linked records, and conclusions in local versioned dossiers.
aliases: [durable research dossiers, dossier persistence]
---

# ADR-153: Persistent Research Dossiers

## Context

Saved analyses preserve reusable calculations, while investigations and research documents preserve
their own runs and extracted passages. None is a durable, editable place for a user's thesis,
assumptions, conflicting evidence, open questions, and conclusion. A dossier must survive source
deletion without silently claiming that an old citation or link is still live.

## Decision

Migration 0115 adds a local `research_dossiers` current record, append-only
`research_dossier_versions` snapshots, and foreign-keyed `research_dossier_links`. Each create
starts at version 1. Every edit or restore requires `expectedVersion`, appends a new snapshot, and
leaves earlier versions immutable. Delete removes the dossier and all its versions; users can first
export one or all dossiers with complete version history. The export is JSON schema version 1;
there is no import endpoint.

A dossier contains a workspace, research question, user thesis, assumptions, open questions,
conclusion, optional review date, and up to 30 evidence entries. Evidence records a claim, stance,
origin (`user` or `ai-draft`), notes, and a citation snapshot with title and reference. An AI-draft
label is provenance, not approval: no provider output is automatically promoted to the user's
thesis or conclusion. The dossier service itself sends no content to a provider.

Optional document provenance is checked when first saved. The service pins the current document
version and SHA-256 content digest, and can check a passage ordinal. An unchanged citation may be
retained if the source document is later deleted or re-extracted. A changed citation must match a
currently available source. This is a snapshot, not an automatically refreshed source claim.

Links to category nodes, investments, and saved analyses use foreign keys in the current link
table. It also stores the target's historical ID and display label. A deleted target clears only
the live foreign key; the historical label remains as an unavailable link. The API separates live
IDs from `linkDetails` with `live` or `deleted` status. Category merges can repoint the live link
to the surviving category without rewriting immutable dossier versions. Restoring an old snapshot
must resolve its links against current records or report an error; it cannot silently resurrect a
deleted target.

All three tables are registered in backup coverage. The downgrade refuses while any dossier
exists; an operator must export and remove dossier data before rolling back this migration.

## Consequences

- Research context is durable and locally owned, but large collections make complete JSON export
  more expensive than a paged list.
- Historical versions and citation snapshots record what was written, not whether an old source
  remains available or true. Link status must remain visible to the reader.
- Explicit edits and restore provide an audit trail without mixing an AI draft with the user's
  conclusion. Deleting a dossier is still destructive and also removes its history.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/research-dossiers|Research Dossiers]]
- [[docs/api/research-dossiers|Research Dossiers API]]
- [[docs/reference/data-model|Data Model]]
- [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]]
