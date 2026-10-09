---
title: Research Dossiers
type: feature
status: active
date: 2026-10-09
tags: [feature, research, dossiers, evidence, provenance, analysis]
description: Local versioned research records for questions, thesis, evidence, conclusions, and linked financial context.
aliases: [dossier workspace, research dossier library]
---

# Research Dossiers

Research Dossiers at `/research/dossiers` keep a long-lived account of one question. The user can
write a thesis, assumptions, open questions, dated review target, conclusion, and evidence on both
sides. A dossier belongs to one of the budgeting, portfolio, research, or cross-workspace contexts.
It can link current categories, investments, and saved analyses. Evidence has an explicit
`user` or `ai-draft` origin; saving an AI draft does not make it an approved conclusion.

Linked categories, investments, and saved analyses each have a collapsed picker with a selected
count. Expanding a group reveals labelled checkboxes in a bounded, scrollable list. Groups with
more than eight available records also offer a search field. Filtering or collapsing a group
preserves its selections; an empty search result has an explicit message.

The workspace field uses a labelled select so all four choices remain readable in narrow editor panels.

The editor saves only on an explicit action. A successful save creates a numbered, immutable
snapshot. When an editor is stale, the server rejects the save rather than overwriting a newer
version. The history view can restore earlier content, which creates another version instead of
changing the old one. Deleting a dossier deletes its history too.

An empty library shows one full-width guided state pointing to dossier creation. The list and selection panels appear when records or an editor exist; loading and errors remain explicit.

The page header has a primary _New dossier_ button and a ••• menu with _Export all_; the dossier list is a `List`. Origin and stance are `SegmentedControl`s and the linked source document is a select. Deleting a dossier, restoring an earlier version and reloading the latest server version each ask first through `useConfirmDialog` (none has an undo path); `window.confirm` is no longer used ([[docs/adr/187-completeness-sweep|ADR-187]]).

Each citation keeps the source title, reference, optional source and access dates, claim, stance,
and notes. A local research document may add its document ID, version, passage ordinal, and
content digest. Those details are validated and pinned at save time, but the citation snapshot
remains readable if the document is later deleted or re-extracted. A new or changed document
citation must match an available source. This is not continuous fact checking or monitoring.
An optional [[docs/features/analysis-monitors|evidence monitor]] can later report changes to the
saved evidence set; it does not revalidate citations.

Links are current references, not copies of source records. A deleted category, investment, or
saved analysis is shown as unavailable using the link's last saved label. Such a link is absent
from the live ID arrays returned by the API. Category merges can redirect a live category link to
the surviving node. Historical dossier versions retain the content that was saved at the time.

The library list returns only bounded summaries and is paged (100 dossiers by default, at most 500
per request); opening a dossier loads its full evidence. One dossier or the
whole library can be exported as JSON with all versions for a portable local record. Export is not
a restore operation: this feature has no JSON import endpoint. Vision's `.visionbak` backup includes
the three dossier tables for normal system restoration. Dossier content remains local; the dossier
service does not send it to an AI provider.

## Related

- [[docs/features/index|Features]]
- [[docs/api/research-dossiers|Research Dossiers API]]
- [[docs/adr/153-persistent-research-dossiers|ADR-153]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/features/analysis-monitors|Analysis Monitors]]

### Unsaved edits when switching dossiers

Selecting the current dossier keeps its draft unchanged. Selecting another dossier or New with unsaved edits opens the shared discard confirmation. Cancel retains the draft; Discard changes continues the requested selection. Saving remains explicit and successful saves do not trigger this confirmation.
