---
title: AI Assistance Evaluation
type: security
status: active
date: 2026-10-28
updated: 2026-10-28
tags: [security, ai, evaluation, ollama, privacy, prompt-injection]
description: Reproducible local-AI reliability evaluation gate, current evidence, and release blockers.
aliases: [AI evaluation, local AI reliability]
related_code:
  - apps/node-backend/src/services/aiEvaluation/
  - apps/node-backend/scripts/evaluate-local-ai.ts
---

# AI Assistance Evaluation

This page records what the evaluation harness proves and what still requires live runtime evidence.
Passing synthetic tests is bounded evidence. It is not proof of correct behavior for inputs outside
the case set.

## Current Verdict

> [!note] Cloud assistance removed
> The cloud privacy harness, its Seatbelt smoke and the Codex evaluation scripts were removed with
> the OpenAI API route and the Codex experiment
> ([[docs/adr/229-remove-cloud-ai-codex-and-agentcloak|ADR-229]]). Only the local Ollama gate
> remains.

| Boundary              | Evidence through 2026-09-20                                                                                                                                                                                                                                                                                           | Historical release status (2026-09-20)                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Local Ollama analysis | Eight fixed-oracle cases cover tool choice, arguments, grounding, abstention, partial failure, follow-up scope, and direct or indirect prompt injection. Unit tests pass. A one-repeat `llama3.1:8b` run used 5.8 GB resident memory but reached 67.6 seconds p95 latency and failed unsupported-research abstention. | Reject `llama3.1:8b` as the default on the target machine. Test a smaller candidate before enabling a default. |

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

Acceptance thresholds are versioned in `localReliability.ts`: 95% completion, 90% tool selection,
90% scope interpretation, 100% grounded numeric values, 95% source support, 90% abstention, 100%
prompt-injection resistance, 90% partial-failure handling, 90% follow-up preservation, at most 45
seconds p95 latency, and at most 12 GiB resident model memory. A missing local model fails visibly;
there is no remote fallback.

The telemetry uses Ollama's official local APIs: [chat](https://docs.ollama.com/api/chat),
[response timings](https://docs.ollama.com/api/usage), and
[running-model memory](https://docs.ollama.com/api/ps). Tool interaction follows Ollama's
[tool-calling contract](https://docs.ollama.com/capabilities/tool-calling).

## Release Gate

A model becomes the default only after it meets every threshold above on the target machine. Re-run
the suite when prompts, tools, context limits, or candidate models change.

## Related

- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/adr/229-remove-cloud-ai-codex-and-agentcloak|ADR-229]]
