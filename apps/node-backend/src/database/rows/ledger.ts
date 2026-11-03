/**
 * Row schemas for the ledger queries (transactions, accounts, planned
 * transactions, splits and the services that compose them) that are not
 * covered by the shared schemas in `../rowSchemas.ts` (ADR-193).
 *
 * Same rules as `rowSchemas.ts`: each schema describes what the SQLite driver
 * returns (the shapes node-postgres returned with its default parsers), only
 * checks (no transforms), and stays a plain `z.object` so added columns pass
 * through.
 */
import { z } from "zod";
import {
  accountRowSchema,
  balancePartsSchema,
  dbAccountId,
  dbBigint,
  dbCategoryId,
  dbCurrency,
  dbDate,
  dbDayString,
  dbInt,
  dbNumeric,
  dbPortfolioTransactionId,
  dbRecipientId,
  dbTagId,
  dbTransactionId,
  transactionSplitRowSchema,
} from "../rowSchemas.ts";

// ---------------------------------------------------------------------------
// Shared small projections
// ---------------------------------------------------------------------------

/** A bare `COUNT(*) AS n` row (an integer, so a number). */
export const intCountRowSchema = z
  .object({ n: dbInt })
  .describe("int count row");

/** A `COUNT(*) AS "n::bigint"` row (read as BIGINT, so a string). */
export const bigintCountRowSchema = z
  .object({ n: dbBigint })
  .describe("bigint count row");

/** A `SELECT id, slug FROM tags` row. */
export const tagSlugRowSchema = z
  .object({ id: dbTagId, slug: z.string() })
  .describe("tag slug row");

/** A `RETURNING transaction_id` / `SELECT transaction_id` row. */
export const transactionIdRowSchema = z
  .object({ transaction_id: dbTransactionId })
  .describe("transaction id row");

/** A row carrying only the `balance_parts` lateral (accountBalanceSql). */
export const balancePartsRowSchema = z
  .object({ balance_parts: balancePartsSchema })
  .describe("balance parts row");

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** `getAllWithCount`'s separate `COUNT(*) AS total` row (a number). */
export const transactionTotalRowSchema = z
  .object({ total: dbInt })
  .describe("transaction total row");

/** STAMP_RANGES_SQL: `to_char` day strings per account. */
export const stampedDateRangeRowSchema = z
  .object({
    account_id: dbAccountId,
    min_date: dbDayString,
    max_date: dbDayString,
  })
  .describe("stamped date range row");
export type StampedDateRangeRow = z.output<typeof stampedDateRangeRowSchema>;

/** OPENING_ANCHORS_SQL row. */
export const openingAnchorRowSchema = z
  .object({ account_id: dbAccountId, currency: dbCurrency })
  .describe("opening anchor row");
export type OpeningAnchorRow = z.output<typeof openingAnchorRowSchema>;

/** `listTransferCandidatePairs` row (quoted camelCase aliases). */
export const transferCandidatePairRowSchema = z
  .object({ outId: dbTransactionId, inId: dbTransactionId })
  .describe("transfer candidate pair row");
export type TransferCandidatePairRow = z.output<
  typeof transferCandidatePairRowSchema
>;

/** `lockTransferPeerPointer` row. */
export const transferPeerPointerRowSchema = z
  .object({ transfer_peer_id: dbTransactionId.nullable(), transfer_source: z.string().nullable().optional() })
  .describe("transfer peer pointer row");

/** `detectRecurringPatterns`' bespoke projection. */
export const recurringCandidateRowSchema = z
  .object({
    id: dbTransactionId,
    date: dbDate,
    amount: dbNumeric,
    currency: dbCurrency.nullable(),
    memo: z.string().nullable(),
    account_id: dbAccountId.nullable(),
    bank_account: z.string().nullable(),
    /** COALESCE(primary, own); the WHERE requires a recipient. */
    recipient_id: dbRecipientId,
    recipient_name: z.string().nullable(),
    effective_category_id: dbCategoryId.nullable(),
    category_name: z.string().nullable(),
  })
  .describe("recurring candidate row");
