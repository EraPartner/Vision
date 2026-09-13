---
title: ADR-138 - OpenAI API and Codex Assistance Boundary
type: adr
status: Accepted
date: 2026-09-12
tags:
  [
    adr,
    architecture,
    ai,
    openai,
    codex,
    privacy,
    retention,
    authentication,
    isolation,
  ]
description: Keep OpenAI API and Codex subscription assistance as separate opt-in routes behind one local disclosure boundary, with synthetic-only evaluation until each route has an explicit transmission grant.
aliases:
  [OpenAI assistance boundary, Codex assistance boundary, cloud AI boundary]
---

# ADR-138: OpenAI API and Codex Assistance Boundary

## Status

Accepted

## Date

2026-09-12

## Context

Vision is local-first and currently sends AI prompts only to a configured local Ollama host. The
existing guarantees in [[docs/adr/024-local-llm-chat|ADR-024]] and
[[docs/security/ai-data-access|AI Data Access Policy]] therefore remain true for released code.

An optional future enhancement may use either the OpenAI API or Codex authenticated through a
ChatGPT subscription. These are different product and policy routes. Official Codex documentation
lists ChatGPT sign-in for subscription access and API-key sign-in for usage-based access, and says
the sign-in method determines the applicable workspace or API-organization controls
([Codex authentication](https://learn.chatgpt.com/docs/auth)). This does not make a ChatGPT
subscription a credential for the generic OpenAI API.

Official integration surfaces exist. The Codex SDK starts and resumes local Codex threads from a
server-side application ([Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)), while Codex App
Server exposes a local JSON-RPC protocol with account login, logout, plan, and rate-limit operations
([Codex App Server](https://learn.chatgpt.com/docs/app-server)). Their existence proves an
integration candidate, not that every plan, model, operating system, distribution method, or
privacy profile is suitable for Vision.

The routes also have different retention evidence. OpenAI documents API endpoint-specific abuse
monitoring and application-state retention, including approval-gated Zero Data Retention (ZDR)
([API data controls](https://developers.openai.com/api/docs/guides/your-data)). ChatGPT workspace
retention depends on the account and workspace; business workspace claims do not establish the
effective profile of a personal subscription
([Enterprise privacy](https://openai.com/enterprise-privacy/)).

## Decision

Vision will treat OpenAI API assistance and Codex subscription assistance as separate adapters
behind one local disclosure controller. Neither adapter receives authority from the other.

The shared boundary has these rules:

1. Local-only remains the default and the only currently enabled mode.
2. Cloud assistance is opt-in per destination, authentication route, purpose, data class, and
   budget. An API grant never authorizes Codex, and a Codex grant never authorizes the API.
3. A ChatGPT subscription is not generic API access. API calls require an API organization/project
   credential and use API billing and data controls.
4. Codex subscription access may use only a documented SDK or App Server flow. Browser automation,
   copied cookies, private endpoints, and reading an existing user's Codex credential cache are not
   supported integration strategies.
5. All OpenAI and Codex prototypes use synthetic data until a separate transmission grant exists.
   A successful login or synthetic response does not authorize financial-data transmission.
6. The cloud receives an allowlisted typed payload. Private execution stays local. Cloud output is
   untrusted and must pass the shared analysis contract, identifier checks, and resource limits
   before local execution.
7. Unknown plan eligibility, model availability, retention, caching, subprocessors, tool behavior,
   or isolation fails closed for the affected route and privacy profile.
8. Vision must display the active route and its effective policy. It must not silently fall back
   from exhausted subscription capacity to paid API usage.

The first evaluated slice is cloud-authored planning over a generic schema, executed locally
without financial rows or values. Public-company research may send only the public subject, without
ownership, position size, broker, or personal rationale. Selected summaries are a later profile and
require separate cumulative-disclosure controls.

## Route Decision

| Route                                                     | Decision as of 2026-09-12                                                          | Boundary                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Local Ollama                                              | Supported current behavior                                                         | No cloud transmission; existing local contracts remain authoritative                                  |
| OpenAI API with project credential                        | Supported candidate for a synthetic prototype                                      | Separate adapter, explicit spend cap, endpoint-specific storage settings, no real data before a grant |
| Codex App Server with ChatGPT login                       | Supported candidate for a synthetic isolated prototype                             | Subscription route only; plan and limits are runtime facts; private-data use remains blocked          |
| Codex SDK                                                 | Supported candidate when its local process and App Server boundary can be isolated | Same Codex policy route; not a shortcut around disclosure or retention checks                         |
| API-key login through Codex                               | Supported Codex authentication mode, billed as API usage                           | Still an API-organization policy and cost route, not subscription allowance                           |
| ChatGPT browser automation, cookies, or private endpoints | Unsupported                                                                        | No adapter may depend on them                                                                         |
| ChatGPT subscription used as generic Responses API access | Unsupported assumption                                                             | The routes remain distinct                                                                            |
| Claimed ZDR from `store: false` alone                     | Unsupported                                                                        | ZDR requires approved organization/project controls and endpoint compatibility                        |
| Real financial payload before a matching grant            | Unsupported                                                                        | Synthetic-only gate remains closed                                                                    |

The detailed dated evidence and operational profiles live in
[[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]].

## Privacy Interpretation

No-training, no-advertiser-access, limited retention, and no onward processing are separate claims.
OpenAI states that API data is not used for training by default, while API abuse-monitoring logs may
contain content for up to 30 days and some features keep application state
([API data controls](https://developers.openai.com/api/docs/guides/your-data)). `store: false` can
reduce application state for supported operations, but it is not ZDR.

OpenAI says Plus, Pro, Business, Enterprise, and Edu accounts do not have ads and advertisers do not
receive ChatGPT conversations or personal details
([Ads in ChatGPT](https://help.openai.com/en/articles/20001047)). Those statements do not establish
Codex retention or remove operational service-provider processing. The applicable privacy policy
describes disclosure to vendors and service providers and specified legal or business recipients
([OpenAI privacy policy](https://openai.com/policies/privacy-policy/)). Vision therefore records
these properties independently and never labels a route simply "private."

## Authentication, Revocation, and Isolation

- API credentials belong to a dedicated OpenAI project. They are stored through the supported OS
  credential facility, never prompts, logs, exports, repository files, or ordinary backups.
- Codex uses its documented interactive login. App Server supports account status, logout, and
  rate-limit reads. Vision must still verify what remote sessions or tokens remain after local
  logout before claiming full revocation.
- A Codex runtime receives a fresh sanitized workspace with no financial database, backups,
  transcript store, user home, inherited plugins, unrestricted tools, or reusable main-runtime
  credentials. Read-only access is insufficient because reads can disclose data.
- Provider logout, key deletion, local grant revocation, payload-history deletion, and mapping-key
  deletion are separate lifecycle operations. The user interface must report each result.

## Consequences

- Cloud assistance cannot be implemented by swapping the Ollama client in `aiChatService.js`.
- API and subscription feasibility, privacy, budget, and release gates are tested independently.
- The design remains useful even if Codex subscription embedding is unavailable: the API route can
  proceed without weakening the boundary, and local-only operation remains complete.
- Data minimization can reduce answer quality. Evaluation must compare utility using synthetic and
  approved data rather than asserting equivalent quality.
- No cloud profile can promise no third-party processing. Users who require that property must use
  local-only mode.

## Deferred and Unknown

The following are deliberately unresolved until a synthetic prototype and account-specific review:

- distributable desktop embedding and support terms for Codex SDK/App Server;
- exact ChatGPT plan, seat, workspace, model, and tool availability;
- effective Codex retention, deletion, caching, data residency, and subprocessor profile for the
  selected account;
- whether logout revokes every provider-side session or only clears local credentials;
- API organization eligibility for ZDR or Modified Abuse Monitoring and endpoint/model limits;
- cost ceilings, regional taxes, quota behavior, and rate-limit semantics at release time; and
- enforceable process/network isolation on each supported Vision platform.

Any unresolved item blocks only the affected cloud combination; it does not block local Vision.

## Supersession Boundary

This ADR does not enable cloud inference and does not change current runtime behavior. If an opt-in
cloud adapter ships later, this ADR supersedes ADR-024's blanket external-provider rejection only
for that explicitly granted route. ADR-024 continues to govern the local AI path.

## Related

- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat Integration]]
- [[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137: Shared Analysis Contract]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/features/ai-chat|AI Chat]]
