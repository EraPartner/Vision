---
title: "ADR-246: Apple Foundation Models through a small Swift helper"
type: adr
status: accepted
date: 2026-10-22
tags: [adr, ai, ollama, apple-foundation-models, swift, packaging, macos]
description: "Accepted on 2026-10-22. Apple's on-device Foundation Models become one more model next to Ollama. A ~170-line Swift helper (vision-apple-ai) reads an Ollama /api/chat body on stdin and writes an Ollama-shaped reply, so the existing Ollama client serves it; the backend trims each request to the model's 4,096-token window. The helper is built at release time on the Mac, not in CI."
aliases: [adr-246, apple foundation models, vision-apple-ai, apple intelligence]
related_code:
  [
    "packaging/electron/apple-ai/main.swift",
    "apps/node-backend/src/integrations/ollama/appleFoundation.ts",
    "apps/node-backend/src/integrations/ollama/client.ts",
    "packaging/electron/scripts/prepare-native-runtime.ts",
  ]
---

# ADR-246: Apple Foundation Models through a small Swift helper

## Status

Accepted on 2026-10-22. Extends [[docs/adr/024-local-llm-chat|ADR-024]]; Ollama stays as it is.
This is not a return to the Swift port retired in
[[docs/adr/214-retire-vision-native-swift-port|ADR-214]]: the helper has no UI and no app logic.

## Date

2026-10-22

## Context

Tor wanted Apple's on-device Foundation Models as an AI option next to Ollama, never replacing
it. The framework is Swift-only. Tor chose a Swift helper, as small as possible.

## Decision

- `packaging/electron/apple-ai/main.swift` builds `vision-apple-ai`. It reads an Ollama
  `/api/chat` body on stdin and writes the Ollama reply shape on stdout (one JSON object, or NDJSON
  when `stream` is true). `--check` prints whether the model is available. Vision's tool schemas
  become Foundation Models tools; when the model calls one, the helper ends the turn with Ollama
  `tool_calls`, and the backend's existing loop runs the tool and calls again with the result.
- `apps/node-backend/src/integrations/ollama/appleFoundation.ts` wraps the Ollama client's fetch.
  A chat for the model `apple-foundation` runs the helper; `/api/tags` adds that model when the
  helper reports it available (also when Ollama is not running); everything else goes to Ollama.
- The Apple model has a 4,096-token window for instructions, tools, prompt and answer. Requests to
  it keep the system prompt, the newest messages up to 4,000 characters, and at most three tools
  whose names and descriptions share words with the last question.
- The helper is compiled and ad-hoc signed by `prepare-native-runtime.ts` on macOS with
  `xcrun swiftc` (Xcode 26 SDK) into the native runtime, next to `vision-backend`. CI does not
  build it, so CI time is unchanged. The backend finds it at `VISION_RUNTIME_ROOT/vision-apple-ai`
  or at `APPLE_AI_HELPER`.
- Ollama error bodies (`{"error": ...}`) are now kept in the error message, and an error line in
  a stream fails the turn with code `PROVIDER_ERROR`.

## Consequences

- Release builds need Xcode 26. On macOS before 26 the helper cannot start and the model is not
  listed.
- The helper reports no token counts, so usage fields are empty for Apple answers.
- `format` (JSON schema output) is ignored for the Apple model; callers that require JSON may
  reject its answers.
- Answer quality for financial questions is unverified until Tor tries it.
