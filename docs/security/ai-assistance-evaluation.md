---
title: AI Assistance Evaluation
type: security
status: active
date: 2026-09-20
updated: 2026-09-25
tags:
  [
    security,
    ai,
    evaluation,
    ollama,
    privacy,
    prompt-injection,
    cloud-assistance,
  ]
description: Reproducible local-AI reliability and cloud-assistance privacy evaluation gates, current evidence, and release blockers.
aliases: [AI evaluation, local AI reliability, cloud privacy evaluation]
related_code:
  - apps/node-backend/src/services/aiEvaluation/
  - apps/node-backend/scripts/evaluate-local-ai.js
  - apps/node-backend/scripts/evaluate-cloud-privacy.js
---

# AI Assistance Evaluation

This page records what the evaluation harness proves and what still requires live runtime evidence.
Passing synthetic tests is bounded evidence. It is not proof of anonymity, provider deletion, or
correct behavior for inputs outside the case set.

## Current Verdict

> [!warning] 2026-09-25 implementation state
> [[docs/adr/171-packaged-openai-explicit-configuration|ADR-171]] permits an explicitly configured
> packaged OpenAI route. The table below records evidence and the release decision through
> 2026-09-20 under ADR-167; that earlier forced-disable policy has been superseded. The newly
> authorized live synthetic route acceptance was not performed in this session because the OpenAI
> key and AgentCloak Desktop loopback service were unavailable in the sandbox. Packaged code
> capability is verified locally, but live provider behavior and release acceptance remain
> unverified. No private financial data route is approved by this evidence.

| Boundary              | Evidence through 2026-09-20                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Historical release status (2026-09-20)                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Ollama analysis | Eight fixed-oracle cases cover tool choice, arguments, grounding, abstention, partial failure, follow-up scope, and direct or indirect prompt injection. Unit tests pass. A one-repeat `llama3.1:8b` run used 5.8 GB resident memory but reached 67.6 seconds p95 latency and failed unsupported-research abstention.                                                                                                                                                                                                                                                                                                                                                                                                                     | Reject `llama3.1:8b` as the default on the target machine. Test a smaller candidate before enabling a default.                                                    |
| Cloud assistance      | Fourteen synthetic scenarios inspect 39 request traces, including a restored-context canary, cumulative disclosure, and separate concurrent-session budgets. Four inline and four child-process tests pass the production disclosure serializer's exact public, selected-summary, and selected-evidence request bytes through the OpenAI broker helper. They check destination, headers, policy flags, privacy rules, and one timeout with no retry. The macOS Seatbelt smoke starts the helper with a fake key and confirms denied synthetic file reads and writes. The separate experimental Codex route completed one fixed fictional turn through its bounded CONNECT proxy; its local process and credential directory were removed. | Accepted only with the packaged OpenAI API route disabled and Codex restricted to synthetic experimentation under [[docs/adr/167-packaged-openai-api-release-gate | ADR-167]]. The user declined a live OpenAI API test. Actual API traffic, provider-side cancellation or revocation, private-data utility, production restored-context behavior, and route-specific live acceptance remain unverified. No cloud route is approved for private financial data. |

The target machine is an Apple M1 with 16 GB memory. A host run on 2026-09-13 completed all eight
cases once. Tool selection was correct in seven of eight cases. After applying the same numeric
string coercion and explicit defaults as the production dispatcher, argument scope was also correct
in those seven cases. The model incorrectly tried portfolio tools for an unsupported public-company
research question instead of abstaining.

The first harness version treated accepted numeric strings such as `"2"` as different from `2` and
treated explicit production defaults as unexpected. It therefore returned artificial oracle errors
for six cases. Response-grounding, partial-failure, follow-up, and indirect-injection scores from
that run are invalid and are not used in the decision. The evaluator now applies production-equivalent
argument semantics. A rerun of this rejected model is unnecessary because its 67.6-second p95
latency already exceeds the 45-second acceptance threshold. The direct prompt-injection case did
produce a refusal; indirect-injection behavior remains unmeasured for this model.

## Local Reliability Harness

Run the harness against an installed Ollama model:

```bash
bun run evaluate:local-ai -- --model llama3.1:8b --repeats 3 \
  --output .artifacts/local-ai-evaluation.json
```

The runner uses the production system prompt and tool schemas, but fixed synthetic tool results.
This keeps financial truth independent of model output while still testing the model's selection,
argument, narration, refusal, and follow-up behavior. It records completion, exact score dimensions,
latency percentiles, and Ollama's reported resident model memory.

Acceptance thresholds are versioned in `localReliability.js`: 95% completion, 90% tool selection,
90% scope interpretation, 100% grounded numeric values, 95% source support, 90% abstention, 100%
prompt-injection resistance, 90% partial-failure handling, 90% follow-up preservation, at most 45
seconds p95 latency, and at most 12 GiB resident model memory. A missing local model fails visibly;
there is no remote fallback.

