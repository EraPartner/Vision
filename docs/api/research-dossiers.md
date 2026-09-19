---
title: Research Dossiers API
type: endpoint
status: active
date: 2026-09-19
tags: [api, research, dossiers, evidence, versioning]
description: Nine additive operations under /api/research-dossiers for local versioned research and JSON export.
path: /api/research-dossiers
methods: [GET, POST, PUT, DELETE]
aliases: [dossier API, research dossier endpoints]
---

# Research Dossiers API

This is an additive API; it does not change existing analysis or investigation requests. All
success responses use `{ ok: true, data: ... }`, except `DELETE` which returns empty `204`. The
route group uses the aggregation rate limiter. IDs are UUIDs; malformed IDs, invalid pagination,
unknown links, or mismatched document provenance are rejected.

| Method   | Path                                    | Purpose                                                                                  |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `/api/research-dossiers?limit=&offset=` | Latest-updated summary page `{items,total,limit,offset}`; default limit 100, maximum 500 |
| `POST`   | `/api/research-dossiers`                | Create version 1 from dossier content; returns `201`                                     |
| `GET`    | `/api/research-dossiers/export`         | Export every dossier and version as schema-version-1 JSON                                |
| `GET`    | `/api/research-dossiers/:id`            | Read current content, live link IDs, and link status details                             |
| `PUT`    | `/api/research-dossiers/:id`            | Save content with `expectedVersion`; append a new version                                |
| `DELETE` | `/api/research-dossiers/:id`            | Delete current record and all versions; returns `204`                                    |
| `GET`    | `/api/research-dossiers/:id/versions`   | List `{items:[{version,snapshot,createdAt}]}`, newest first                              |
| `POST`   | `/api/research-dossiers/:id/restore`    | Copy `{version,expectedVersion}` to a new current version                                |
| `GET`    | `/api/research-dossiers/:id/export`     | Export one dossier and all versions in the same JSON format                              |

`POST` and `PUT` content includes `title`, `workspace`, `question`, optional `userThesis`,
`assumptions`, `openQuestions`, `conclusion`, `reviewDate`, `evidence`, and `links`. `PUT` additionally
requires the current `expectedVersion`. The workspace values are `budgeting`, `portfolio`,
`research`, and `cross-workspace`. Evidence requires `stance` (`support`, `oppose`, or `context`),
`origin` (`user` or `ai-draft`), `claim`, and `source` with a title and reference. Optional evidence
ID is generated on create. Source dates use ISO `YYYY-MM-DD`; access times use offset-bearing ISO
date-time strings. If document metadata is supplied, it requires `documentId` and is checked
against the current document and passage when first saved. Unchanged previously saved citation
snapshots remain valid after source deletion or re-extraction.

`links` has `categoryIds`, `investmentIds`, and `savedAnalysisIds`; each contains distinct IDs of
currently available targets. Response `linkDetails` includes `kind`, `historicalId`,
`labelSnapshot`, `liveId`, and `status`. The live ID arrays omit deleted targets; the details retain
their labels with `status: deleted`. A category merge may change the live ID while preserving the
historical ID. Immutable version snapshots keep the originally saved content.

List `items` contain `id`, `title`, `workspace`, `version`, `question`, `reviewDate`, `createdAt`, and `updatedAt`
only. They do not contain evidence, thesis, or conclusion; request one dossier to read its content.

A stale `expectedVersion` returns `409 DOSSIER_VERSION_CONFLICT`; the client must reload and
resolve the edit. Missing dossiers or historical versions return `404`. Restore can return `400`
if a historical link is no longer a valid live target. The export envelope is
`{schemaVersion:1,exportedAt,dossiers:[{...current,versions:[...]}]}`. Neither export endpoint
streams a download nor imports a backup; clients may save the returned JSON locally.

## Related

- [[docs/api/index|API Documentation]]
- [[docs/features/research-dossiers|Research Dossiers]]
- [[docs/adr/153-persistent-research-dossiers|ADR-153]]
- [[docs/api/analysis|Analysis API]]
