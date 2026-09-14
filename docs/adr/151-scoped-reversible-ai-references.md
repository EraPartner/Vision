---
title: ADR-151 - Scoped reversible AI references
type: adr
status: Accepted
date: 2026-09-14
tags:
  [
    adr,
    ai,
    privacy,
    security,
    pseudonymization,
    encryption,
    openai,
    persistence,
  ]
description: Replace explicitly marked private literals with one-job cryptographic tokens for cloud disclosure, then restore allowlisted answer text locally with an installation-held key.
aliases:
  [
    reversible AI references,
    scoped reference tokens,
    local reference restoration,
  ]
---

# ADR-151: Scoped reversible AI references

## Status

Accepted

## Date

2026-09-14

## Context

Selected-summary planning and selected-evidence synthesis can need stable references to an account,
recipient, holding, document, amount, or date. Sending the literal value exposes it to the cloud.
Irreversible redaction loses identity across the response and cannot restore a useful local answer.
A global or reusable token map would create a durable correlation identifier across previews, jobs,
and providers.

This boundary cannot promise anonymity. Even when marked literals are hidden, unmarked values,
amounts, dates, portfolio composition, prose, and behavioral patterns can remain identifying.

## Decision

Vision accepts explicit markers only in the selected summary and selected evidence fields:
`[[vision-ref:type|value]]`. Supported types are `account`, `recipient`, `investment`, `holding`,
`category`, `document`, `subject`, `amount`, and `date`.

Disclosure preview replaces each marker with a typed token of the form
`[[VR1:type:<24 base64url characters>]]`. The token payload is 18 bytes from the operating system
cryptographically secure random number generator. A fresh random Universally Unique Identifier
(UUID) scopes each preview. Repeated equal type/value pairs inside one scope reuse one token; tokens
are not reused across scopes.

The local map stores no plaintext value. Each value is encrypted with AES-256-GCM under the
deployment's `AI_REFERENCE_MAPPING_KEY`, using a fresh 12-byte nonce, a 16-byte authentication tag,
and scope ID, token, and type as authenticated additional data. The key must be a base64-encoded
32-byte value. It is installation state, not PostgreSQL state, and is deliberately excluded from
database backups.
Vision does not generate this key. It is optional operator configuration: unmarked investigations
continue to work when it is absent, while a preview containing a marker fails explicitly.

An unclaimed preview can be used for 15 minutes. Creating a later reference preview deletes expired
unclaimed scopes. Investigation creation validates every token against the named scope and atomically
claims that scope for exactly one job. A claimed scope expires after 30 days. Deleting the job
cascades to its scope and encrypted entries.

Vision persists the schema-validated provider-form answer, which may still contain tokens, in
`checkpoint_json.providerResult` before local restoration. A backend restart validates and reuses
that checkpoint without another cloud or local model call. On successful restoration,
`result_json` stores the local answer with plaintext values restored only in allowlisted display-text
fields: summary; fact, calculation, and interpretation text; assumptions; missing information;
conflict descriptions; and evidence excerpts. Evidence IDs, labels, locators, kinds, dates,
availability, schema fields, and other structure are never token-substituted.

Unknown, malformed, cross-scope, expired, undecryptable, or fabricated tokens fail explicitly. A
failed restoration marks the job failed and does not display a partly restored provider answer.

Database backups include the encrypted scope and entry rows so an in-flight job can be restored on
the same installation while its key and 30-day scope remain valid. The key itself is never in the
backup. Moving a backup without the original key therefore cannot restore a token-bearing checkpoint
and fails visibly. Already completed `result_json` remains the local restored result.

## Consequences

- Explicitly marked literals do not leave Vision in plaintext, while the local answer can remain
  readable and consistent.
- One-preview and one-job scope rules prevent token correlation and cross-investigation reuse.
- Losing or rotating the installation key makes still-tokenized checkpoints unrecoverable.
- Database backup is not key escrow. Operators must preserve the key separately if they require
  recovery of in-flight reference-bearing investigations.
- Tokens expose their declared type, and unmarked context still crosses the selected disclosure
  boundary. The feature is pseudonymization, not anonymity.
- Scope rows may remain stored after their time limit, but expiry is enforced before claim and
  restoration; job deletion removes claimed rows physically.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
- [[docs/adr/146-explicit-selected-evidence-cloud-synthesis|ADR-146]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/api/ai-research|AI Research API]]
- [[docs/features/ai-chat|AI Chat and Investigations]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
