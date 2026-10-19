---
title: "ADR-220: Branded ids, currency codes and Money values"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, typescript, type-safety, money, currency, ids, zod, agents]
description: "Accepted on 2026-10-19. Entity ids and ISO currency codes are branded TypeScript types from @vision/types/brands, applied at the boundaries (row schemas, route params, wire contracts, frontend API types) so mixed-up ids and free-text currencies fail to compile. Server totals that convert between currencies use a Money value ({ amount, currency }) and sumMoney, which refuses to add different currencies. No new CI step: the existing typecheck enforces it."
aliases: [adr-220, branded types, money value, currency code brand]
---

# ADR-220: Branded ids, currency codes and Money values

## Status

Accepted on 2026-10-19. Tor chose branded types from a list of static aids, and "Server totals"
as the reach of the Money value.

## Date

2026-10-19

## Context

Ids were plain `number`s and currency codes plain `string`s throughout the backend and the
frontend. Nothing stopped code, often written by agents, from passing a category id where an
account id belongs, or a display label where an ISO code belongs. The 2026-10-19 server-side
calculations audit ([[docs/adr/216-server-owned-domain-calculations|ADR-216]]) found totals that
added amounts in different currencies. Branding the ids also exposed four places where the
portfolio unit-event UNION compared ids from three different tables.

TypeScript cannot forbid `a + b` on branded numbers, so a `Money<'EUR'>` number brand alone would
not have stopped those sums. Currencies are runtime values, so a literal currency type parameter
does not help either.

Tor does not want CI to get longer.

## Decision

1. **Brands** live in `packages/types/src/brands.ts` (`@vision/types/brands`): `CurrencyCode`,
   `AccountId`, `TransactionId`, `CategoryId`, `RecipientId`, `TagId`, `SplitId`,
   `PlannedTransactionId`, `InvestmentId` and `PortfolioTransactionId`. A brand is zod's
   `$brand`, so `schema.brand<B>()` produces exactly these types, and generated database types
   can reference them. At runtime they are plain numbers and strings.
2. **Brands are applied at the boundaries** and inferred elsewhere:
   - backend row schemas use `pgAccountId`, `pgCurrency` and the other `pg*` keys in
     `apps/node-backend/src/database/rowSchemas.ts`. They use `.brand<B, "inout">()`, so the
     schema still only checks and `RowSchema<T>` stays input = output;
   - route params use the entity id schemas in `src/routes/_requestSchemas.ts`, and
     `assertCurrency` returns a `CurrencyCode`;
   - the wire contracts in `packages/types/src/contracts` use the branded id schemas.
     `WireCurrencySchema` brands a currency without making response parsing stricter;
   - the frontend API types (`apps/frontend/src/types/api.ts`, `types/portfolio.ts`) and the
     `lib/api` client signatures take the branded types.
3. **Constructors**: `as*Id` and `asCurrencyCode`/`isCurrencyCode` exist only for values that
   enter unchecked: URL and form values, storage, constants, LLM tool arguments and test
   fixtures. Production code does not cast with `as AccountId`. The backend's `EUR` and
   `storedCurrencyCode` (`apps/node-backend/src/lib/currencyCode.ts`) cover the base currency and
   legacy-cased stored columns. The frontend uses `DEFAULT_CURRENCY`.
4. **Money**: `@vision/shared-utils/money` adds `Money` (`{ amount: Decimal, currency:
   CurrencyCode }`), `money()`, `sumMoney(items, currency)` and `addMoney()`. `sumMoney` throws
   `CurrencyMismatchError` on any item in another currency. `convertAtLatestRates` takes and
   returns `Money`. The server totals (accounts hub, planned totals, owes, net worth by account,
   portfolio monthly rent) sum converted figures through `sumMoney`. Other amount fields stay
   plain decimals. Money is extended to database row types when queries move to generated types.
5. **No new CI step.** The existing typecheck enforces the brands, and the money tests run in the
   existing package test suite.

## Consequences

- An id of the wrong entity or an unchecked currency string is a compile error. The tests need
  `as*` constructors for fixture ids.
- A total that forgets to convert fails at runtime with `CurrencyMismatchError` instead of
  returning a wrong figure. The type system still allows `Decimal` arithmetic outside the totals.
  The existing `no-raw-money-arithmetic` lint warning covers float arithmetic.
- The frontend now validates currency inputs as ISO codes (upper-cased) before saving.
- Ids without a brand (import batches, parser configs, charts, recipient bank accounts and
  patterns, attachments) stay `number`. Add a brand to `brands.ts` when code starts mixing them.

## Related

- [[docs/adr/193-zod-runtime-contracts|ADR-193]] row and wire contracts
- [[docs/adr/198-exact-optional-property-types|ADR-198]] strict TypeScript flags
- [[docs/adr/215-behaviour-boundary-tests|ADR-215]] boundary tests
- [[docs/adr/216-server-owned-domain-calculations|ADR-216]] server-owned calculations
- [[docs/adr/index|All ADRs]]
