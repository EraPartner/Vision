---
title: AI Research API
type: api
status: active
date: 2026-10-20
updated: 2026-10-20
tags: [api, ai, research, jobs, documents, ollama]
description: Recoverable AI investigations on the configured Ollama endpoint and the local research document library.
aliases: [AI investigation API, research document API]
---

# AI Research API

> [!abstract]
> `/api/ai-research` is the investigation surface. `/api/ai-research/documents` owns the local
> passage library. Both use the normal response envelope.

Investigations run only on the configured Ollama endpoint (`route: "local"`). The OpenAI API
route, its disclosure preview, grants and records, scoped reversible references and AgentCloak
were removed in [[docs/adr/229-remove-cloud-ai-codex-and-agentcloak|ADR-229]]. That change is
breaking: the removed endpoints are gone, and the investigation request rejects the removed fields
and any route other than `local`.

## Endpoints

| Method        | Path                                         | Purpose                                            |
| ------------- | -------------------------------------------- | -------------------------------------------------- |
| `GET, POST`   | `/api/ai-research/investigations`            | List or start bounded jobs                         |
| `GET, DELETE` | `/api/ai-research/investigations/:id`        | Inspect evidence/steps or delete local history     |
| `POST`        | `/api/ai-research/investigations/:id/resume` | Reuse completed checkpoints                        |
| `POST`        | `/api/ai-research/investigations/:id/cancel` | Stop queued or active work                         |
| `GET, POST`   | `/api/ai-research/documents`                 | List or upload a text, Markdown, or HTML document  |
| `GET, DELETE` | `/api/ai-research/documents/:id`             | Inspect metadata or delete it and derived passages |

Investigation input is a strict object with `question`, `route` (only `local`, the default),
`researchMode`, `model`, `depth`, `language`, typed scope with separate bank `accountIds` and
portfolio `investmentIds`, optional `clarification`, and optional saved-analysis reference.
Unknown fields return `400`. Public web mode
requires a separately authored `publicWebQuery`. Public-provider mode requires explicit
`publicSymbols` or `publicMacroQueries`; it never extracts identifiers from the private question.
Local-only is the default. The states are `queued`, `running`, `waiting`, `partial`, `completed`,
`failed`, and `cancelled`. A materially ambiguous comparison enters `waiting`; it stays waiting across
restart until resume accepts a bounded `clarification`. Startup queues only unfinished queued/running
work in creation order. Startup reuses completed steps. An explicit resume of a partial or failed
job refreshes completed local data steps while retaining external checkpoints, avoiding accidental
repeat egress. A changed scope requires a new job. Detailed jobs may use
one local inspection pass to retry up to three failed local steps. Jobs and tools remain serialized.

Resolving a comparison in `waiting` requires a calendar-valid typed date range in the resumed
scope; free-form clarification alone does not suppress the ambiguity gate.

The answer contract separates facts, deterministic calculations, interpretations, assumptions,
missing information, conflicts, and evidence. Facts, calculations, and interpretations require at
least one valid evidence identifier. Retrieved evidence and synthesis stay on the Ollama endpoint.
The recoverable investigation stores its input until `DELETE /api/ai-research/investigations/:id`.

The unused `GET /api/ai-research/status` and `POST /api/ai-research/documents/search/passages`
operations had no caller and were removed on 2026-10-20 (breaking only for direct HTTP clients).

Investigation rows no longer include `grantId`.

## Research documents

`POST /api/ai-research/documents` takes a multipart `file` with optional `title` and `source_name`
text fields. A missing file returns `400`. A field sent twice arrives as an array and returns
`400`. An empty `title` or `source_name` falls back to the file name.

Passage retrieval has no HTTP operation. The AI chat research tool and investigation steps call
`searchResearchDocuments` in `apps/node-backend/src/services/aiResearchDocuments.ts` in-process
(`hybrid` by default, `keyword` or `semantic`; at most 20 passages, default 8).

## Analysis extensions

`POST /api/analysis/formulas/evaluate` evaluates the supported formula language. Saved analysis
updates accept `expectedVersion`; a mismatch returns `409`. `GET /api/analysis/saved/:id/versions`
and `POST /api/analysis/saved/:id/restore` provide undo. AI edits use separate
`POST /api/analysis/saved/:id/ai-proposal`, `/api/analysis/ai-proposals/preview`, and `/apply`
operations. Generation is local and read-only; applying the inspected proposal is a separate action.

## Related

- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
- [[docs/adr/229-remove-cloud-ai-codex-and-agentcloak|ADR-229]]
- [[docs/api/analysis|Analysis API]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
