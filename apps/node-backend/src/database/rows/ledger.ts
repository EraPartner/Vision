/**
 * Row schemas for the ledger queries (transactions, accounts, planned
 * transactions, splits and the services that compose them) that are not
 * covered by the shared schemas in `../rowSchemas.ts` (ADR-193).
 *
 * Same rules as `rowSchemas.ts`: each schema describes what node-postgres
 * returns with its default parsers, only checks (no transforms), and stays a
 * plain `z.object` so added columns pass through.
 */
import { z } from "zod";
import {
  accountRowSchema,
  balancePartsSchema,
  pgBigint,
  pgDate,
  pgDayString,
  pgInt,
  pgNumeric,
  transactionSplitRowSchema,
} from "../rowSchemas.ts";

// ---------------------------------------------------------------------------
// Shared small projections
// ---------------------------------------------------------------------------

/** A `COUNT(*)::int AS n` row. */
export const intCountRowSchema = z
  .object({ n: pgInt })
  .describe("int count row");

/** A bare `COUNT(*) AS n` row (BIGINT, so a string). */
export const bigintCountRowSchema = z
  .object({ n: pgBigint })
  .describe("bigint count row");

/** A `SELECT id, slug FROM tags` row. */
export const tagSlugRowSchema = z
  .object({ id: pgInt, slug: z.string() })
  .describe("tag slug row");

/** A `RETURNING transaction_id` / `SELECT transaction_id` row. */
export const transactionIdRowSchema = z
  .object({ transaction_id: pgInt })
  .describe("transaction id row");

/** A row carrying only the `balance_parts` lateral (accountBalanceSql). */
export const balancePartsRowSchema = z
  .object({ balance_parts: balancePartsSchema })
  .describe("balance parts row");

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** `getAllWithCount`'s separate `COUNT(*)::int AS total` row. */
export const transactionTotalRowSchema = z
  .object({ total: pgInt })
  .describe("transaction total row");

/** STAMP_RANGES_SQL: `to_char` day strings per account. */
export const stampedDateRangeRowSchema = z
  .object({
    account_id: pgInt,
    min_date: pgDayString,
    max_date: pgDayString,
  })
  .describe("stamped date range row");
export type StampedDateRangeRow = z.output<typeof stampedDateRangeRowSchema>;

/** OPENING_ANCHORS_SQL row. */
export const openingAnchorRowSchema = z
  .object({ account_id: pgInt, currency: z.string() })
  .describe("opening anchor row");
export type OpeningAnchorRow = z.output<typeof openingAnchorRowSchema>;

/** `listTransferCandidatePairs` row (quoted camelCase aliases). */
export const transferCandidatePairRowSchema = z
  .object({ outId: pgInt, inId: pgInt })
  .describe("transfer candidate pair row");
export type TransferCandidatePairRow = z.output<
  typeof transferCandidatePairRowSchema
>;

/** `lockTransferPeerPointer` row. */
export const transferPeerPointerRowSchema = z
  .object({ transfer_peer_id: pgInt.nullable() })
  .describe("transfer peer pointer row");

/** `detectRecurringPatterns`' bespoke projection. */
export const recurringCandidateRowSchema = z
  .object({
    id: pgInt,
    date: pgDate,
    amount: pgNumeric,
    currency: z.string().nullable(),
    memo: z.string().nullable(),
    account_id: pgInt.nullable(),
    bank_account: z.string().nullable(),
    /** COALESCE(primary, own); the WHERE requires a recipient. */
    recipient_id: pgInt,
    recipient_name: z.string().nullable(),
    effective_category_id: pgInt.nullable(),
    category_name: z.string().nullable(),
  })
  .describe("recurring candidate row");
export type RecurringCandidateRow = z.output<
  typeof recurringCandidateRowSchema
>;

/** The recurring detector's planned-recipient probe. */
export const plannedRecipientIdRowSchema = z
  .object({ recipient_id: pgInt })
  .describe("planned recipient id row");

/** A `to_regclass(...) IS NOT NULL AS exists` probe. */
export const tableExistsRowSchema = z
  .object({ exists: z.boolean() })
  .describe("table exists row");

/** A `buildExportChunkSql` row. */
export const exportTransactionRowSchema = z
  .object({
    id: pgInt,
    /** DATE: read via `toYmd`, never `String()`/`toISOString()`. */
    date: pgDate,
    bank_account: z.string().nullable(),
    account_id: pgInt.nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    amount: pgNumeric,
    currency: z.string().nullable(),
    /** NULL on manual rows. */
    balance: pgNumeric.nullable(),
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
  .object({ earliest: pgDate.nullable() })
  .describe("earliest activity row");

/** A system adjustment row `RETURNING id, amount, transfer_source`. */
export const adjustmentRowSchema = z
  .object({
    id: pgInt,
    amount: pgNumeric,
    /** Always the literal the INSERT wrote ('adjustment'). */
    transfer_source: z.string(),
  })
  .describe("adjustment transaction row");

/** `closeAccount`'s per-currency adjustment `RETURNING` row. */
export const closeAdjustmentRowSchema = adjustmentRowSchema
  .extend({ currency: z.string() })
  .describe("close adjustment transaction row");

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** `lockByIdForMerge` row. */
export const accountNameRowSchema = accountRowSchema
  .pick({ id: true, name: true })
  .describe("account name row");

/** `previewMerge`'s account probe. */
export const accountCurrencyRowSchema = accountRowSchema
  .pick({ id: true, currency: true })
  .describe("account currency row");

/** `closeAccount`'s FOR UPDATE lock row. */
export const accountActiveRowSchema = accountRowSchema
  .pick({ id: true, is_active: true })
  .describe("account active row");

/** `reconcileAccount`'s drift read. */
export const reconcileDriftRowSchema = z
  .object({
    /** accounts.currency is NOT NULL. */
    account_currency: z.string(),
    reconcile_currency: z.string(),
    /** LEFT JOIN: NULL when the account has no statement figure. */
    statement_balance: pgNumeric.nullable(),
    balance_parts: balancePartsSchema,
  })
  .describe("reconcile drift row");

/** A statement balance upsert `RETURNING balance`. */
export const statementBalanceAmountRowSchema = z
  .object({ balance: pgNumeric })
  .describe("statement balance amount row");

/** `previewAccountPortfolioLots` row: `COUNT(*) OVER()` is BIGINT. */
export const portfolioLotRowSchema = z
  .object({ id: pgInt, eligible_count: pgBigint })
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
  .object({ paid: pgNumeric })
  .describe("split paid row");

/** `writeAudit`'s RETURNING row: `split_audit.id` is BIGSERIAL. */
export const splitAuditRowSchema = z
  .object({
    id: pgBigint,
    payload_text: z.string().nullable(),
    /** to_char of the NOT NULL created_at. */
    occurred_at: z.string(),
  })
  .describe("split audit row");
export type SplitAuditRow = z.output<typeof splitAuditRowSchema>;
