---
title: ADR-108 Detection-layer / narration-layer split for local-LLM insights
type: adr
status: accepted
date: 2026-07-11
tags: [adr, ai, llm, ollama, insights, anomaly-detection, privacy, no-external-calls, detection-layer, narration-layer, statistics, adr-024]
description: Splits the AI insight / anomaly agent into a deterministic detection layer that runs automatically on page load (plain code, no LLM) and a local-LLM narration layer gated behind an explicit user click. Records why a scheduled background narration job was rejected, why that rejection is scoped to narration only, the Statistics-panel + button-badge surfacing decision, the server-side pre-call approach for the narration tool, and the extension of ADR-024's no-external-calls guarantee (and its CI fetch-spy test) to the new narration tool.
aliases: [insight agent, anomaly agent, detection narration split, insightsDigest, adr-108]
---

# ADR-108: Detection-layer / narration-layer split for local-LLM insights

## Status
Accepted — 2026-07-11 (decision record for the AI insight / anomaly agent feature; the detection
service, insights tool, surfacing UI, and narration button are built in follow-up steps). Builds on
and does not weaken [[docs/adr/024-local-llm-chat|ADR-024]].

## Context

Vision computes rich financial signals (recurring-payment patterns, category spend, cash-flow
forecasts) but surfaces most of them only when the user goes looking. An "AI insight / anomaly agent"
was scoped to proactively surface the noteworthy ones — new subscriptions, price creep on existing
subscriptions, category spend outliers, month-end cash shortfalls — and to let the user ask a local
model to explain and prioritize them in plain language.

The dangerous design mistake here is to treat the whole feature as one "AI" thing gated behind one
switch. The two responsibilities have completely different **cost classes**, and conflating them
either over-gates cheap deterministic work behind a click or, worse, silently spends local inference
on the user's machine without them asking for it.

**Privacy constraint (non-negotiable, inherited from ADR-024):** any model use is the local Ollama
integration only (`apps/node-backend/src/integrations/ollama/`). Transactions never leave the box —
not even for "non-sensitive synthesis." This ADR must extend that guarantee to whatever new surface
the feature adds, never carve an exception into it.

An earlier iteration of this feature (brainstormed 2026-07-01) proposed a **scheduled background job**
that would periodically run the model to pre-narrate insights so they were "ready" when the user
arrived. That design was dropped, and the reason needs to be recorded so a future reader does not
reintroduce it — and, just as importantly, does not over-correct by gating the cheap deterministic
half behind a click too.

## Decision

### 1. Two independent layers, split by cost — not one feature behind one switch

**Detection layer (deterministic, runs automatically on page load).** Every *finding* — new
subscription, price change, category outlier, cash-forecast figure — is computed by plain code: the
recurring-pattern diff (`recurringDetectionService`), a modified-z-score category outlier detector,
and the cached Monte-Carlo cash-flow forecast. No LLM is involved, the output is fully reproducible,
and there is **zero hallucination risk**. This is the same cost class as any other page in the app
(`recurringDetectionService` already runs synchronously on page views today), so there is no privacy
or hardware concern in running it automatically. It surfaces directly in the UI with no model
involvement whatsoever.

**Narration layer (local LLM, on-demand only).** A local model explains, prioritizes, and phrases the
already-computed findings. This is the **only** part that spends inference, and it is therefore the
**only** part gated behind an explicit user action (a button click). It never runs unprompted on any
hardware.

The two layers meet at exactly one interface: the detection layer is also exposed as a single
read-only tool (working name `insightsDigest`) in
`apps/node-backend/src/services/aiChat/tools/insights.js`, alongside the existing
`getRecurringDetected` / `getSpendingPace` / `getRecipientInsights` tools, so the narration layer
reads the *same* precomputed findings rather than recomputing (and possibly diverging from) them. The
tool's return contract is the sole cross-layer interface:

```
{
  subscriptionCreep: { new: [...], priceChanges: [...] },
  categoryOutliers: [...],
  cashForecast: {...}
}
```

Each finding array is pre-capped to its per-item limit and contains **undismissed findings only** —
dismissal is a detection-layer concept, so the narration layer never even sees a dismissed finding.

### 2. The scheduled-background-narration job is rejected — and that rejection is scoped to narration only

A scheduled/background job that runs the **model** was rejected because it would spend local inference
**unprompted, on unknown hardware**. Vision runs on whatever machine the user installed it on; kicking
off an LLM turn on a timer can peg a laptop's CPU/GPU, drain battery, and spin fans with no user
action behind it. Inference is only ever acceptable as the direct, immediate consequence of an
explicit user click.

**This reasoning does not extend to the detection layer.** A future reader must not assume the whole
feature is gated behind a click. Detection is plain code with the same cost profile as rendering any
other page, so running it automatically on relevant page views (and a lightweight badge check
elsewhere) is fine and is in fact the design. The "no unprompted work" rule is about *inference cost*,
not about *the feature*.

### 3. Surfacing: Statistics-page panel + button badge — no new dashboard banner or card

Findings surface as a panel on the **Statistics page** (reusing the Card / expand-collapse / X-button
UI pattern of `RecurringDetectionPanel.tsx`, with new per-finding dismiss tracking underneath) plus a
**badge on the entry button** that reflects the count of *undismissed* findings — the exact predicate
the panel filters on, cleared when a finding is dismissed, not merely when the page is opened. The
badge reads a persisted count from the same cached detection results the panel renders, so checking it
from elsewhere (e.g. the AI-chat page) never re-runs detection just to draw a dot.

