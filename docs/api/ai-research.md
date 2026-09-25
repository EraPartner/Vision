---
title: AI Research API
type: api
status: active
date: 2026-09-14
updated: 2026-09-25
tags: [api, ai, research, jobs, documents, disclosure, openai, agentcloak]
description: Recoverable AI investigations, local research documents, consent-bound cloud disclosure, scoped reversible references, and optional AgentCloak Desktop protection or MCP preflight.
aliases: [AI investigation API, research document API, disclosure API]
---

# AI Research API

> [!abstract]
> `/api/ai-research` is the provider-neutral investigation and disclosure surface.
> `/api/ai-research/documents` owns the local passage library. Both use the normal response envelope.

Packaged Vision can enable the `openai-api` route when its private native runtime environment
explicitly supplies `OPENAI_API_ENABLED=true` and `OPENAI_API_KEY`. Otherwise it remains disabled.
The selected model, prices, spend budget, and consent grant still gate actual sends. This is code
capability; live synthetic route acceptance has not yet been recorded for this release. See
[[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]].

## Endpoints

| Method        | Path                                             | Purpose                                                                                     |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `GET`         | `/api/ai-research/status`                        | Effective local, web, OpenAI, reversible-reference, and AgentCloak capabilities             |
| `GET, PUT`    | `/api/ai-research/agentcloak-desktop`            | Probe Desktop and inspect or change its protection preference                               |
| `GET, POST`   | `/api/ai-research/investigations`                | List or start bounded jobs                                                                  |
| `GET, DELETE` | `/api/ai-research/investigations/:id`            | Inspect evidence/steps or delete local history                                              |
| `POST`        | `/api/ai-research/investigations/:id/resume`     | Reuse completed checkpoints                                                                 |
| `POST`        | `/api/ai-research/investigations/:id/cancel`     | Stop queued or active work                                                                  |
| `POST`        | `/api/ai-research/disclosures/preview`           | Canonical exact cloud payload, digest, optional local reference scope, and AgentCloak check |
| `GET, POST`   | `/api/ai-research/disclosures/grants`            | Inspect or create a digest-bound grant                                                      |
| `POST`        | `/api/ai-research/disclosures/grants/:id/revoke` | Stop later sends and retries                                                                |
| `GET, DELETE` | `/api/ai-research/disclosures/records`           | Inspect metadata or delete all records and grants                                           |
| `GET, POST`   | `/api/ai-research/documents`                     | List or upload a text, Markdown, or HTML document                                           |
| `GET, DELETE` | `/api/ai-research/documents/:id`                 | Inspect metadata or delete it and derived passages                                          |
| `POST`        | `/api/ai-research/documents/search/passages`     | Keyword, semantic, or hybrid passage retrieval                                              |

Investigation input includes `question`, `route`, `researchMode`, `model`, `depth`, `language`, typed scope
with separate bank `accountIds` and portfolio `investmentIds`,
optional `grantId`, optional selected summary or selected evidence, optional `referenceScopeId`, and optional saved-analysis reference. Public web mode
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

`GET /api/ai-research/status` exposes each disclosure-mode ID, capability, and disclosed field. It
also returns the server-approved OpenAI API model catalog, configured per-model prices, and default.
An OpenAI investigation may select only one of those IDs. The selected model is part of the exact
preview and consent digest, and its own prices drive spend reservation and final accounting. The
request contract accepts exactly one of `publicQuestion`, `selectedSummary`, or `selectedEvidence`
for the OpenAI route; mixed modes are rejected. These API additions are backward-compatible.

When configured, `status.data.openai.agentCloakPreflight` reports `enabled`, mode, and location;
it exposes no URL or API key. MCP mode reports `mode: "block-on-change"` and
`location: "operator-managed-loopback"`. Desktop mode reports `mode: "protect-and-block"` and
`location: "desktop-loopback"`. Cloud preview adds `agentCloakPreflight: { enabled: false }` when
disabled, or `{ enabled: true, status: "passed" }` after a successful check. A remaining Desktop
finding or a proposed MCP change returns `400 AGENTCLOAK_SENSITIVE_TEXT`; an unavailable or invalid
check returns an upstream error. The check runs again before OpenAI send, including retries. These
response additions are backward-compatible. See
[[docs/adr/169-operator-managed-agentcloak-preflight|ADR-169]] and
[[docs/adr/170-agentcloak-desktop-detection-and-scoped-protection|ADR-170]].

## AgentCloak Desktop setup

`GET /api/ai-research/agentcloak-desktop` returns the normal envelope with `data` containing four
booleans: `enabled`, `available`, `mappingKeyConfigured`, and `openAiEnabled`. `available` is a fresh
bounded probe of the configured Desktop loopback `/detect` endpoint. Status does not return the
mapping key, provider credential, or URL. A reachable endpoint is not a guarantee of future
availability or complete detection.

