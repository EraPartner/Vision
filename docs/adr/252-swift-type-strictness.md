---
title: "ADR-252: Swift type strictness"
type: adr
status: superseded
date: 2026-10-25
tags: [adr, architecture, swift, native-app, types, branded-types, openapi, lint, adr-220, adr-249]
description: "Accepted on 2026-10-25. The Swift app is typed as strictly as the TypeScript app: a distinct identifier type for every entity, ISO currency codes, enums that keep unknown values, explicit-null PATCH fields, calendar days and instants, typed unions, typed settings and routes, a decode fixture for every generated model, and a ban-list lint with a ratchet."
aliases: [adr-252, swift typing, swift branded ids]
related_code:
  [
    "scripts/native-openapi.ts",
    "scripts/native-fixtures.ts",
    "scripts/native-lint.ts",
    "apps/native/lint-baseline.txt",
    "apps/native/Sources/VisionNativeCore/API/Types/Identifier.swift",
    "apps/native/Sources/VisionNativeCore/API/Types/CurrencyCode.swift",
    "apps/native/Sources/VisionNativeCore/API/Types/CalendarDay.swift",
    "apps/native/Sources/VisionNativeCore/API/Types/Instant.swift",
    "apps/native/Sources/VisionNativeCore/API/Types/Money.swift",
    "apps/native/Sources/VisionNativeCore/Settings/NativeSettingsEnums.swift",
    "apps/native/Sources/VisionNativeCore/Settings/SettingKey.swift",
  ]
---

# ADR-252: Swift type strictness

> [!note] Superseded by [[docs/adr/254-remove-swift-app|ADR-254]] on 2026-10-26. The Swift app
> was removed from `main`; its code is in Git history (see ADR-254).

## Status

Accepted on 2026-10-25. Builds on [[docs/adr/249-revive-swift-app|ADR-249]] and mirrors
[[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]] for the Swift app. Neither is edited.

## Date

2026-10-25

## Context

Tor asked on 2026-10-25 for the Swift frontend to be typed "as perfectly and correctly as the
TypeScript one". The restored port decoded ids, currencies, enums and dates as plain `Int` and
`String`, so an account id could be passed where a transaction id was expected and a typo in an
enum value compiled. The gap audit of 2026-10-25 listed the work in seven packages.

## Decision

1. **A distinct identifier type for every entity.** `IntIdentifier<Tag>` and
   `StringIdentifier<Tag>` wrap the wire value; the OpenAPI generator emits one tag and alias per
   entity (`AccountID`, `TransactionID`, ...). This is stricter than ADR-220's ten brands, by
   Tor's choice. Fields that look like ids but are not entity ids are listed in `UNTYPED_IDS`
   with a reason; an unmapped id-like field fails generation.
2. **Currency codes are `CurrencyCode`** (three capitals, as the database checks enforce).
   Market-data provider currencies (for example `GBp`) stay `String`; the schemas are listed in
   `PROVIDER_CURRENCY_SCHEMAS`.
3. **Enums keep unknown values.** Generated string enums have `case unknown(String)` and
   re-encode the raw value, so a newer backend value never fails a whole response.
4. **Dates are `CalendarDay` and `Instant`.** `format: date` fields decode strictly from
   `YYYY-MM-DD`; `format: date-time` fields require a zone and re-encode their original text.
5. **Typed unions.** `oneOf`/`anyOf` schemas with a tag or a distinguishing property become
   enums with associated values; the rest stay `JSONValue` and are listed with a reason.
6. **`Nullable<T>`** marks PATCH fields that the web client sends as explicit `null`.
7. **`Money`** pairs an amount with its `CurrencyCode`; `sum` throws on mixed currencies,
   mirroring `packages/shared-utils/src/money.ts`.
8. **Typed app state.** Settings values (`StartOfWeek`, `CostBasisMethod`, `StartupSection`,
   `VisualEffects`, language and answer depth), `SettingKey`, notice keys and route
   destinations are enums with the raw values the web app stores, so persisted data is
   unchanged.
9. **Every generated model has a decode fixture.** `scripts/native-fixtures.ts` writes a minimal
   and a maximal JSON sample per model plus negative cases; a generated Swift test round-trips
   them, and `bun run native:test-generators` fails when a schema has no fixture.
10. **A ban-list lint with a ratchet.** `scripts/native-lint.ts` rejects `as!`, `try!`,
    `fatalError`, `@unchecked Sendable`, `nonisolated(unsafe)`, `Any`, `AnyHashable` and
    implicitly unwrapped optionals unless the line carries `// lint:allow <rule> <reason>`, and
    holds force unwraps, raw ids, raw currencies, money as `Double` and string-literal compares
    at or below `apps/native/lint-baseline.txt`. It runs in `bun run native:test-generators` and
    in the pre-commit hook for staged Swift files. No CI job was added.

## Consequences

- The wire format, request bodies, database and stored settings are unchanged; the types only
  reject values the backend never sends. A malformed date or currency now fails decoding instead
  of reaching a view.
- Lower the lint baseline with `bun scripts/native-lint.ts --update-baseline` when counts fall;
  it can never rise.
- The `swift-build` workflow passes `-IDEBuildingContinueBuildingAfterErrors=YES` so one run
  reports every compile error.
- Still open: localized string keys as a generated type, and warnings as errors.

## Related

- [[docs/adr/249-revive-swift-app|ADR-249]]
- [[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]]
- Native app architecture
- [[docs/adr/index|All ADRs]]
