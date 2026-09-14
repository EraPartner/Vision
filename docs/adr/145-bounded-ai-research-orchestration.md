---
title: ADR-145 - Bounded AI Research Orchestration
type: adr
status: Accepted
date: 2026-09-13
tags: [adr, ai, research, ollama, openai, privacy, jobs, evidence, web]
description: Use provider-neutral recoverable investigation jobs, bounded typed tools, local evidence retrieval, and a consent-bound short-lived process for optional OpenAI API egress.
aliases: [AI research orchestration, cloud egress helper, AI investigations]
---

# ADR-145: Bounded AI Research Orchestration

## Status

Accepted

## Date

2026-09-13

## Context

Vision needs multi-step questions that combine Budgeting, Portfolio, and Research without exposing
the complete database to a model. [[docs/adr/024-local-llm-chat|ADR-024]] made local Ollama the only
chat route. [[docs/adr/138-openai-codex-assistance-boundary|ADR-138]] defined a future optional cloud
boundary but did not choose its runtime shape. Full container isolation would increase packaging,
memory, and operational cost for a desktop feature whose normal tools are read-only.

## Decision

Vision adds a separate investigation workflow with these boundaries:

1. `local` and `openai-api` implement one provider-neutral planning contract. Local remains the
   default; routes never fall back automatically. Cloud output may prioritize only locally generated
   candidate step identifiers. Evidence and final answer synthesis always stay with local Ollama.
2. A deterministic baseline planner selects at most 24 typed steps. The selected model may reorder,
   but cannot invent, those candidates. Material comparison-period ambiguity pauses in `waiting`
   until the user supplies a persisted clarification. Tool inputs, results, provenance, and failures
   are persisted. In detailed mode, the local model may inspect failed local steps and select up to
   three of them for one retry pass. External and web steps are never replayed by this loop. One job
   and one tool execute at a time, limiting local model and database pressure.
3. Completed steps are idempotent checkpoints. Startup reuses them after a restart. Explicit resume
   refreshes completed local data steps but retains external checkpoints so paid or public egress is
   not repeated silently. Scope changes require a new job. Cancellation reaches the active model or
   egress child process.
4. Local reports are split into bounded passages. PostgreSQL full-text search is always available;
   optional Ollama embeddings add semantic ranking. Unsupported PDFs and scans remain explicit.
5. Public web research is separately enabled and accepts only a public query authored in its own
   field. Public-provider research likewise accepts only explicit public symbols or macro queries.
   Both limit requests, validate inputs and destinations, cap response bytes, and treat returned text
   as untrusted evidence.
6. Cloud payloads are constructed only from typed fields. Public planning requires a separately
   authored public question; Vision never derives it from the private investigation question and
   never includes private scope constraints. Common financial identifiers, email addresses, and
   currency amounts are rejected from that public field. Selected-summary mode sends the explicitly
   inspected summary, not the original question or constraints. The user inspects the exact canonical
   payload, then grants its SHA-256 digest, purpose, route, expiry, fields, requests, characters,
   tokens, cost, and cumulative disclosure units.
7. The OpenAI adapter runs in a short-lived macOS Seatbelt sandbox with an empty temporary working
   directory. Its profile denies filesystem access except the runtime, helper, system libraries, and
   network configuration. The scrubbed environment contains only the API key. It has one fixed
   Responses API destination, no redirects, `store: false`, no background mode, and no hosted tools.
   The helper imports no Vision database or application filesystem services. Other operating systems
   fail closed instead of running an unsandboxed cloud adapter.
8. Disclosure records keep metadata, policy, digest, and usage, never the exact payload or key.
   Deleting local disclosure history removes both records and grants, which also revokes any unused
   consent.
   `store: false` is displayed separately from provider retention, training, advertising, and onward
   processing. Current provider terms and account entitlement remain release-time facts.

This operating-system boundary is aimed at realistic accidental disclosure, prompt-driven overreach,
and adapter bugs. It is not a defence against a compromised operating system or a malicious signed
runtime binary. A container or virtual machine remains an optional hardening step if the threat model
later includes either.
Public-address checks reduce server-side request forgery risk but do not provide network-namespace
enforcement against a hostile domain that changes its DNS answer between validation and connection.

## Consequences

- Local work does not require a container and has low idle cost. Only optional cloud planning creates
  a temporary sandboxed process. One serialized job and tool avoid concurrent local-model memory
  spikes. Embedding responses are stream-capped at 4 MiB and vectors at 8,192 dimensions.
- Deterministic Vision services remain authoritative for financial arithmetic. Model responses must
  validate as facts, calculations, interpretations, assumptions, gaps, conflicts, and evidence.
- OpenAI activation requires an explicit model, API key, positive monthly budget, and positive price
  configuration. Live synthetic acceptance and current account entitlement must be recorded before
  enabling it outside development.
- PDF text extraction and optical character recognition are deferred; users can provide text,
  Markdown, or HTML.

## Supersession Boundary

This ADR supersedes ADR-024's blanket external-provider prohibition only for the separately enabled,
consent-bound `openai-api` investigation route. Ordinary AI chat remains local Ollama behavior.

## Related

- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/diagrams/ai-research-investigation-flow.puml|AI Research Investigation Flow]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/adr/index|All ADRs]]
