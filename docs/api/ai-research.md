---
title: AI Research API
type: api
status: active
date: 2026-09-14
tags: [api, ai, research, jobs, documents, disclosure, openai]
description: Recoverable AI investigations, local research documents, and consent-bound cloud disclosure endpoints.
aliases: [AI investigation API, research document API, disclosure API]
---

# AI Research API

> [!abstract]
> `/api/ai-research` is the provider-neutral investigation and disclosure surface.
> `/api/ai-research/documents` owns the local passage library. Both use the normal response envelope.

## Endpoints

| Method        | Path                                             | Purpose                                                  |
| ------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `GET`         | `/api/ai-research/status`                        | Effective local, web, and OpenAI capabilities and limits |
| `GET, POST`   | `/api/ai-research/investigations`                | List or start bounded jobs                               |
| `GET, DELETE` | `/api/ai-research/investigations/:id`            | Inspect evidence/steps or delete local history           |
| `POST`        | `/api/ai-research/investigations/:id/resume`     | Reuse completed checkpoints                              |
| `POST`        | `/api/ai-research/investigations/:id/cancel`     | Stop queued or active work                               |
| `POST`        | `/api/ai-research/disclosures/preview`           | Canonical exact cloud payload and digest                 |
| `GET, POST`   | `/api/ai-research/disclosures/grants`            | Inspect or create a digest-bound grant                   |
| `POST`        | `/api/ai-research/disclosures/grants/:id/revoke` | Stop later sends and retries                             |
| `GET, DELETE` | `/api/ai-research/disclosures/records`           | Inspect metadata or delete all records and grants        |
| `GET, POST`   | `/api/ai-research/documents`                     | List or upload a text, Markdown, or HTML document        |
| `GET, DELETE` | `/api/ai-research/documents/:id`                 | Inspect metadata or delete it and derived passages       |
| `POST`        | `/api/ai-research/documents/search/passages`     | Keyword, semantic, or hybrid passage retrieval           |

Investigation input includes `question`, `route`, `researchMode`, `depth`, `language`, typed scope
with separate bank `accountIds` and portfolio `investmentIds`,
optional `grantId`, optional selected summary or selected evidence, and optional saved-analysis reference. Public web mode
requires a separately authored `publicWebQuery`. Public-provider mode requires explicit
`publicSymbols` or `publicMacroQueries`; it never extracts identifiers from the private question.
Local-only is the default. The states are `queued`, `running`, `waiting`, `partial`, `completed`,
`failed`, and `cancelled`. A materially ambiguous comparison enters `waiting`; it stays waiting across
restart until resume accepts a bounded `clarification`. Startup queues only unfinished queued/running
work in creation order. Startup reuses completed steps. An explicit resume of a partial or failed
job refreshes completed local data steps while retaining external checkpoints, avoiding accidental
repeat egress. A changed scope requires a new job. Detailed jobs may use
one local inspection pass to retry up to three failed local steps. Jobs and tools remain serialized;
the status endpoint exposes these effective resource limits.

The OpenAI public-plan mode also requires a separately authored `publicQuestion`. It does not send
the private investigation question or its scope constraints. Resolving a comparison in `waiting`
requires a calendar-valid typed date range in the resumed scope; free-form clarification alone does
not suppress the ambiguity gate.

The answer contract separates facts, deterministic calculations, interpretations, assumptions,
missing information, conflicts, and evidence. Facts, calculations, and interpretations require at
least one valid evidence identifier. In `cloud-plan-public` and `selected-summary`, OpenAI may
prioritize the inspectable plan after consent while retrieved evidence and final synthesis stay local.
Public-plan mode rejects common private financial identifiers and amounts. Selected-summary mode
omits the original question and constraints. The separate `cloud-synthesis-selected` mode sends only
the exact `selectedEvidence`, answer schema, language, depth, and fixed citation ID shown in the
preview. It skips planning and local tools, disables hosted tools, and lets OpenAI write the final
structured answer. Invalid or failed cloud synthesis becomes an explicit partial result and never
falls back to local synthesis. The recoverable investigation stores its input, including selected
evidence, until `DELETE /api/ai-research/investigations/:id`. Deleting disclosure history separately
removes records and grants together; those records contain metadata and a digest, not payload text.

`GET /api/ai-research/status` exposes each disclosure-mode ID, capability, and disclosed field. The
request contract accepts exactly one of `publicQuestion`, `selectedSummary`, or `selectedEvidence`
for the OpenAI route; mixed modes are rejected. This API addition is backward-compatible.

## Analysis extensions

`POST /api/analysis/formulas/evaluate` evaluates the supported formula language. Saved analysis
updates accept `expectedVersion`; a mismatch returns `409`. `GET /api/analysis/saved/:id/versions`
and `POST /api/analysis/saved/:id/restore` provide undo. AI edits use separate
`POST /api/analysis/saved/:id/ai-proposal`, `/api/analysis/ai-proposals/preview`, and `/apply`
operations. Generation is local and read-only; applying the inspected proposal is a separate action.

## Related

- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
- [[docs/api/analysis|Analysis API]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
