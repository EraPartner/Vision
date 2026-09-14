---
title: OpenAI and Codex Assistance Profiles
type: reference
status: active
date: 2026-09-12
updated: 2026-09-14
tags:
  [
    reference,
    ai,
    openai,
    codex,
    privacy,
    retention,
    cost,
    authentication,
    isolation,
  ]
description: Dated support matrix and fail-closed privacy profiles for future opt-in OpenAI API and Codex assistance in Vision.
aliases:
  [
    OpenAI privacy profiles,
    Codex privacy profiles,
    cloud assistance route matrix,
  ]
---

# OpenAI and Codex Assistance Profiles

> [!warning] Disabled by default
> ADR-145 implements the OpenAI API route, but configuration keeps it disabled by default. No call is
> authorized until the user inspects the exact payload and creates a grant naming the destination,
> route, purpose, fields, lifetime, and budget. Live synthetic acceptance and account entitlement
> verification remain release gates.

## Evidence Scope

Evidence was rechecked against official OpenAI documentation on 2026-09-12. These are dated product
and policy claims, not permanent guarantees. Recheck the selected account, workspace, endpoint,
model, tools, region, and terms before each release.

Primary sources:

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [API data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Enterprise privacy](https://openai.com/enterprise-privacy/)
- [ChatGPT data controls](https://help.openai.com/en/articles/7730893-chatgpt-data-controls-faq)
- [Ads in ChatGPT](https://help.openai.com/en/articles/20001047)
- [OpenAI privacy policy](https://openai.com/policies/privacy-policy/)
- [OpenAI subprocessor list](https://openai.com/policies/sub-processor-list/)
- [API pricing](https://developers.openai.com/api/docs/pricing)
- [ChatGPT and API billing](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-the-chatgpt-web-and-api-platform)

## Status Vocabulary

| Status      | Meaning                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Supported   | Official documentation supports the narrow stated capability; Vision may prototype it with synthetic data |
| Unsupported | Vision rejects the combination or official documentation contradicts the required assumption              |
| Unknown     | Official evidence is incomplete or account-specific; fail closed until verified                           |

"Supported" is not "enabled in Vision" and is never a transmission grant.

## Dated Route Matrix

| Capability                     | OpenAI API route                                                                               | Codex subscription route                                                           | Status and boundary                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Official programmatic surface  | OpenAI API SDK/HTTP endpoints                                                                  | Codex SDK or App Server                                                            | Supported as separate integration candidates                                                 |
| Authentication                 | Dedicated API organization/project credential                                                  | Documented ChatGPT browser or device-code login                                    | Supported; never copy cookies or read another runtime's auth cache                           |
| Generic Responses API access   | API key and API billing                                                                        | Not established by subscription login                                              | API supported; subscription-to-generic-API assumption unsupported                            |
| Account/plan discovery         | API project/org configuration                                                                  | App Server account state can report auth mode and plan type                        | Supported narrow discovery; actual entitlement remains a runtime fact                        |
| Revocation                     | Revoke key/project access plus revoke Vision grant                                             | App Server logout plus revoke Vision grant                                         | Local actions supported; complete provider-side session invalidation is unknown until tested |
| Usage visibility               | Local token/cost accounting and provider usage APIs where available                            | App Server exposes ChatGPT rate-limit state                                        | Supported candidate; exact limits and reset behavior are account-specific                    |
| Billing                        | Usage-based API pricing                                                                        | Subscription allowance or workspace credits                                        | Distinct; automatic subscription-to-paid-API fallback is unsupported                         |
| Default training               | API inputs/outputs are not used to train by default                                            | Depends on ChatGPT account/workspace settings and terms                            | API supported claim; selected subscription profile must be verified                          |
| Abuse monitoring               | Content may be retained up to 30 days by default                                               | Exact Codex/account behavior not fully specified by App Server docs                | API documented; subscription unknown for the selected account                                |
| Application state              | Endpoint/feature-specific; Responses storage, files, caches, tools, and background work differ | Thread/session/workspace behavior depends on Codex and ChatGPT configuration       | Must be enumerated; one global retention label is unsupported                                |
| `store: false`                 | Reduces supported API application state                                                        | Not an API control for subscription Codex                                          | Supported narrow API setting; ZDR claim from flag alone unsupported                          |
| ZDR                            | Approval- and endpoint-dependent                                                               | No parity established                                                              | API eligibility unknown; subscription ZDR claim unsupported                                  |
| Advertising                    | No advertising behavior is documented for this route                                           | OpenAI states Plus/Pro/Business/Enterprise/Edu have no ads                         | Do not use either narrow fact as a retention or disclosure proxy                             |
| Advertiser access              | No API claim needed for adapter                                                                | OpenAI states advertisers do not receive ChatGPT conversations or personal details | Supported narrow statement; not a no-disclosure guarantee                                    |
| Subprocessors/legal disclosure | Applicable OpenAI policy and contract                                                          | Applicable ChatGPT policy/workspace contract                                       | Processing exists; "no onward processing" is unsupported                                     |
| Tool access                    | Disable hosted tools unless individually reviewed                                              | Start with no browser, shell, plugins, connectors, or private mounts               | Required Vision boundary; platform enforcement remains to be proved                          |
| Filesystem isolation           | API adapter receives only typed payloads                                                       | Fresh sanitized workspace and constrained Codex sandbox                            | Design supported; cross-platform enforcement unknown until prototype                         |
| Real financial data            | Requires implemented boundary, release gates, and matching grant                               | Requires independent Codex isolation proof plus matching grant                     | Unsupported before those gates                                                               |
| Synthetic prototype            | Synthetic typed requests only                                                                  | Synthetic sanitized workspace only                                                 | Supported next step                                                                          |

### Source interpretation

The API data-control page says API inputs and outputs are not used for model improvement unless the
customer opts in. It separately says abuse-monitoring logs may include content and are retained for
up to 30 days by default. Its endpoint table gives `/v1/responses` distinct abuse-monitoring and
application-state rules and makes ZDR subject to approval and limitations. Therefore
`store: false` is not a zero-retention promise
([API data controls](https://developers.openai.com/api/docs/guides/your-data)).

Codex documents ChatGPT subscription authentication and API-key usage-based authentication as two
sign-in methods with different administrative and data-handling controls. It also states that an API
key uses standard API pricing rather than included ChatGPT plan credits
([Codex authentication](https://learn.chatgpt.com/docs/auth)).

App Server documents JSON-RPC account login for API keys, ChatGPT browser login, and device-code
login, plus logout and ChatGPT rate-limit reads. It also labels direct externally managed ChatGPT
token login experimental. Vision will not use that experimental mode unless a later ADR accepts its
auth lifecycle and support boundary
([Codex App Server](https://learn.chatgpt.com/docs/app-server)).

OpenAI states that business-product data is not used for training by default and that workspace
administrators can control retention for specified managed products. Those statements cannot be
generalized to every personal subscription
([Enterprise privacy](https://openai.com/enterprise-privacy/)). Consumer ChatGPT data controls can
disable training, but retained chat history and Temporary Chat have their own lifecycle
([ChatGPT data controls](https://help.openai.com/en/articles/7730893-chatgpt-data-controls-faq)).

OpenAI says advertisers do not receive conversations or personal details and specified paid plans
do not have ads. This addresses advertiser access, not all vendor, service-provider, affiliate,
legal, safety, or business-transfer disclosures described by the privacy policy
([Ads in ChatGPT](https://help.openai.com/en/articles/20001047),
[OpenAI privacy policy](https://openai.com/policies/privacy-policy/)).

## Privacy Profiles

### P0 - Local only

| Property                        | Decision                                              |
| ------------------------------- | ----------------------------------------------------- |
| Provider transmission           | No OpenAI or Codex cloud request                      |
| Authentication                  | Existing local Ollama configuration                   |
| Provider retention/training/ads | Not applicable                                        |
| Local retention                 | Recoverable investigation until its explicit deletion |
| Cost                            | No OpenAI or Codex cost                               |
| Status                          | Supported current behavior and default                |

Use P0 whenever no third-party processing is acceptable.

### P1 - Cloud plan over public or generic structure

| Property             | Decision                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Permitted payload    | Generic analysis question, public schema vocabulary, or public company/topic                                  |
| Forbidden payload    | Financial rows/values, holdings, ownership, broker, private filenames, identifiers, free-text notes, mappings |
| Execution            | Cloud proposes a typed plan; Vision validates and executes locally                                            |
| Retention assumption | Entire outbound payload may be retained under the active route's policy                                       |
| Cost                 | Explicit per-route budget; no silent fallback                                                                 |
| Status               | Implemented behind disabled configuration; live synthetic and entitlement release gates remain                |

P1 is the first useful cloud slice because it can improve planning while keeping financial results
local. Schema labels and user-defined categories are private unless explicitly classified public.

### P2 - OpenAI API minimized summary

| Property          | Decision                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Route             | Dedicated API project and selected endpoint/model                                                       |
| Permitted payload | Explicitly reviewed aggregate or excerpt within a cumulative disclosure budget                          |
| Capability        | Either bounded plan ordering from a selected summary or final synthesis from distinct selected evidence |
| Storage           | Request minimum application state; enumerate cache, tool, file, and background-operation behavior       |
| Training          | Verify organization sharing remains off                                                                 |
| Retention         | Display documented abuse and application-state windows; never reduce them to `store: false`             |
| Revocation        | Revoke Vision grant and provider credential separately                                                  |
| Cost              | Hard local spend ceiling and local usage accounting                                                     |
| Status            | Implemented behind disabled configuration; release still requires live and privacy acceptance           |

Final synthesis uses the separate `cloud-synthesis-selected` grant and `selectedEvidence` field.
It skips local tools and local-model inference, supplies no OpenAI tools, and never falls back to
local synthesis after a provider failure. This is intentional disclosure, not sanitization. The
public-question and selected-summary planning profiles remain available and continue to synthesize
locally. Every recoverable investigation retains its local input and result until deletion; for
selected-evidence synthesis, this includes the exact evidence. The separate disclosure log keeps a
digest and policy metadata rather than the exact payload.

The UI model picker contains only the API models configured by the Vision operator. Each entry has
its own input/output price, and the server rejects an identifier outside the catalog before preview
or transmission. The selected model is part of the digest-bound request. This picker cannot spend a
ChatGPT subscription or ChatGPT usage credits because ChatGPT and API billing are separate.

### P3 - OpenAI API approved ZDR

| Property             | Decision                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| Eligibility          | Must be verified for the exact organization/project                        |
| Endpoint/model/tools | Every capability must be ZDR eligible at request time                      |
| Evidence             | Read back effective provider settings; do not infer from a request flag    |
| Exceptions           | Surface documented safety, legal, image/file, and feature limitations      |
| Status               | Unknown and unavailable unless approval and exact compatibility are proved |

P3 is not the default API profile and cannot be offered optimistically.

### P4 - Isolated Codex subscription planning

| Property   | Decision                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Route      | Documented Codex SDK/App Server with ChatGPT login                                                     |
| Workspace  | Fresh synthetic or sanitized directory with no financial mounts or inherited context                   |
| Tools      | Browser, shell, plugins, connectors, files, and outbound routes disabled unless individually approved  |
| Retention  | Account/workspace-specific and displayed as unknown until verified                                     |
| Revocation | App Server logout, local grant removal, workspace disposal, and credential cleanup are separate checks |
| Cost       | Subscription limits/credits only; never switch to an API key automatically                             |
| Status     | Synthetic-only candidate; private payloads blocked pending independent isolation and policy proof      |

### P5 - No retention or no third-party processing

No OpenAI or Codex cloud route satisfies a blanket "no third-party processing" requirement because
the provider necessarily receives released plaintext. A "no retention" label is also unavailable
without exact, current, account- and capability-specific evidence. P0 is the only supported profile
for the stronger no-third-party-processing requirement.

## Authentication and Revocation Checklist

Before a route can leave synthetic mode:

- show the destination, authentication kind, active account/workspace or API project, and plan;
- store credentials only in the supported OS credential store;
- never import cookies or reuse the user's main Codex runtime state;
- verify least privilege and remove access on logout, account switch, or grant expiry;
- treat provider credential revocation and Vision consent revocation as separate operations;
- verify post-logout account state and dispose of the isolated runtime;
- document remote-session, audit-log, payload, cache, mapping, backup, and deletion behavior; and
- fail closed when status cannot be read.

## Cost and Availability Profile

- P0 remains free-only and fully usable.
- API use has an explicit local currency or token budget per job and billing period. The adapter
  stops before exceeding the local ceiling even if the provider would accept more requests.
- Codex use reports the active subscription/workspace and observed limits. Exhaustion fails locally
  or offers an explicitly selected P0 continuation.
- Vision never converts subscription exhaustion into paid API traffic.
- Prices, included usage, plans, taxes, regions, and quotas are release-time facts. Recheck
  [API pricing](https://developers.openai.com/api/docs/pricing) and the authenticated account rather than storing
  policy claims as constants.

## Isolation Acceptance Gate

A Codex prototype passes isolation only when tests show that the child runtime cannot read or infer:

- the Vision database, backups, logs, local AI transcripts, or generated reports;
- the user's home, repository checkout, unrelated workspaces, environment, clipboard, or browser;
- host Codex credentials, configuration, memories, plugins, skills, or prior sessions; and
- network destinations outside the explicit provider route.

The prototype must also prove that unknown tool requests, path traversal, symlinks, subprocesses,
retries, crash reports, telemetry, and support bundles do not widen disclosure. A read-only mount
fails this gate because reading sensitive data is itself disclosure.

## Release Gate

Real data remains blocked until all of the following pass for one exact route/profile combination:

1. the typed disclosure controller and cumulative-disclosure accounting;
2. exact outbound preview and scoped, revocable consent;
3. local-only execution of private calculations;
4. route-specific auth, logout, credential, retention, caching, tool, and deletion tests;
5. hard cost and retry limits;
6. adversarial privacy tests and usefulness evaluation;
7. independent isolation review for Codex; and
8. updated local-only feature and security documentation when runtime behavior changes.

Passing the API gate does not pass the Codex gate, and passing a synthetic test does not authorize
transmission.

## Explicit Unknowns

- Which personal and managed ChatGPT plans permit the intended embedded Codex workflow at release?
- Which models and tools are available under each authenticated route and region?
- What exact retention, deletion, cache, safety-review, and data-residency policy applies to the
  selected Codex account and thread type?
- Does App Server logout invalidate all relevant provider-side sessions or only local state?
- May Vision redistribute or bundle the required Codex components on every supported platform?
- Can the platform-specific sandbox and network boundary meet the isolation gate?
- Is the chosen API project approved for ZDR or Modified Abuse Monitoring, and do all selected
  endpoints, models, inputs, and tools remain eligible?
- What authenticated prices, taxes, usage limits, and workspace credits apply at release?

Each unknown blocks only the dependent combination. None weakens P0.

## Related

- [[docs/adr/138-openai-codex-assistance-boundary|ADR-138: OpenAI and Codex Assistance Boundary]]
- [[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137: Shared Analysis Contract]]
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat Integration]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/features/ai-chat|AI Chat]]
