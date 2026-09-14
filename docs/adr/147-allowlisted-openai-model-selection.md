---
title: ADR-147 - Allowlisted OpenAI Model Selection
type: adr
status: Accepted
date: 2026-09-14
tags: [adr, ai, openai, models, configuration, privacy, spend]
description: Let users select an OpenAI API model in the investigation UI while enforcing a server-owned allowlist and per-model spend accounting.
aliases: [OpenAI model picker, API model allowlist]
---

# ADR-147: Allowlisted OpenAI Model Selection

## Status

Accepted

## Date

2026-09-14

## Context

The optional OpenAI API route originally exposed one operator-configured model. Users need to choose
between approved models for cost, latency, and reasoning quality. Accepting arbitrary model names
would let a client select an unreviewed or differently priced model and invalidate the local spend
reservation.

ChatGPT subscriptions and OpenAI API billing are separate products. Vision cannot treat a ChatGPT
subscription, ChatGPT usage credits, browser session, or Codex login as generic Responses API credit.
OpenAI documents the separate billing boundary in
[Managing billing for ChatGPT and the API platform](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-the-chatgpt-web-and-api-platform).

## Decision

1. The server exposes a bounded catalog of at most twelve API models. Each entry has an identifier,
   display label, and positive input/output prices per million tokens.
2. The investigation UI may select only an identifier returned by that catalog. The server rejects
   all other identifiers before producing a disclosure preview or sending a request.
3. The selected model is included in the exact final request, payload preview, and consent digest.
4. Spend estimation and completed usage accounting use the selected entry's prices. No model may
   reuse another model's cheaper rates.
5. `OPENAI_API_MODELS_JSON` configures the catalog. Existing single-model configuration remains a
   backward-compatible fallback. `OPENAI_API_MODEL` selects the default and must belong to the JSON
   catalog when both are present.
6. The route remains OpenAI API-only. Subscription support would require a separate adapter,
   authentication lifecycle, privacy profile, entitlement check, and ADR; it is not silently added
   to this picker.

## Consequences

- Users can trade cost, speed, and capability without weakening consent or spend enforcement.
- Operators must keep model availability and prices current; Vision does not silently fetch or trust
  a remote model catalog.
- A configured model removed from an API project can still fail remotely, but no unconfigured model
  can be selected locally.

## Related

- [[docs/adr/146-explicit-selected-evidence-cloud-synthesis|ADR-146]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
- [[docs/adr/index|All ADRs]]
