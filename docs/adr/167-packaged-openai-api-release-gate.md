---
title: ADR-167 - Packaged OpenAI API Release Gate
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, ai, privacy, release, electron]
description: Keep the OpenAI API investigation route disabled in packaged Vision until a separate live synthetic acceptance is approved and completed.
aliases: [packaged OpenAI API gate, cloud evaluation release scope]
---

# ADR-167: Packaged OpenAI API Release Gate

## Context

The OpenAI API route has offline privacy tests and a bounded synthetic child-process test, but it
has not had an approved live API request. The operator declined a live API test for this release.
The experimental Codex subscription route completed one fictional device-code turn and remains
synthetic-only under [[docs/adr/159-experimental-isolated-codex-route|ADR-159]].

## Decision

Packaged Vision overrides `OPENAI_API_ENABLED` to `false` and does not pass an API key to its
backend, even if a private runtime environment file contains either setting. The investigation UI
disables the OpenAI API route option when backend status says it is disabled. The backend retains
its existing `OPENAI_DISABLED` refusal. Source development may run the adapter with explicit
configuration, but that is not release acceptance.

The cloud evaluation for this release covers local mode, offline inspection of the exact
serialized API requests and rejection paths, and the synthetic-only experimental Codex route. It
does not claim provider-side deletion, live API network behavior, or usefulness on private
financial tasks. Enabling the packaged API route requires a later reviewed decision and live
synthetic route acceptance with separate authorization.

## Consequences

- The shipped application cannot send an OpenAI API request through the investigation route.
- The API operation set and response schema do not change. Packaged status reports the route as
  disabled; the frontend cannot select it. This is a release configuration restriction.
- Local Ollama remains the default investigation route. Codex remains an isolated synthetic
  experiment with no private financial data authorization.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
- [[docs/features/ai-chat|AI Chat]]
- [[docs/api/ai-research|AI Research API]]
