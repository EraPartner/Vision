---
title: "ADR-229: Remove the OpenAI API route, the Codex experiment and AgentCloak"
type: adr
status: accepted
date: 2026-10-20
tags:
  [
    adr,
    ai,
    privacy,
    openai,
    codex,
    agentcloak,
    ollama,
    migration,
    retirement,
    adr-138,
    adr-145,
    adr-151,
    adr-171,
  ]
description: "Accepted on 2026-10-20 by Tor. Vision removes the OpenAI API investigation route with its disclosure preview, grants, records, model allowlist and budget; the experimental Codex/ChatGPT subscription route; AgentCloak; and the scoped reversible references that masked cloud sends. Investigations run only on the configured Ollama endpoint. Migration 0002 drops the disclosure and reference tables, deletes non-local jobs and the AgentCloak preference. Supersedes ADR-138, 146, 147, 148, 149, 151, 159, 164, 167, 169, 170 and 171, and the OpenAI egress parts of ADR-145."
aliases:
  [
    adr-229,
    remove cloud ai,
    remove openai route,
    remove codex experiment,
    remove agentcloak,
  ]
related_code:
  [
    "db/migrations/0002_remove_cloud_ai.sql",
    "db/migrations/0002_remove_cloud_ai.down.sql",
    "apps/node-backend/src/routes/aiResearch.ts",
    "apps/node-backend/src/services/aiInvestigationService.ts",
    "packages/types/src/aiResearch.ts",
    "apps/node-backend/src/backup/coverage.ts",
    "packaging/electron/runtime/native.ts",
  ]
---

# ADR-229: Remove the OpenAI API route, the Codex experiment and AgentCloak

## Status

Accepted on 2026-10-20 (decision by Tor). It supersedes
[[docs/adr/138-openai-codex-assistance-boundary|ADR-138]],
[[docs/adr/146-explicit-selected-evidence-cloud-synthesis|ADR-146]],
[[docs/adr/147-allowlisted-openai-model-selection|ADR-147]],
[[docs/adr/148-user-default-openai-model|ADR-148]],
[[docs/adr/149-cloud-authored-catalog-analysis-plans|ADR-149]],
[[docs/adr/151-scoped-reversible-ai-references|ADR-151]],
[[docs/adr/159-experimental-isolated-codex-route|ADR-159]],
[[docs/adr/164-disposable-codex-session-cleanup|ADR-164]],
[[docs/adr/167-packaged-openai-api-release-gate|ADR-167]],
[[docs/adr/169-operator-managed-agentcloak-preflight|ADR-169]],
[[docs/adr/170-agentcloak-desktop-detection-and-scoped-protection|ADR-170]] and
[[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]]. It supersedes the OpenAI egress
parts of [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]] (the `openai-api` route, the
Seatbelt egress helper, disclosure records and grants); its recoverable local jobs, bounded tools,
local documents and public research stay in force.

## Date

2026-10-20

## Context

Vision is a local-first finance app ([[docs/adr/024-local-llm-chat|ADR-024]]). From September
2026 it gained an optional cloud path for AI investigations: an OpenAI API route with an exact
disclosure preview, digest-bound consent grants, disclosure records, a server-approved model and
price allowlist, a monthly budget and a short-lived Seatbelt-sandboxed egress helper; scoped
reversible references that replaced marked literals with encrypted one-job tokens; optional
AgentCloak checks (an operator-managed MCP gate and AgentCloak Desktop detection with a Settings
control); and a synthetic-only admin route that ran Codex App Server under a ChatGPT subscription.

None of these routes was accepted for private financial data. Live synthetic acceptance of the
packaged OpenAI route was never recorded, and the Codex route stayed synthetic-only. The code,
configuration, tables, scripts and documentation they needed were a large surface to keep correct
for features that were not used.

## Decision

Tor decided to remove the three features entirely.

- **OpenAI API route.** The `openai-api` investigation route, cloud planning, selected-summary and
  selected-evidence cloud synthesis, cloud-authored catalog analysis plans, the disclosure preview,
  grants and records, the model allowlist (`OPENAI_API_MODELS_JSON`) and other `OPENAI_API_*`
  settings, the monthly budget, the egress helper and broker
  (`apps/node-backend/src/integrations/openai`), the cloud privacy evaluation scripts
  (`evaluate:cloud-privacy`, `evaluate:cloud-seatbelt-smoke`), the Settings OpenAI default-model
  section and the packaged `OPENAI_API_ENABLED`/`OPENAI_API_KEY` passthrough are removed.
