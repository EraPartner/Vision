---
title: ADR-148 - User Default OpenAI Model
type: adr
status: Accepted
date: 2026-09-14
tags: [adr, ai, openai, settings, models, preferences]
description: Persist a user-selected default OpenAI API model while retaining the server allowlist and operator default as the security and recovery boundary.
aliases: [OpenAI default model preference]
---

# ADR-148: User Default OpenAI Model

## Status

Accepted

## Date

2026-09-14

## Context

[[docs/adr/147-allowlisted-openai-model-selection|ADR-147]] lets a user choose an approved OpenAI API
model per investigation. Its environment-backed default is operator-wide. A user also needs a
persistent default without changing deployment configuration or weakening the approved catalog.

## Decision

1. Settings stores the optional `openAiDefaultModel` preference inside the existing `app_settings`
   object. No schema migration or new settings endpoint is required.
2. The Settings UI offers only models returned by the AI research status catalog.
3. A new investigation uses the first available value in this order: its explicit in-panel override,
   the saved user preference when still allowlisted, the operator default, then the first approved
   model.
4. A removed or malformed saved preference is ignored. It never expands the server allowlist, changes
   model pricing, or bypasses the server's final model validation.
5. Changing the saved default affects new investigations. It does not rewrite an open investigation's
   explicit model selection or an already approved disclosure preview.

## Consequences

- Users can keep a preferred cost/capability choice without asking an operator to change environment
  configuration.
- Operators remain responsible for availability and per-model pricing in
  `OPENAI_API_MODELS_JSON`.
- A catalog change recovers safely to an approved model instead of keeping a stale identifier.

## Related

- [[docs/adr/147-allowlisted-openai-model-selection|ADR-147]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/features/settings|Settings Feature]]
- [[docs/api/settings|Settings API]]
- [[docs/adr/index|All ADRs]]
