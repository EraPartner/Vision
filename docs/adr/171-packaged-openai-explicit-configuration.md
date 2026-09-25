---
title: ADR-171 - Explicitly configured packaged OpenAI API route
type: adr
status: Accepted
date: 2026-09-25
tags: [adr, ai, privacy, release, electron, openai, agentcloak]
description: Permit the packaged OpenAI API investigation route only with explicit private runtime configuration, while tracking live synthetic acceptance separately from code capability.
aliases: [ADR-171, packaged OpenAI explicit configuration]
related_code:
  [
    "packaging/electron/runtime/native.js",
    "apps/node-backend/src/routes/aiResearch.js",
    "apps/node-backend/src/services/agentCloakDesktopSetupService.js",
    "apps/node-backend/src/services/aiReferenceKeySetup.js",
  ]
---

# ADR-171: Explicitly configured packaged OpenAI API route

## Status

Accepted for implementation. Live synthetic route acceptance remains to be recorded before a release claim.

## Date

2026-09-25

## Context

[[docs/adr/167-packaged-openai-api-release-gate|ADR-167]] forced packaged Vision's OpenAI API route off even when its private native runtime environment contained an API enable flag and key. That was the release boundary when the operator declined a live API test. The operator now requests an available packaged route and has authorized a live synthetic acceptance run. The code capability and the acceptance evidence are separate facts.

The new AgentCloak Desktop setup control also needs to work before OpenAI is configured. Its selected-text protection depends on Vision's installation-held reference key, not on the provider credential.

## Decision

- The native runtime passes `OPENAI_API_ENABLED` and `OPENAI_API_KEY` from its private `runtime.env` to the backend. The packaged route is enabled only when the flag is exactly `true` and a key is present. Otherwise it remains disabled. Local Ollama stays the default route. The key is not returned by the status or AgentCloak setup APIs.
- AI settings exposes AgentCloak Desktop status and an enable or disable control. Enabling first probes the configured Desktop loopback `/detect` endpoint, then ensures a valid 32-byte Vision reference mapping key. If the key is missing or its environment entry is blank, Vision creates one in backend `.env.local` for source development or the private native `runtime.env` for packaged operation. A nonblank invalid key is never replaced. Only the enabled boolean is persisted in the settings database. Disabling does not delete the key.
- The Desktop setup response reports effective `enabled`, fresh `available`, `mappingKeyConfigured`, and `openAiEnabled` booleans. It does not expose endpoint credentials or key material. A failed probe, invalid existing key, or failed key storage prevents enablement.
- This supersedes ADR-167's unconditional packaged disablement. It does not itself establish live API behavior, provider-side retention, privacy for real financial data, or release acceptance. Record the authorized live synthetic route result separately. Until that result is reviewed, describe the packaged route as code-capable and the release acceptance as pending.

## Consequences

- An explicitly configured packaged installation can expose the consent-bound OpenAI investigation route. Misconfiguration keeps it disabled.
- AgentCloak Desktop can be enabled before an OpenAI key is supplied. The new local reference key is installation state outside PostgreSQL and database backups; losing it can make token-bearing checkpoints unrestorable.
- The Desktop `/detect` interface is experimental and may change. A successful loopback probe shows reachability at that moment, not a lasting guarantee of detection or a provider privacy promise.
- The new GET and PUT `/api/ai-research/agentcloak-desktop` operations add an API surface. The request and response shapes are additive; existing operations are unchanged.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/167-packaged-openai-api-release-gate|ADR-167: Packaged OpenAI API Release Gate]]
- [[docs/adr/170-agentcloak-desktop-detection-and-scoped-protection|ADR-170: AgentCloak Desktop detection]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/features/settings|Settings]]
- [[docs/security/ai-assistance-evaluation|AI Assistance Evaluation]]