export type RecurringCandidateRow = z.output<
  typeof recurringCandidateRowSchema
>;

/** The recurring detector's planned-recipient probe. */
export const plannedRecipientIdRowSchema = z
  .object({ recipient_id: dbRecipientId })
  .describe("planned recipient id row");

/** A `to_regclass(...) IS NOT NULL AS exists` probe. */
export const tableExistsRowSchema = z
  .object({ exists: z.boolean() })
  .describe("table exists row");

/** A `buildExportChunkSql` row. */
export const exportTransactionRowSchema = z
  .object({
    id: dbTransactionId,
    /** DATE: read via `toYmd`, never `String()`/`toISOString()`. */
    date: dbDate,
    bank_account: z.string().nullable(),
    account_id: dbAccountId.nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    amount: dbNumeric,
    currency: dbCurrency.nullable(),
    /** NULL on manual rows. */
    balance: dbNumeric.nullable(),
    /** CASE ... ELSE '': '' when the transaction has no resolved category. */
    category_name: z.string(),
    comment: z.string().nullable(),
    /** COALESCE(array_agg(slug), '{}'): `[]` when none. */
    tags: z.array(z.string()),
  })
  .describe("export transaction row");
export type ExportTransactionRow = z.output<typeof exportTransactionRowSchema>;

/** `setOpeningBalance`'s earliest-activity probe (MIN over zero rows is NULL). */
export const earliestDateRowSchema = z
  .object({ earliest: dbDate.nullable() })
  .describe("earliest activity row");

/** A system adjustment row `RETURNING id, amount, transfer_source`. */
export const adjustmentRowSchema = z
  .object({
    id: dbTransactionId,
    amount: dbNumeric,
    /** Always the literal the INSERT wrote ('adjustment'). */
    transfer_source: z.string(),
  })
  .describe("adjustment transaction row");

/** `closeAccount`'s per-currency adjustment `RETURNING` row. */
export const closeAdjustmentRowSchema = adjustmentRowSchema
  .extend({ currency: dbCurrency })
  .describe("close adjustment transaction row");

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** `lockByIdForMerge` row. */
export const accountNameRowSchema = accountRowSchema
  .pick({ id: true, name: true })
  .describe("account name row");

/** `listOwners` row: the owner that attributes transactions to a tax partner. */
export const accountOwnerRowSchema = accountRowSchema
  .pick({ id: true, owner: true })
  .describe("account owner row");

/** `previewMerge`'s account probe. */
export const accountCurrencyRowSchema = accountRowSchema
  .pick({ id: true, currency: true })
  .describe("account currency row");

/** `closeAccount`'s active-state row, read in its write transaction. */
export const accountActiveRowSchema = accountRowSchema
  .pick({ id: true, is_active: true })
  .describe("account active row");

/** `reconcileAccount`'s drift read. */
export const reconcileDriftRowSchema = z
  .object({
    /** accounts.currency is NOT NULL. */
    account_currency: dbCurrency,
    reconcile_currency: dbCurrency,
    /** LEFT JOIN: NULL when the account has no statement figure. */
    statement_balance: dbNumeric.nullable(),
    balance_parts: balancePartsSchema,
  })
  .describe("reconcile drift row");

/** A statement balance upsert `RETURNING balance`. */
export const statementBalanceAmountRowSchema = z
  .object({ balance: dbNumeric })
  .describe("statement balance amount row");

/** `previewAccountPortfolioLots` row: `COUNT(*) OVER()` read with a `::bigint` hint. */
export const portfolioLotRowSchema = z
  .object({ id: dbPortfolioTransactionId, eligible_count: dbBigint })
  .describe("portfolio lot row");

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

/** `lockSplitForPayment` row. */
export const splitPaymentLockRowSchema = transactionSplitRowSchema
  .pick({ id: true, amount: true, is_settled: true })
  .describe("split payment lock row");

/** `COALESCE(SUM(amount), 0) AS paid` over split_payments: NUMERIC. */
export const splitPaidRowSchema = z
  .object({ paid: dbNumeric })
  .describe("split paid row");
