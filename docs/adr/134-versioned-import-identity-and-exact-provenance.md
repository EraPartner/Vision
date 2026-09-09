---
title: ADR-134 - Versioned Import Identity and Exact Provenance
type: adr
status: Accepted
date: 2026-09-09
tags:
  [adr, architecture, import, deduplication, provenance, csv, migration-0103]
description: Separate byte-sensitive CSV provenance from provider-neutral, versioned, occurrence-aware duplicate identity for budgeting and portfolio imports.
aliases: [versioned import identity, exact CSV provenance, import fingerprint]
---

# ADR-134: Versioned Import Identity and Exact Provenance

## Status

Accepted

## Date

2026-09-09

## Context

Vision's adapters mixed two different concerns. Some hashes represented a literal CSV record, while
others represented reconstructed or normalized fields. The same value was then used as audit
provenance and duplicate identity. This caused three correctness risks:

- harmless CSV formatting changes could defeat duplicate detection;
- byte-identical legitimate occurrences could be collapsed;
- budgeting and portfolio adapters used different duplicate rules and race guards.

Historical `transactions.tx_hash` values cannot be reinterpreted safely because their inputs were
not uniform.

## Decision

Adapters only parse source data and retain the exact logical CSV record. The shared
`services/importIdentity.js` module owns duplicate identity for both pipelines.

Each staged row receives two separate hashes:

- `source_record_hash` is SHA-256 over the literal retained source record. It is byte-sensitive,
  non-unique, and used only for provenance.
- `dedup_fingerprint` is SHA-256 over a versioned canonical tuple. It prefers an immutable provider
  transaction ID. Otherwise it uses normalized financial fields plus an occurrence ordinal.

The canonical tuple includes the import domain, source or destination account identity, and
currency. It deliberately excludes the selected adapter so switching between a built-in and custom
parser cannot redefine the same transaction. Portfolio identity also includes the
cash-versus-portfolio route. Repeated identical source rows receive distinct ordinal fingerprints,
so a first import keeps every occurrence and a complete re-import is a no-op.

Migration 0103 adds a stable UUID `accounts.import_identity`, metadata columns on both staging and
canonical transaction tables, and partial unique indexes on
`(dedup_fingerprint_version, dedup_fingerprint)`. Those indexes are the concurrency authority.
New budgeting imports also write the fingerprint to legacy `tx_hash` for compatibility. Existing
`tx_hash` values are not backfilled or rewritten. For rows without a versioned fingerprint, commit
counts the union of exact historical source-hash matches and canonical-field matches. The incoming
occurrence ordinal consumes that legacy capacity one row at a time, so one historical row cannot
suppress every identical occurrence in a new file.

Internal provenance and fingerprint columns are not exposed by transaction APIs.

## Consequences

- All CSV adapters preserve quoted delimiters, escaped quotes, and embedded newlines in staged
  `raw_data`; only the terminal record delimiter is removed.
- Formatting differences can change provenance without changing duplicate identity.
- Legitimate repeated transactions remain distinct without giving up race-safe re-imports.
- Fingerprint changes require a new version. A version must never silently change meaning.
- Generic parsers may map an immutable source ID when one exists. Without one, their normalized
  field identity is only as stable as the mapped account label and financial fields.
- Only source fields with a documented global uniqueness lifetime may be promoted to immutable IDs.
  Wise's explicit transaction ID currently qualifies. BNP, ING, and Belfius statement counters stay
  in fallback fields because their lifetime is not established.
- Historical imports remain compatible, but their old hash values keep their original mixed
  semantics.
- Terminal import batches and their exact staging provenance are pruned after 30 days by startup
  retention. Canonical fingerprints remain after ordinary batch deletion because the batch foreign
  key becomes null. An explicit rollback removes the canonical rows, so those fingerprints may be
  imported again.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/import|CSV Import and Deduplication]]
- [[docs/features/portfolio-import|Portfolio CSV Import]]
- [[docs/reference/data-model|Data Model Reference]]
- [[alembic/versions/0103_import_identity_provenance.py|Migration 0103]]
