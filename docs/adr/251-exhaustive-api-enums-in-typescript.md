---
title: "ADR-251: Exhaustive API enums in the TypeScript frontend"
type: adr
status: accepted
date: 2026-10-25
tags: [adr, typescript, type-safety, openapi, enums, contract-guard, lint]
description: "Accepted on 2026-10-25. Every string enum in openapi.yaml stays a literal union in the frontend code that consumes it. contract-guard.ts fails the typecheck when a hand-written request or response type widens a contract enum to string, and frontend switches over a union must list every member even when they have a default arm. Runtime tolerance for unknown server values is unchanged. No new CI step."
aliases: [adr-251, exhaustive enums, api enums, literal unions]
---

# ADR-251: Exhaustive API enums in the TypeScript frontend

## Status

Accepted on 2026-10-25. Tor asked for the TypeScript app to treat API enum values as exhaustive
typed unions, alongside the same work in the Swift app
([[docs/adr/249-revive-swift-app|ADR-249]]).

## Date

2026-10-25

## Context

`openapi.yaml` declares about 215 string enums (named schemas such as `AssetClass`, and inline
`enum:` properties and parameters). `openapi-typescript` already emits each one as a literal union
in `apps/frontend/src/types/generated.ts`, and the 55 hand-written types that
`contract-guard.ts` pins to the contract already used those unions.

The gap was everywhere else: the domain clients in `apps/frontend/src/lib/api/` declare many of
their own request and response types, and several typed enum fields and parameters as `string`
(for example insight `prominence`, import batch `status`, research provider names). A typo in a
comparison against such a field compiled, and a `switch` over it could not be checked.

Separately, the shared lint config ran `switch-exhaustiveness-check` with
`considerDefaultExhaustiveForUnions: true`, so a `default` arm hid a missing union member.

The frontend does not validate API responses at runtime. Frontend and backend ship together in
one app, so an unknown value is rare, but the UI should still render one instead of failing.

## Decision

1. **Guard.** `contract-guard.ts` gains `Matches<A, B>`: `A`'s keys must exist in the contract
   type `B` (as before), and every key where `B` is a string enum, or an array of one, must be a
   subset of that enum in `A`. On failure it names the offending keys. All existing key-coverage
   assertions use it, and new assertions pin the domain-client types in `src/lib/api/` to their
   schemas or operation payloads.
2. **Types.** Enum fields and parameters in hand-written frontend types use the contract union,
   derived from `components["schemas"]` or reusing an existing alias, not copied by hand. Where a
   value enters from a string edge (URL search params, `<Select>` values), a small type guard
   narrows it instead of a cast.
3. **Switches.** The frontend ESLint config overrides `switch-exhaustiveness-check` with
   `considerDefaultExhaustiveForUnions: false`: a switch over a union lists every member. A
   `default` arm may stay as the fallback for a value a newer server sends. The backend keeps
   the shared setting, where its remaining `default` arms cover third-party unions (Zod issue
   codes, PostgreSQL error codes).
4. **Runtime tolerance unchanged.** No runtime enum validation is added, no wire format, request
   body, stored setting or label changes, and existing fallback rendering stays.

## Consequences

- Renaming or removing an enum value in `openapi.yaml` (after `bun run generate:types`) fails the
  frontend typecheck at every comparison and switch that uses it.
- A typed `string` for a contract enum in a guarded type fails `bun run typecheck` with the key
  name.
- The unions are compile-time only. A value outside the union still reaches the UI at runtime and
  takes the `default` or fallback path, as before.
- Types not paired with a schema in `contract-guard.ts` are not checked by the guard; new domain
  client types should add a `Matches` assertion.
- No new CI job or step: the existing typecheck and lint run the checks.

## Related

- [[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]] branded ids and currency codes
- [[docs/adr/249-revive-swift-app|ADR-249]] Swift app, which types the same enums with an
  `unknown` fallback
- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/index|All ADRs]]
