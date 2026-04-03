---
title: ADR 007 - Streaming Import with Server-Sent Events
type: adr
status: Accepted
date: 2026-04-02
tags: [architecture, imports, streaming, sse, performance]
description: Decision to implement streaming CSV imports using Server-Sent Events for real-time progress feedback
aliases: [streaming imports, SSE, server-sent events, large file imports]
related_code: ["apps/node-backend/src/services/streamingImportService.js", "apps/node-backend/src/routes/importRoutes.js"]
---

# ADR-007: Streaming Import with Server-Sent Events

## Status
Accepted

## Date
2026-03-20

## Context

Large CSV imports (10,000+ rows) present UX challenges:
1. **Long wait times** — users don't know if import is progressing
2. **Timeout risk** — HTTP requests may timeout for large files
3. **No partial results** — all-or-nothing feedback
4. **Memory pressure** — loading entire file into memory

## Decision

Implement **streaming imports** using **Server-Sent Events (SSE)**:

### Architecture

```
Client                    Server
  │                         │
  │── POST /import/csv/stream ──▶│
  │                         │
  │◀── event: progress ──────│  { processed: 100, total: 5000 }
  │◀── event: progress ──────│  { processed: 500, total: 5000 }
  │◀── event: progress ──────│  { processed: 1000, total: 5000 }
  │◀── event: complete ──────│  { imported: 4950, duplicates: 50 }
  │                         │
```

### Implementation

1. **Chunked reading** — CSV parsed in chunks (not loaded entirely)
2. **SSE events** — progress sent to client every N rows
3. **Streaming processing** — each chunk processed independently
4. **Deduplication** — hash-based dedup per chunk

### Fallback

Regular (non-streaming) import remains available for small files.

## Consequences

### Positive
- **Real-time feedback** — users see progress
- **No timeout** — SSE connection stays open
- **Memory efficient** — chunked processing
- **Cancelable** — client can abort mid-import

### Negative
- **Complexity** — SSE adds implementation overhead
- **Browser support** — SSE not supported in all environments (but fine for Electron)
- **Error handling** — partial failures harder to communicate

## Related

- [[docs/features/import]] — Import feature documentation
- [[docs/diagrams/import-pipeline.puml]] — Import pipeline diagram
- [[docs/diagrams/import-sequence.puml]] — Import sequence diagram
