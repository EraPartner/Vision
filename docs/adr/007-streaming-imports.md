---
title: ADR 007 - Streaming Import with Server-Sent Events
type: adr
status: Accepted
date: 2026-04-02
tags: [architecture, imports, streaming, sse, performance]
description: Decision to implement streaming CSV imports using Server-Sent Events for real-time progress feedback
aliases: [streaming imports, SSE, server-sent events, large file imports]
related_code: ["apps/node-backend/src/services/importPipeline/index.js", "apps/node-backend/src/lib/sse.js", "apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/repositories/importBatchRepository.js"]
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

## Implementation Updates

### Phase C (April 2026)

The original implementation using separate `importService`, `streamingImportService`, and `rawTransactionImportService` was consolidated into a unified **import pipeline orchestrator** ([[apps/node-backend/src/services/importPipeline/index.js]]):

- **Single orchestrator**: `runImportPipeline()` manages staging → validation → matching → commit phases
- **Unified progress reporting**: All phases emit standardized progress events keyed on `phase` (not just row counts)
- **SSE backpressure**: New `createSseWriter()` ([[apps/node-backend/src/lib/sse.js]]) propagates backpressure from the HTTP client into the pipeline
- **Batch tracking**: All imports tracked in `import_batches` table for history/rollback
- **Aggregation refresh**: Pipeline schedules materialized view refresh post-import

Both streaming (`POST /api/import/csv/stream`) and non-streaming (`POST /api/import/csv`) routes now use the same orchestrator, differing only in their progress event forwarding mechanism.

See [[docs/features/import#import-service-architecture-phase-c-refactor|Import Service Architecture (Phase C Refactor)]] for details.

## Related

- [[docs/features/import]] — Import feature documentation
- [[docs/diagrams/import-pipeline.puml]] — Import pipeline diagram
- [[docs/diagrams/import-sequence.puml]] — Import sequence diagram
