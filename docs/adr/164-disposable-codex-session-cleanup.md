---
title: ADR-164 - Disposable Codex Session Cleanup
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, codex, ai, privacy, security]
description: Remove abandoned synthetic Codex session directories after a backend crash without touching unrelated temporary files.
aliases: [Codex stale session cleanup]
---

# ADR-164: Disposable Codex Session Cleanup

## Context

[[docs/adr/159-experimental-isolated-codex-route|ADR-159]] removes its private Codex home after a normal logout or ten-minute expiry. A forced backend exit can skip that cleanup. The App Server is configured for ephemeral credentials, but a leftover directory is still private session state and should be removed.

## Decision

- Each synthetic session root receives a private owner marker before any Codex process starts. The marker binds the canonical root, process ID, and creation time to a fixed Vision format.
- Before starting a later session, Vision scans only roots with the synthetic session prefix under the configured temporary parent. It deletes a root only when it is a real directory, has a valid regular marker bound to that exact root, and its owner process no longer exists. Active and unmarked roots remain untouched.
- Normal logout, expiry, and startup-failure cleanup remain immediate. The scan does not inspect or import credentials from an abandoned root and does not claim provider-side token revocation.

## Consequences

Crash leftovers are removed on the next experimental session start, not by a background system service. A root created before its marker is written may remain, but Codex has not started at that point. An abandoned root with a reused live process ID may remain until a later cleanup. The route is still synthetic only and blocked for private financial data.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
- [[docs/security/ai-assistance-evaluation|AI Assistance Evaluation]]
