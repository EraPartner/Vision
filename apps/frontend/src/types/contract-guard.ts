/**
 * Compile-time drift guard between the hand-written, ergonomic API types in
 * ./api.ts (consumed by ~36 modules) and the contract types generated from
 * openapi.yaml into ./generated.ts (regenerated + drift-checked in CI).
 *
 * Why this file exists: generated.ts was being generated and CI-verified, yet
 * imported by zero modules — so the types the app actually consumes could drift
 * away from the OpenAPI contract unnoticed (they already had: api.ts's header
 * referenced a backend that no longer exists). The assertions below make
 * generated.ts load-bearing: `bun run typecheck` now fails if a field the code
 * relies on is renamed or removed in the contract, or if a money/quantity field
 * stops being numeric in the contract.
 *
 * Scope and intent:
 *  - One-directional and optionality-tolerant on purpose. It does NOT fail when
 *    the contract merely ADDS a field (a non-breaking change) or when
 *    required/optional/`| null` nuances differ between the two sources.
 *  - It only catches drift that would make the consumed types unsound.
 *  - Runtime value coercion (pg returns NUMERIC as strings) is a separate
 *    concern handled at the backend repository boundary; see
 *    packages/shared-utils/src/money.js (`numericColumn` / `coerceNumericFields`).
 *
 * This module has no runtime output — it is pure type-level assertion.
 */
import type { components } from './generated';
import type {
  Transaction,
  Category,
  Recipient,
  Tag,
  PlannedTransaction,
  Investment,
  PortfolioTransaction,
} from './api';

type Schemas = components['schemas'];

/** Compiles iff `T` is exactly `true`; any other type is a constraint error. */
type Expect<T extends true> = T;

/**
 * True iff every key of `A` also exists on `B` (A's keys ⊆ B's keys). `keyof A`
 * is a non-naked union here, so this is a single assignability check (no
 * distribution) — it tolerates optional/`| null` differences and only cares
 * about key presence.
 */
type KeysSubsetOf<A, B> = keyof A extends keyof B ? true : false;

/** True iff `T`, with `null`/`undefined` stripped, is exactly `number`. */
type IsNumeric<T> = [NonNullable<T>] extends [number]
  ? [number] extends [NonNullable<T>]
    ? true
    : false
  : false;

// ── Key coverage: every field the consumed type reads must exist in the contract.
export type _KeysTransaction = Expect<KeysSubsetOf<Transaction, Schemas['Transaction']>>;
export type _KeysCategory = Expect<KeysSubsetOf<Category, Schemas['Category']>>;
export type _KeysRecipient = Expect<KeysSubsetOf<Recipient, Schemas['Recipient']>>;
export type _KeysTag = Expect<KeysSubsetOf<Tag, Schemas['Tag']>>;
export type _KeysPlannedTransaction = Expect<KeysSubsetOf<PlannedTransaction, Schemas['PlannedTransaction']>>;
export type _KeysInvestment = Expect<KeysSubsetOf<Investment, Schemas['Investment']>>;
export type _KeysPortfolioTransaction = Expect<KeysSubsetOf<PortfolioTransaction, Schemas['PortfolioTransaction']>>;

// ── Money/quantity fields must stay numeric in the contract (catches a
//    regression where the OpenAPI spec re-types an amount as a string).
export type _NumTransactionAmount = Expect<IsNumeric<Schemas['Transaction']['amount']>>;
export type _NumTransactionBalance = Expect<IsNumeric<Schemas['Transaction']['balance']>>;
export type _NumTransactionAmountEur = Expect<IsNumeric<Schemas['Transaction']['amount_eur']>>;
export type _NumPlannedAmount = Expect<IsNumeric<Schemas['PlannedTransaction']['amount']>>;
export type _NumPlannedLoanPrincipal = Expect<IsNumeric<Schemas['PlannedTransaction']['loan_principal']>>;
export type _NumInvestmentCurrentPrice = Expect<IsNumeric<Schemas['Investment']['current_price']>>;
export type _NumPortfolioAmount = Expect<IsNumeric<Schemas['PortfolioTransaction']['amount']>>;
export type _NumPortfolioUnits = Expect<IsNumeric<Schemas['PortfolioTransaction']['units']>>;
export type _NumPortfolioPricePerUnit = Expect<IsNumeric<Schemas['PortfolioTransaction']['price_per_unit']>>;
export type _NumPortfolioFees = Expect<IsNumeric<Schemas['PortfolioTransaction']['fees']>>;
export type _NumPortfolioTaxes = Expect<IsNumeric<Schemas['PortfolioTransaction']['taxes']>>;