- **Codex experiment.** `/api/admin/codex-experimental/*`, `apps/node-backend/src/integrations/codex`,
  `VISION_EXPERIMENTAL_CODEX*` and the `evaluate:codex-seatbelt-smoke` and
  `evaluate:codex-subscription` scripts are removed.
- **AgentCloak and reversible references.** `AGENTCLOAK_*`, the MCP preflight, Desktop detection,
  `GET`/`PUT /api/ai-research/agentcloak-desktop`, the Settings AgentCloak Desktop section,
  `AI_REFERENCE_MAPPING_KEY`, `aiReferenceService` and `[[vision-ref:...]]` markers are removed.
- **API.** Thirteen operations are removed (312 → 299): `agentcloak-desktop` (`GET`, `PUT`),
  `disclosures/preview`, `disclosures/grants` (`GET`, `POST`), `disclosures/grants/{id}/revoke`,
  `disclosures/records` (`GET`, `DELETE`) and the five `codex-experimental` operations. The
  investigation request accepts `route: "local"` only and no longer has `publicQuestion`,
  `grantId`, `selectedSummary`, `selectedEvidence` or `referenceScopeId`; investigation rows no
  longer return `grantId`. `GET /api/ai-research/status` keeps its local, web, document and
  orchestration fields but loses the `openai` block and the `openai-api` provider. This is a
  breaking API change.
- **Schema.** `db/migrations/0002_remove_cloud_ai.sql` deletes investigation jobs whose route is not
  `local` (their steps cascade), narrows `ai_investigation_jobs.route` to `local`, drops
  `ai_investigation_jobs.grant_id`, drops `ai_disclosure_records`, `ai_disclosure_grants`,
  `ai_reference_entries` and `ai_reference_scopes`, and deletes the `user_settings` row
  `agentcloak_desktop_enabled`. The backup coverage list no longer names those four tables.

Kept: Ollama chat, local investigations, local research documents, saved analysis, public web
research (Brave) and the public research providers. The repository's coding-agent tooling (the
`.codex/` directory, Codex as a coding agent in `AGENTS.md`, the agent sandbox guide) is developer
tooling, not an app feature, and is unaffected.

## Consequences

- Investigations always run on the configured Ollama endpoint, which is local by default. A
  remote `OLLAMA_URL` still receives prompts and tool results, as before. Optional public web and
  provider research still sends only separately authored public queries and symbols.
- Migrations apply at backend startup, so migration 0002 runs at the next launch after the update.
  Cloud investigation jobs, disclosure grants and records, reference scopes and entries, and the
  AgentCloak preference are deleted. They are not recoverable except from a backup taken before
  the update, and restoring such a backup into this version runs migration 0002 again; reading
  that data needs an older Vision. `0002_remove_cloud_ai.down.sql` recreates only the empty tables,
  column and wider route check.
- Leftover `OPENAI_API_*`, `AGENTCLOAK_*`, `AI_REFERENCE_MAPPING_KEY` and `VISION_EXPERIMENTAL_CODEX*`
  lines in a user's `.env.local` or the packaged `runtime.env` are ignored: no backend code reads
  them and the backend environment schema passes unknown keys through. The packaged runtime no
  longer imports the OpenAI keys from the launch environment (`validateApplicationEnv()` in
  `packaging/electron/runtime/native.ts`, checked by `native.test.ts`) and no longer sets them for
  the backend. Users can delete the lines.
- A stored `openAiDefaultModel` app setting is dropped on frontend hydration.
- Older backups that contain the four dropped tables still restore. The restore path
  (`packaging/electron/backup/restore.ts` → `restoreNativeBundle()`/`restoreNativeDatabase()` in
  `packaging/electron/backup/native-transport.ts`) activates the restored database at the dump's
  own migration head, refuses only a dump newer than this install, then calls `runtime.start()`;
  backend startup in `apps/node-backend/src/main.ts` calls `runMigrations()`, which applies 0002
  and drops the tables again. This follows from the code path; no test restores a pre-0002 dump
  end to end.
- Clients that call a removed endpoint get an error response instead of the old operation; clients that send a removed request field or
  another route get `400`. The frontend no longer calls `GET /api/ai-research/status`.
- `docs/reference/openai-codex-assistance-profiles.md` and
  `docs/diagrams/codex-experimental-isolation-flow.puml` are deleted. The flow visualizer drops the
  cloud catalog, cloud evidence, AgentCloak setup and Codex journeys and their components.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/024-local-llm-chat|ADR-024]]
- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/reference/data-model|Data Model]]
