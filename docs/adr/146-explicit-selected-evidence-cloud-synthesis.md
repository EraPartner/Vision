---
title: ADR-146 - Explicit Selected-Evidence Cloud Synthesis
type: adr
status: Accepted
date: 2026-09-14
tags: [adr, ai, openai, privacy, disclosure, synthesis, evidence]
description: Add a distinct opt-in mode where OpenAI writes the final answer from only the exact user-selected evidence approved in a bounded disclosure preview.
aliases: [cloud synthesis, selected evidence synthesis, OpenAI final answer]
---

# ADR-146: Explicit Selected-Evidence Cloud Synthesis

## Status

Accepted

## Date

2026-09-14

## Context

[[docs/adr/145-bounded-ai-research-orchestration|ADR-145]] keeps final private synthesis local. Its
public-question and selected-summary modes use OpenAI only to order a locally bounded plan. Some users
may prefer more cloud computation and accept disclosing a small, inspected set of financial evidence.
Treating that preference as a warning on an existing mode would blur the capability and consent
boundary.

## Decision

Vision adds `cloud-synthesis-selected` as a third OpenAI disclosure mode. The existing
`cloud-plan-public` and `selected-summary` planning modes keep their current behavior.

The new mode has these rules:

1. The user supplies the exact task and selected evidence in a dedicated field. Vision does not add
   the private question, database rows, local document passages, conversation history, tool results,
   or hidden context.
2. The complete Responses API request is shown before transmission. Its digest, purpose, fields,
   expiry, request count, characters, output tokens, cost, and disclosure units are bound to a
   dedicated `cloud-synthesis-selected` grant. A planning grant cannot authorize synthesis.
3. OpenAI receives no hosted tools, database connection, filesystem access, or background task. It
   returns a structured answer that may cite only the `selected-evidence` reference.
4. Vision validates the answer schema and citation IDs before display. A provider failure yields an
   explicit partial result. It never falls back to local synthesis because that would hide the chosen
   capability and change the resource profile.
5. The mode skips local planning, local evidence tools, and local model inference. This bounds local
   CPU and memory but makes the user responsible for selecting sufficient and acceptable evidence.
6. `store: false` remains a request setting, not a claim of zero provider retention or onward
   processing. The interface displays that limitation next to the mode.
7. The recoverable local investigation stores the selected evidence until the user deletes that
   investigation. The separate disclosure history stores only the payload digest and policy
   metadata and can be deleted independently.

## Consequences

- Users can choose additional cloud compute without weakening the two existing planning profiles.
- Private selected evidence is intentionally disclosed. It is data minimization, not anonymization.
- The current mode accepts a manually selected evidence bundle. Automatic retrieval followed by an
  interactive row-by-row evidence picker would require a separate two-stage job and consent design.
- The OpenAI API route remains disabled by default and subject to the existing model, credential,
  spend, isolation, and live-acceptance gates.

## Related

- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
- [[docs/adr/index|All ADRs]]