A new **dashboard banner or card was explicitly rejected**, for two reasons found by direct
inspection:
1. `FxStatusBanner` and `UpcomingPaymentsNotification` already render on every page via
   `AppLayout.tsx` and simply stack with no priority/arbiter mechanism. A third always-on notice
   repeats that problem app-wide, not just on the dashboard.
2. `SuggestionCard` was already removed from the dashboard once (commit `6785a3eb`) specifically for
   being "redundant — the upcoming-payments banner already covers every page." Adding a new dashboard
   card here would re-earn the same objection.

### 4. Narration tool-call reliability: server-side pre-call (the model only narrates)

Forcing the model to call one specific tool for one specific prompt is genuinely unsolved in this
codebase — `prompts.js` only does soft, generic steering. Rather than rely on the model *deciding* to
fetch, the narration button uses a **server-side pre-call**: the `insightsDigest` tool is executed
server-side *before* the model turn and its result is fed into the model's context, so the model only
ever **narrates** the already-fetched findings — it never decides whether to fetch. This is the most
reliable of the three options considered (soft prompt hint / Ollama forced `tool_choice` / server-side
pre-call) because it removes the model's discretion from the critical path entirely, which matches the
core ADR-024 rule: **the model never cites a figure not returned by a tool.** The button itself sends
a fixed prompt into a normal interactive chat turn; the reply lands as an ordinary assistant message
(existing `ToolResultCard` rendering) in whichever conversation the user clicked from — no pinned
system conversation. The user's already-configured default model
(`OLLAMA_DEFAULT_MODEL` / conversation model) is reused; there is no new model-selection UI for v1.

### 5. The no-external-calls guarantee extends to the narration tool

ADR-024's guarantee — the service layer contacts only the configured Ollama host, no path reaches
OpenAI/Anthropic/Google/etc. (`docs/security/ai-data-access.md`) — **applies unchanged to the
narration layer**. The narration tool adds no new outbound-HTTP surface: it reads precomputed local
findings and calls the same local Ollama client. The existing CI enforcement is extended to cover it:
the `describe('no-external-calls guarantee')` fetch-spy test in
`apps/node-backend/tests/aiChatService.test.js` (spies on `global.fetch` across a full chat flow and
fails if any call is made while `ollamaClient` is injected as a mock) must also exercise the
insights-narration path — including the server-side pre-call of §4 — so that dispatching the new tool
proves it makes **zero** outbound `fetch` calls. The detection layer never touches an LLM at all, so
it is outside this guarantee's scope by construction.

## Consequences

### Positive
- **No unprompted inference.** Local inference happens only as the direct result of a click; the
  timer-driven design that could peg an arbitrary user's machine is off the table and documented as
  such.
- **Cheap signals stay cheap and always-on.** Deterministic detection runs like any other page, so
  users see findings without having to ask, with no hallucination risk and no privacy cost.
- **Single source of truth between layers.** The `insightsDigest` return contract is the one interface
  two engineers can build either side against without diverging; the narrator can never invent a
  number because it only ever sees precomputed, tool-returned findings.
- **Privacy posture preserved and CI-enforced.** The no-external-calls guarantee and its fetch-spy
  test extend to the new surface; nothing about "AI insights" weakens ADR-024.
- **No notification sprawl.** Surfacing lives in one Statistics panel + one button badge, avoiding the
  un-arbitrated always-on banner stack the codebase already suffers from.

### Neutral
- **Detection now runs on every Statistics-page view**, not just behind a click — see the dependency
  below.
- **Narration quality depends on the user's local model** (same hardware-dependency caveat as
  ADR-024). The server-side pre-call removes fetch-decision unreliability but not phrasing quality.

### Negative
- **Detection frequency promotes an existing perf finding to a prerequisite.** Because detection now
  runs on every Statistics-page view rather than on demand, the existing
  "`GET /api/info/recurring-patterns` does uncached synchronous recomputation" finding moves from
  optional cleanup to a **blocking prerequisite**, and the new category-outlier detector must ship
  with the same caching from day one — do not add a second uncached hot path next to the fix for the
  first.

## Alternatives Considered

- **One feature behind one switch (fully click-gated).** Rejected — over-gates the cheap deterministic
  half, hiding always-safe findings behind a click for no reason.
- **Scheduled background narration job.** Rejected — spends local inference unprompted on unknown
  hardware. See §2. Detection-only scheduling is not needed because detection is cheap enough to run
  inline on page view.
- **New dashboard banner / card for findings.** Rejected — un-arbitrated banner stacking and the
  `SuggestionCard` `6785a3eb` precedent. See §3.
- **Soft prompt hint or Ollama forced `tool_choice` for the narration tool.** Not chosen — the
  server-side pre-call (§4) is strictly more reliable because it removes the model's fetch decision
  from the path entirely.
- **Let the narrator read raw transactions / compute its own numbers.** Rejected — reintroduces
  hallucination risk that ADR-024's tool-calling architecture exists to eliminate.

## Related
- [[docs/adr/024-local-llm-chat|ADR-024: Local LLM Chat Integration]] — tool-calling architecture,
  privacy constraint, and no-external-calls guarantee this ADR builds on
- [[docs/adr/083-internal-transfer-detection|ADR-083: Internal Transfer Detection]] — precedent for a
  deterministic detection service surfaced in the UI
- [[docs/security/ai-data-access|AI Data Access Policy]] — no-external-calls guarantee + CI fetch-spy
  enforcement extended here
- [[docs/adr/index|All ADRs]]
