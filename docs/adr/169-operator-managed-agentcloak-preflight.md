---
title: ADR-169 - Operator-managed AgentCloak preflight
type: adr
status: Accepted
date: 2026-09-25
tags: [adr, ai, privacy, security, agentcloak, openai]
description: Add an optional check through an operator-managed AgentCloak loopback endpoint after Vision reference tokenization, while preserving the exact consent-bound OpenAI payload.
aliases: [ADR-169, AgentCloak preflight]
related_code:
  [
    "apps/node-backend/src/services/agentCloakPreflight.js",
    "apps/node-backend/src/routes/aiResearch.js",
    "apps/node-backend/src/services/aiProviderAdapters.js",
  ]
---

# ADR-169: Operator-managed AgentCloak preflight

## Status

Accepted

## Date

2026-09-25

## Context

[[docs/adr/151-scoped-reversible-ai-references|ADR-151]] replaces only literals a user explicitly marks in selected cloud text. Unmarked sensitive text may remain in the question, selected summary, or selected evidence. An optional second check can catch some of that text before OpenAI disclosure. It must not silently rewrite the exact payload the user previewed and granted.

The operator chose an AgentCloak instance under their control. AgentCloak receives the text submitted for checking. A loopback URL only constrains Vision's first network hop; it does not prove where that service processes or forwards the text. The operator must verify its upstream deployment and retention behavior before enabling this path.

## Decision

- An operator may enable `AGENTCLOAK_PREFLIGHT_ENABLED` and configure an authenticated AgentCloak MCP server at an exact loopback `/mcp` URL. The check is off by default. Vision requires the URL, API key, and a bounded timeout when enabled.
- Vision checks only the user-authored cloud fields present in the canonical disclosed payload: `question`, `selectedSummary`, and `selectedEvidence`. It runs after Vision has replaced explicit reference markers with one-job tokens. It replaces token strings with the neutral word `REFERENCE` in the AgentCloak request so AgentCloak does not receive their identifiers. It does not scan local chat, local-only investigations, public web research, provider symbols, or provider-generated instructions and catalog data.
- At disclosure preview, Vision calls AgentCloak's `cloak` MCP tool. It calls the same check again immediately before an OpenAI send, including a retry. A successful response must return exactly the submitted check text. If AgentCloak would change it, Vision blocks the disclosure and asks the user to revise the text or add explicit reference markers. A failed, malformed, or unavailable check also blocks the send when enabled.
- Vision never applies AgentCloak's transformed text. The OpenAI request bytes, preview digest, disclosure grant, budget reservation, and local reference restoration remain governed by the existing boundary. AgentCloak is an advisory gate, not a redaction engine or a guarantee that all sensitive information was found.

## Consequences

- A detected value stops a cloud request before OpenAI receives it, while the user can inspect and revise the original text.
- Enabling the check adds a dependency on an operator-managed loopback endpoint. An unavailable service stops cloud preview or send; local Ollama chat remains available.
- The AgentCloak service may log, retain, or forward submitted text. Operators must verify its deployment and data handling and protect its storage and logs. Even an unchanged response is not proof of anonymity or complete detection.
- The API adds optional status and preview information; existing request shapes and the OpenAI digest are unchanged. The response change is additive.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/151-scoped-reversible-ai-references|ADR-151: Scoped reversible AI references]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [AgentCloak MCP server tutorial](https://docs.incountry.com/agentcloak/mcp-server-tutorial/)