`PUT /api/ai-research/agentcloak-desktop` accepts only `{ "enabled": boolean }` and returns the
same status shape. Enabling probes Desktop and ensures a valid Vision reference mapping key before
saving the enabled preference. If no key exists, Vision generates one in backend `.env.local` during
source development or in the private native `runtime.env` when packaged. A blank key entry is
filled, but a nonblank invalid key is never replaced. The settings database stores only the
boolean; disabling does not delete the
key. Setup works before OpenAI is configured, although cloud requests still require separate
provider configuration and consent.

An invalid body returns `400`; an invalid existing key returns `409 REFERENCE_KEY_INVALID`;
unavailable Desktop returns `502 AGENTCLOAK_DESKTOP_UNAVAILABLE`; and key storage failure returns
`503 REFERENCE_KEY_STORAGE_UNAVAILABLE`. These operations are additive and nonbreaking for existing
clients. See [[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]].

## Scoped reversible references

For `selected-summary` and `cloud-synthesis-selected`, callers may wrap a literal inside
`selectedSummary` or `selectedEvidence` as `[[vision-ref:type|value]]`. Allowed types are `account`,
`recipient`, `investment`, `holding`, `category`, `document`, `subject`, `amount`, and `date`.
Markers are explicit. In optional AgentCloak Desktop mode, Vision also scans selected summary and
evidence for spans to protect automatically before computing the preview digest. It does not
replace text in the question or public-query fields. The public question and any findings left in
the tokenized selected text block preview.

`POST /api/ai-research/disclosures/preview` accepts the full `AiInvestigationRequest`. Its response
adds:

- `outboundRequest`: the request that must be used for grant creation and investigation creation;
  marked literals and, in Desktop mode, detected selected-text literals are replaced with
  `[[VR1:type:<24 base64url characters>]]` tokens;
- `referenceScope`: either `null`, or `{ id, expiresAt, count }` for the encrypted local mapping;
- the existing exact payload, SHA-256 digest, byte count, field manifest, and disclosure units,
  computed from that tokenized outbound request.

When markers or Desktop detections create a scope, `AI_REFERENCE_MAPPING_KEY` must decode to
exactly 32 bytes. Missing or invalid key material returns `503 REFERENCE_KEY_UNAVAILABLE`. A clean
Desktop scan without markers needs no mapping key. Unsupported or malformed markers
return `400`. The unclaimed scope is usable for 15 minutes. Investigation creation rejects raw
markers, malformed or unknown tokens, a token from another scope, and an expired or already claimed
scope. A successful create atomically claims the scope for that one job and extends its restoration
window to 30 days. Reusing the preview returns `409 REFERENCE_SCOPE_INACTIVE`.

The provider-form structured answer is checkpointed locally before restoration. Restart validates
and restores that checkpoint without another model or provider call. Vision restores tokens only in
summary; fact, calculation, and interpretation text; assumptions; missing-information strings;
conflict descriptions; and evidence excerpts. It never rewrites evidence identifiers, labels,
locators, kinds, dates, availability, or answer structure. Unknown, cross-job, malformed, expired,
or undecryptable response tokens fail the job visibly; no partly restored answer is returned.

This feature is **pseudonymization, not anonymity**. It hides only marked literals and optional
Desktop-detected spans. The
surrounding disclosure can still reveal amounts, dates, holdings, writing style, and behavioral
patterns. See [[docs/adr/151-scoped-reversible-ai-references|ADR-151]]. The API change is additive
and backward-compatible; requests without markers or Desktop findings receive
`referenceScope: null` and an equivalent `outboundRequest`.

## Analysis extensions

`POST /api/analysis/formulas/evaluate` evaluates the supported formula language. Saved analysis
updates accept `expectedVersion`; a mismatch returns `409`. `GET /api/analysis/saved/:id/versions`
and `POST /api/analysis/saved/:id/restore` provide undo. AI edits use separate
`POST /api/analysis/saved/:id/ai-proposal`, `/api/analysis/ai-proposals/preview`, and `/apply`
operations. Generation is local and read-only; applying the inspected proposal is a separate action.

## Related

- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
- [[docs/adr/147-allowlisted-openai-model-selection|ADR-147]]
- [[docs/adr/151-scoped-reversible-ai-references|ADR-151]]
- [[docs/adr/169-operator-managed-agentcloak-preflight|ADR-169]]
- [[docs/adr/170-agentcloak-desktop-detection-and-scoped-protection|ADR-170]]
- [[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]]
- [[docs/api/analysis|Analysis API]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
