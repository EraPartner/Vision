---
title: "ADR-214: Test behaviour at stable boundaries, not internal structure"
type: adr
status: Accepted
date: 2026-10-19
tags: [adr, testing, agents, refactoring, test-boundaries]
description: "Accepted 2026-10-19. Tests check behaviour at stable boundaries (API contracts, real PostgreSQL, pure domain functions, file formats, rendered UI and end-to-end journeys). Tests that assert internal structure (source text, private helpers, mock call order, SQL strings sent to mocks) may be deleted when a change breaks them, with a one-line reason in the PR, so agents can restructure freely."
aliases: [adr-214, behaviour tests, structure tests]
---

# ADR-214: Test behaviour at stable boundaries, not internal structure

## Status

Accepted on 2026-10-19 by Tor.

## Date

2026-10-19

## Context

Most Vision changes are made by coding agents. Tests coupled to internals (source-text
assertions, mocks of internal modules with call-order checks, SQL strings sent to a mocked
client, private helpers exported only for tests) break on any restructuring that keeps
behaviour. An agent then either rewrites the tests to match the new structure, which proves
nothing, or keeps the current architecture to avoid breaking them. Both keep the code in its
current shape regardless of whether a better design exists.

## Decision

1. Tests belong at stable boundaries: HTTP/API contracts, real PostgreSQL state, pure domain
   functions through their public module (money, FX, precision, Belgian tax, parsers,
   recurrence, dedup), file and backup formats, security and recovery invariants, and rendered
   UI and end-to-end journeys.
2. Agents may restructure code freely. A test that asserts structure instead of behaviour may be
   deleted when a change breaks it, with a one-line reason per file in the PR description. New
   tests of that kind are not added.
3. If a deleted test was the only check of a real behaviour, the same change adds a boundary
   test for it.
4. Unchanged: expected financial values are never edited to match new output, domain-failure
   tests are not deleted to make a change pass, a source assertion that is the only enforcement
   of a security or data-safety invariant stays until a boundary test replaces it, and coverage
   gates are not lowered.

The 2026-10-19 cleanup applied this to the existing suites; its per-file decisions are in
`scripts/browser-tests/coverage-ledger.json` and summarised in
[[docs/testing/test-inventory]].

## Consequences

- Agents get a larger design space: internal modules can be merged, split or inlined without
  test churn.
- Feedback comes later for some regressions: a structure test failed in milliseconds, a contract
  or PostgreSQL test takes longer and an end-to-end journey longer still.
- Coverage of an area now depends on its boundary tests existing. Gaps are listed in the test
  inventory instead of being hidden behind structural assertions.

## Related

- [[docs/testing/testing#Behavior-focused cleanup and test boundaries|Testing guide]]
- [[docs/testing/test-inventory]]
- [[docs/adr/index|All ADRs]]