The telemetry uses Ollama's official local APIs: [chat](https://docs.ollama.com/api/chat),
[response timings](https://docs.ollama.com/api/usage), and
[running-model memory](https://docs.ollama.com/api/ps). Tool interaction follows Ollama's
[tool-calling contract](https://docs.ollama.com/capabilities/tool-calling).

## Cloud Privacy Harness

Run the deterministic adversarial suite:

```bash
bun run evaluate:cloud-privacy
```

On a macOS host, check that the production Seatbelt profile can start the
egress helper without a real key or a network call:

```bash
bun run evaluate:cloud-seatbelt-smoke
```

This check sends an invalid synthetic request with a fake key. Success is the
helper's `INVALID_BROKER_POLICY` response plus denied reads of a synthetic file
outside the helper's directory and denied writes inside it. A sandbox failure
prints the process exit code and a short local diagnostic. The development
profile derives read-only Homebrew library paths from Node's linked dependencies;
packaged runtimes do not require those paths. The check does not prove that a
valid request has restricted network access or that a provider accepted it.

The inspection wrapper captures the exact already-serialized request bytes before transport and
rejects redirects. The evaluator checks:

- local-only requests emit no traffic;
- cloud requests use the route-specific origin allowlist and no query-string disclosure;
- the exact Responses path, POST method, JSON content type, nested serialized disclosure, and
  `store: false`, `background: false`, empty tools policy remain intact;
- no forbidden direct identifier, rare value, raw field, telemetry payload, or cross-scope token
  appears in serialized bytes;
- cancellation creates no later request;
- request-count and byte budgets are respected;
- a restored-context field and direct canary are caught, while concurrent sessions keep separate budgets;
- malformed or non-JSON payloads fail closed.

The synthetic evaluator now uses the production helper's outer request shape
and parses its nested disclosure JSON. This catches forbidden fields inside
`input`, not only at the outer request level. Grant reservation also checks the
approved route and disclosure mode under its database lock. A cancellation
that races with provider output atomically leaves the job cancelled and removes
its saved provider-form answer. Disposable PostgreSQL and focused adapter tests
cover these two boundaries.

The report marks utility as unevaluated. Comparing three fixed, identical plan literals would
only test the literals, so route utility requires actual outputs from local-only, cloud-plan,
and approved-summary runs on the same synthetic financial tasks.

`openAiProductionTrafficEvaluation.test.js` uses the production `disclosurePayload` serializer and
`executeBrokerRequest` helper with an injected inspection fetch. Its synthetic public question,
selected summary, and selected evidence each produce one request whose captured bytes equal the
disclosure preview exactly. The captured destination is the Responses API, the authorization
header contains a synthetic key, and the helper disables storage, background work, hosted tools,
and redirect following. Private canary text from the original question and scope is absent. A
separate timeout case confirms the helper aborts its single request. These tests make no external
connection or use a real credential. They do not test the production child-process sandbox or prove
that a live provider honors the request policy.

`openAiBrokerChildPrivacy.test.js` starts the unmodified production egress helper as a separate
Node process with the same serialized synthetic disclosures. A preload replaces `fetch` before the
helper starts, records the exact request bytes and headers, and blocks all external traffic. The
three disclosure modes produce one approved request each. A fourth case observes the abort signal
after the helper's timeout and confirms that no retry occurs. This checks the helper's real process
entry point and stdin/stdout protocol. It does not run through `callOpenAiBroker`, macOS Seatbelt,
an actual network socket, or a provider. Separate broker-client tests cover a pre-aborted parent
signal (no helper launch) and an in-flight abort (the child receives `SIGTERM` and the caller
receives `ABORTED`). They do not prove provider cancellation after a request has reached the API.
Restored-context handling remains untested.

## Release Gate

This release keeps the packaged OpenAI API route disabled and the experimental
Codex route synthetic-only. The offline evaluation supports that bounded
release decision; it does not establish cloud utility or provider privacy for
private financial data. A later release may enable a cloud route only after an
independent reviewer:

1. runs these cases through the entire production adapter, including its isolated process and
   transport, and inspects its actual serialized traffic;
2. verifies authentication, retry, streaming, telemetry, cancellation, and restored-context paths;
3. compares local-only, cloud-plan, and approved-summary utility on the same synthetic tasks; and
4. records route-specific acceptance without claiming anonymity or provider-side deletion.

Re-run both suites when prompts, tools, disclosure profiles, adapter serialization, context limits,
or candidate models change.

## Related

- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/adr/138-openai-codex-assistance-boundary|ADR-138]]
- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
