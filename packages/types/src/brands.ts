/**
 * Branded primitives shared by the backend, the frontend and generated
 * database types (ADR-220).
 *
 * A brand is a compile-time tag on a plain number or string: at runtime an
 * `AccountId` is still a number and a `CurrencyCode` still a string, so JSON,
 * SQL parameters and comparisons are unchanged. The tag stops one kind of
 * value from being passed where another is expected (a category id as an
 * account id, a free-text label as a currency code).
 *
 * Brands are applied at the boundaries: the zod schemas below (wire
 * contracts, row schemas) and the `as*` constructors for values that arrive
 * unchecked (route params parsed elsewhere, test fixtures). Code in between
 * infers them. The brand shape is zod's own `$brand`, so `schema.brand<B>()`
 * outputs exactly these types.
 */
import { z } from "zod";

export type Brand<T, B extends string> = T & z.$brand<B>;

/** ISO-4217 code, upper-case, three letters (DB `CHECK (~ '^[A-Z]{3}$')`). */
export type CurrencyCode = Brand<string, "CurrencyCode">;

/**
 * A money amount exactly as node-postgres returns a NUMERIC column: a decimal
 * string. Generated database types use it for amount columns that are money
 * (not units, prices or rates); pair it with the row's currency through
 * `money()` from `@vision/shared-utils/money`.
 */
export type MoneyAmount = Brand<string, "MoneyAmount">;

export type AccountId = Brand<number, "AccountId">;
export type TransactionId = Brand<number, "TransactionId">;
export type CategoryId = Brand<number, "CategoryId">;
export type RecipientId = Brand<number, "RecipientId">;
export type TagId = Brand<number, "TagId">;
/** `transaction_splits.id`. */
export type SplitId = Brand<number, "SplitId">;
export type PlannedTransactionId = Brand<number, "PlannedTransactionId">;
/** `investments.id`: a portfolio holding. */
export type InvestmentId = Brand<number, "InvestmentId">;
export type PortfolioTransactionId = Brand<number, "PortfolioTransactionId">;

const CURRENCY_CODE = /^[A-Z]{3}$/;

export const CurrencyCodeSchema = z
  .string()
  .regex(CURRENCY_CODE)
  .brand<"CurrencyCode">();

const idSchema = () => z.int().positive();

export const AccountIdSchema = idSchema().brand<"AccountId">();
export const TransactionIdSchema = idSchema().brand<"TransactionId">();
export const CategoryIdSchema = idSchema().brand<"CategoryId">();
export const RecipientIdSchema = idSchema().brand<"RecipientId">();
export const TagIdSchema = idSchema().brand<"TagId">();
export const SplitIdSchema = idSchema().brand<"SplitId">();
export const PlannedTransactionIdSchema = idSchema().brand<"PlannedTransactionId">();
export const InvestmentIdSchema = idSchema().brand<"InvestmentId">();
export const PortfolioTransactionIdSchema =
  idSchema().brand<"PortfolioTransactionId">();

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && CURRENCY_CODE.test(value);
}

/**
 * Checked constructor for a currency code from an unchecked source. Throws on
 * anything that is not three upper-case letters; callers that accept user
 * input normalise case first.
 */
export function asCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new TypeError("Invalid ISO-4217 currency code");
  }
  return value;
}

/*
 * Unchecked id constructors: the caller already validated the number (a zod
 * route schema, a DB row). They exist so the cast lives in one named place.
 */
export const asAccountId = (id: number): AccountId => id as AccountId;
export const asTransactionId = (id: number): TransactionId =>
  id as TransactionId;
export const asCategoryId = (id: number): CategoryId => id as CategoryId;
export const asRecipientId = (id: number): RecipientId => id as RecipientId;
export const asTagId = (id: number): TagId => id as TagId;
export const asSplitId = (id: number): SplitId => id as SplitId;
export const asPlannedTransactionId = (id: number): PlannedTransactionId =>
  id as PlannedTransactionId;
export const asInvestmentId = (id: number): InvestmentId => id as InvestmentId;
export const asPortfolioTransactionId = (
  id: number,
): PortfolioTransactionId => id as PortfolioTransactionId;
