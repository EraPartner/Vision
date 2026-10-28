---
title: "ADR-248: Size Ollama requests to the prompt, the model and the Mac"
type: adr
status: accepted
date: 2026-10-24
tags: [adr, ai, ollama, performance, memory, macos]
description: "Accepted on 2026-10-24. Vision stops sending a fixed 8192-token window and all 41 tool schemas on every Ollama call. It sends the tools a question needs, sizes num_ctx in buckets from the prompt, the model's metadata and the Mac's RAM, keeps the model loaded while the chat page is open and lets it go after, steadies the history start for Ollama's prompt cache, and compacts tool results for the model. The Apple Foundation model keeps its own path."
aliases: [adr-248, ollama tuning, num_ctx, keep_alive, tool selection]
related_code:
  [
    "apps/node-backend/src/integrations/ollama/tuning.ts",
    "apps/node-backend/src/services/aiChat/requestPlan.ts",
    "apps/node-backend/src/services/aiChat/toolSelection.ts",
    "apps/node-backend/src/integrations/ollama/prompts.ts",
    "apps/node-backend/src/routes/ai.ts",
    "apps/frontend/src/hooks/useModelResidency.ts",
    "apps/node-backend/scripts/bench-ollama-tuning.ts",
  ]
---

# ADR-248: Size Ollama requests to the prompt, the model and the Mac

## Status

Accepted on 2026-10-24. Refines [[docs/adr/024-local-llm-chat|ADR-024]]. Leaves
[[docs/adr/246-apple-foundation-models-helper|ADR-246]] as it is.

## Date

2026-10-24

## Context

Phase C of the Mac optimisation plan: make local AI chat use less memory and answer sooner, on any
Mac and model (an 8B on a 16 GB Air up to a 70B on a 64 GB Mac), without taking away features.

What Vision sent before (read from code on main at 68d4bdf):

- `num_ctx` 8192 on every call, whatever the model or the RAM.
- All 41 tool schemas (19,285 characters) plus a 4,147-character system prompt on every tool-loop
  iteration.
- A 24,000-character history budget that did not count the schemas or the tool results added
  during a turn. One tool call could therefore push the prompt past 8192 tokens, and Ollama then
  drops the oldest messages without telling anyone. This is an estimate from the code (~3.5
  characters per token); `apps/node-backend/scripts/bench-ollama-tuning.ts` measures it.
- No `keep_alive`, so Ollama's default (5 minutes) applied. Nothing preloaded the model when the
  chat opened.

Vision does not start Ollama, so server settings such as flash attention, KV-cache type and
parallel slots are out of its reach. It controls only per-request `options` and `keep_alive`.

## Decision

1. **Tool selection** (`services/aiChat/toolSelection.ts`). A turn sends these tools:
   - the tools whose name and description share words with the question;
   - the whole area when the area is small (portfolio, planned, tax);
   - tools the conversation already used;
   - `getCategories`.

   A question that matches no tool gets all of them. The system prompt still lists every tool name.
   The dispatcher still runs any registered tool, and a called tool's schema is added for the rest
   of the turn.

2. **Context window** (`integrations/ollama/tuning.ts`). Each call gets the smallest bucket of 4k,
   8k, 16k or 32k that fits the estimated prompt plus 1,024 answer tokens.
   - The cap is the model's own context length.
   - The cap also comes from RAM: weights plus f16 KV cache, read from `/api/show` and `/api/tags`,
     must fit in 75% of RAM minus 4 GB. The cap is never below 8192.
   - A loaded model's window never steps down, because a change reloads the model. It resets when
     Vision unloads the model.
   - History is budgeted against that cap. An estimate above the cap is logged.
   - `OLLAMA_NUM_CTX`, when set, still pins the window.
3. **keep_alive**:
   - Chats send `"10m"`.
   - The chat page asks the backend to preload the model 2 s after opening, with the same window
     chats will use, and refreshes every 4 minutes while visible.
   - On leaving the page, the model is released. That means `keep_alive: 0` when its weights exceed
     a quarter of RAM, else `"2m"`.
   - On backend shutdown, models the backend loaded are released, within 1 s.
   - Embedding calls send `"1m"` so the embedding model does not stay resident next to the chat
     model.
4. **Prompt prefix**. Replayed history starts only at multiples of 8 rows, so the start of the
   prompt stays the same for several turns and Ollama can reuse its cache.
5. **Leaner tool results for the model**. The prompt copy changes; stored rows and the UI do not.
   - Empty fields are dropped.
   - Numbers with more than 4 decimals are rounded. Below 1 they keep 4 significant digits.
   - Chart column bindings in `meta` are dropped.
   - `num_predict` is 1,024.
6. **Measurement**.
   - Ollama's `load_duration`, `prompt_eval_duration` and `eval_duration`, plus the first-token
     time, are logged per iteration.
   - Settings shows the model's weight and context memory against the Mac's RAM, with a tip about
     Ollama's own `OLLAMA_FLASH_ATTENTION` and `OLLAMA_KV_CACHE_TYPE`.
   - `apps/node-backend/scripts/bench-ollama-tuning.ts` runs the local evaluation cases in the old
     and the new request shape, cold and warm.
7. **Apple Foundation model** (`apple-foundation`):
   - It gets all tools and the configured history budget.
   - Replay stays newest-first, the window stays fixed, and it gets no `keep_alive` or residency
     calls.
   - Its helper keeps trimming to its 4,096-token window.

## Consequences

- Fewer prompt tokens per call and no silent truncation. The size of the gain is measured on the
  Mac with the bench script, not claimed here.
- A question whose words miss the right tool relies on the model calling it by name from the
  system prompt list. The bench's tool-selection rate tracks this.
- Two new backend routes (`POST /api/ai/model/warm`, `POST /api/ai/model/release`) and one read
  route (`GET /api/ai/model/fit`).
- No CI jobs or CI time added.
