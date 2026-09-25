---
title: ADR-170 - AgentCloak Desktop detection with scoped Vision protection
type: adr
status: Accepted
date: 2026-09-25
tags: [adr, ai, privacy, security, agentcloak, openai]
description: Use optional local AgentCloak Desktop detection to protect selected cloud text with Vision's encrypted scoped references before consent, while keeping the MCP gate available.
aliases: [ADR-170, AgentCloak Desktop protection]
related_code:
  [
    "apps/node-backend/src/services/agentCloakPreflight.js",
    "apps/node-backend/src/services/aiReferenceService.js",
    "apps/node-backend/src/routes/aiResearch.js",
    "apps/node-backend/src/services/aiProviderAdapters.js",
  ]
---

# ADR-170: AgentCloak Desktop detection with scoped Vision protection

## Status

Accepted

## Date

2026-09-25

## Context

[[docs/adr/169-operator-managed-agentcloak-preflight|ADR-169]] uses an operator-managed AgentCloak MCP server as an optional block-on-change check. The user also has the free AgentCloak Desktop app installed and wants it to protect and reveal selected Vision text. The installed Desktop 1.0.0 exposes an undocumented loopback `/detect` interface. Its separate `/protect` and `/reveal` interfaces keep their own mapping; using them directly would add another recovery dependency to Vision's consent and answer-restoration flow. The Desktop mapping is stored as plaintext, and reveal can replace matching text outside a scoped token position. Vision already has encrypted, job-scoped mapping and constrained local restoration under [[docs/adr/151-scoped-reversible-ai-references|ADR-151]].

## Decision

- Add an optional `desktop` mode to `AGENTCLOAK_PREFLIGHT_MODE`; keep `mcp` as the default and preserve ADR-169's MCP behavior. Both modes remain off unless `AGENTCLOAK_PREFLIGHT_ENABLED=true`.
- In Desktop mode, preview sends present selected-summary and selected-evidence text to the configured exact loopback `/detect` endpoint. Vision masks existing reference tokens with spaces so their identifiers do not reach Desktop and span offsets stay aligned. It validates the returned spans, replaces detected literals with random `[[VR1:subject:...]]` tokens, and stores the mapping as AES-256-GCM ciphertext in Vision's one-job scope. Explicit `[[vision-ref:type|value]]` markers still work. The mapping key is needed when a marker or detection creates a scope.
- Preview computes the exact disclosure payload and grant digest **after** replacement. A second Desktop detection check runs on the resulting user-authored cloud fields; remaining findings block preview. A public question is checked but is never automatically rewritten. Before each OpenAI send attempt, Vision checks the canonical consent-bound fields again and fails closed on a finding, invalid response, timeout, or unavailable Desktop endpoint. Retries use the previewed bytes rather than generating new tokens.
- Vision checkpoints the provider-form answer and restores only allowlisted display text with its existing encrypted scope. It does not call Desktop `/protect` or `/reveal`, or rely on Desktop's mapping for recovery. The Desktop scan is experimental because `/detect` is not a documented third-party API; changes to its interface may stop enabled cloud work.

## Consequences

- Detected literals in selected summary or evidence can be protected automatically while the user still sees and grants the exact tokenized OpenAI payload. A detection is not a guarantee that all private information was found; context and other unmarked values may remain identifying.
- Desktop receives the selected text submitted for detection on local loopback. The endpoint has no request authentication; other local processes may be able to call it. Operators should protect access to their machine and inspect the complete disclosure preview.
- Vision's encryption key and PostgreSQL scope must remain available until local restoration finishes. A lost key or expired scope fails visibly after the provider-form checkpoint, without exposing a partly restored answer. A clean scan with no explicit marker needs no scope or mapping key.
- The status response adds mode and location values; existing API paths and request shapes are unchanged. Desktop mode is available only where the Vision backend can reach the Desktop app's loopback endpoint. [[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]] later permits explicitly configured packaged OpenAI use; live synthetic route acceptance remains separate.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/169-operator-managed-agentcloak-preflight|ADR-169: Operator-managed AgentCloak preflight]]
- [[docs/adr/151-scoped-reversible-ai-references|ADR-151: Scoped reversible AI references]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/api/ai-research|AI Research API]]
