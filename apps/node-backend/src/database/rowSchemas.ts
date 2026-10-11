/**
 * Row schemas for the queries checked through `rowContracts.ts` (ADR-193).
 *
 * Each schema describes what node-postgres returns with its DEFAULT type
 * parsers, not the wire shape: NUMERIC/BIGINT/`COUNT(*)` are strings,
 * DATE/TIMESTAMPTZ are `Date`s, `COUNT(*)::int` and INTEGER are numbers, and
 * JSON columns arrive parsed. The matching TypeScript row types in
 * src/types/rows.ts are derived from these schemas, so the two cannot drift.
 *
 * Schemas only check: no coercion or transform (see `RowSchema`). Plain
 * `z.object` ignores columns it does not list, so `SELECT t.*` keeps working
 * when a migration adds a column. `.optional()` marks a column that only some
 * projections select; `.nullable()` marks SQL NULL.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// pg default parser primitives
// ---------------------------------------------------------------------------

/** INTEGER / SMALLINT / SERIAL, and any `::int` cast. */
export const pgInt = z.int();
/** NUMERIC / DECIMAL: the exact decimal text. */
export const pgNumeric = z.string();
/** BIGINT / BIGSERIAL / bare `COUNT(*)` / window `COUNT(*) OVER ()`. */
export const pgBigint = z.string();
/** DATE: a local-midnight `Date`, NOT a 'YYYY-MM-DD' string. */
export const pgDate = z.date();
/** TIMESTAMPTZ. */
export const pgTimestamptz = z.date();
/** A `to_char(..., 'YYYY-MM-DD')` projection. */
export const pgDayString = z.string();

/** A bare `SELECT COUNT(*)` row. */
export const countRowSchema = z
  .object({ count: pgBigint })
  .describe("count row");

/** A `SELECT id` / `RETURNING id` row over an INTEGER/SERIAL key. */
export const idRowSchema = z.object({ id: pgInt }).describe("id row");

/**
 * `computedBalanceByCurrencyAggLateral`'s jsonb partitions: `balance` is cast
 * `::text` in SQL, so a string; NULL when the account has no rows.
 */
export const balancePartsSchema = z
  .array(z.object({ currency: z.string(), balance: pgNumeric }))
  .nullable();

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A tag as attached to a transaction / planned transaction sub-collection. */
export const transactionTagRefSchema = z
  .object({
    id: pgInt,
    slug: z.string(),
    color: z.string().nullable(),
    is_active: z.boolean(),
  })
  .describe("tag ref row");

/** `attachTagsToRows`' junction read. */
export const transactionTagRowSchema = transactionTagRefSchema
  .extend({ transaction_id: pgInt })
  .describe("transaction tag row");

/** A row of `transactions` as returned by `SELECT t.*`. */
export const transactionRowSchema = z
  .object({
    id: pgInt,
    date: pgDate,
    /** NUMERIC(18,4) */
    amount: pgNumeric,
    /** VARCHAR(3); NOT NULL + DEFAULT 'EUR' from migration 0046, nullable on older rows. */
    currency: z.string().nullable(),
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7); NULL on manually-created rows (import pipeline only — ADR-094). */
    balance: pgNumeric.nullable(),
    memo: z.string().nullable(),
    comment: z.string().nullable(),
    /** Compatibility label projected from accounts.name; not stored after the ADR-088 contract operation. */
    bank_account: z.string().nullable().optional(),
    /** FK → accounts (migration 0050). */
    account_id: pgInt.nullable().optional(),
    recipient_id: pgInt.nullable(),
    recipient_bank_account_id: pgInt.nullable(),
    category_id: pgInt.nullable(),
    is_active: z.boolean(),
    /** BIGINT FK → import_batches. */
    import_batch_id: pgBigint.nullable().optional(),
    matched_pattern_id: pgInt.nullable().optional(),
    /** Internal SHA-256 of the staged literal record; omitted from API rows. */
    source_record_hash: z.string().nullable().optional(),
    /** Internal versioned import identity; omitted from API rows. */
    dedup_fingerprint: z.string().nullable().optional(),
    dedup_fingerprint_version: pgInt.nullable().optional(),
    is_transfer: z.boolean().optional(),
    transfer_peer_id: pgInt.nullable().optional(),
    transfer_source: z
      .enum(["auto", "manual", "opening", "adjustment", "brokerage"])
      .nullable()
      .optional(),
    created_at: pgTimestamptz.nullable().optional(),
    updated_at: pgTimestamptz.nullable().optional(),
  })
  .describe("transactions row");

/**
 * `transactionRowSchema` plus the joined/derived columns every list + detail
 * read projects, before `attachTagsToRows` adds `tags`.
 */
export const enrichedTransactionDbRowSchema = transactionRowSchema
  .extend({
    recipient_name: z.string().nullable(),
    category_name: z.string().nullable(),
    effective_category_id: pgInt.nullable().optional(),
    /** NUMERIC window sum, only with `includeBalance`. */
    running_balance: pgNumeric.optional(),
  })
  .describe("enriched transactions row");

/** A non-empty page row of `getUncategorisedWithCount`. */
export const uncategorisedPageRowSchema = enrichedTransactionDbRowSchema
  .extend({
    /** COUNT(*)::int */
    total_count: pgInt,
    /** ROW_NUMBER() is BIGINT. */
    _row_order: pgBigint,
  })
  .describe("uncategorised transactions page row");

/** The `total_count` every `getUncategorisedWithCount` row carries. */
export const uncategorisedTotalRowSchema = z
  .object({ total_count: pgInt })
  .describe("uncategorised transactions total row");

/** Projection of `listRecentUnlinked`; `transaction_date` is `t.date` aliased. */
export const unlinkedTransactionRowSchema = z
  .object({
    id: pgInt,
    recipient_id: pgInt.nullable(),
    recipient_cluster_id: pgInt.nullable(),
    amount: pgNumeric,
    transaction_date: pgDate,
    currency: z.string().nullable(),
    memo: z.string().nullable(),
    recipient_name: z.string().nullable(),
  })
  .describe("unlinked transactions row");

/** A `listTransferSuggestionRows` display row. */
export const transferSuggestionRowSchema = transactionRowSchema
  .pick({
    id: true,
    date: true,
    amount: true,
    currency: true,
    bank_account: true,
    memo: true,
    recipient_id: true,
  })
  .describe("transfer suggestion row");

/** A `lockTransferLegs` row. */
export const transferLegRowSchema = transactionRowSchema
  .pick({ id: true, amount: true, account_id: true, is_active: true })
  .describe("transfer leg row");

// ---------------------------------------------------------------------------
// Planned transactions
// ---------------------------------------------------------------------------

/** A row of `planned_transactions` as returned by `SELECT pt.*`. */
export const plannedTransactionRowSchema = z
  .object({
    id: pgInt,
    planned_date: pgDate,
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7) */
    amount: pgNumeric,
    currency: z.string().nullable(),
    memo: z.string().nullable(),
    comment: z.string().nullable(),
    url: z.string().nullable(),
    /** Compatibility label projected from accounts.name; not stored after the ADR-088 contract operation. */
    bank_account: z.string().nullable().optional(),
    account_id: pgInt.nullable().optional(),
    recipient_id: pgInt.nullable(),
    category_id: pgInt.nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    recurrence_end_date: pgDate.nullable().optional(),
    max_occurrences: pgInt.nullable().optional(),
    reminder_days_before: pgInt.nullable().optional(),
    is_loan: z.boolean(),
    loan_type: z.string().nullable(),
    loan_principal: pgNumeric.nullable(),
    loan_annual_interest_rate: pgNumeric.nullable(),
    loan_term_months: pgInt.nullable(),
    loan_start_date: pgDate.nullable(),
    loan_payment_day: pgInt.nullable(),
    loan_regular_payment_amount: pgNumeric.nullable(),
    loan_first_payment_date: pgDate.nullable(),
    is_executed: z.boolean(),
    last_executed_date: pgDate.nullable(),
    is_active: z.boolean(),
    created_at: pgTimestamptz.nullable().optional(),
    updated_at: pgTimestamptz.nullable().optional(),
  })
  .describe("planned_transactions row");

/** `plannedTransactionRowSchema` plus the `PLANNED_SELECT_FIELDS` join columns. */
export const plannedTransactionListRowSchema = plannedTransactionRowSchema
  .extend({
    recipient_name: z.string().nullable(),
    category_name: z.string().nullable(),
  })
  .describe("planned_transactions list row");

/** A `getAll` page row: the list row plus `COUNT(*) OVER()`. */
export const plannedTransactionPageRowSchema = plannedTransactionListRowSchema
  .extend({ total_count: pgBigint })
  .describe("planned_transactions page row");

/** A row of `planned_transaction_executions` (`SELECT *`, migration 0001). */
export const plannedExecutionRowSchema = z
  .object({
    id: pgInt,
    planned_transaction_id: pgInt,
    executed_transaction_id: pgInt,
    execution_date: pgDate,
    created_at: pgTimestamptz.nullable().optional(),
  })
  .describe("planned_transaction_executions row");

/** One installment of `planned_transaction_loan_schedule` (detail projection). */
export const loanScheduleRowSchema = z
  .object({
    installment_number: pgInt,
    due_date: pgDate,
    payment_amount: pgNumeric,
    principal_amount: pgNumeric,
    interest_amount: pgNumeric,
    remaining_principal: pgNumeric,
  })
  .describe("loan schedule row");

/** The list-path installment projection, keyed by its planned transaction. */
export const keyedLoanScheduleRowSchema = loanScheduleRowSchema
  .extend({ planned_transaction_id: pgInt })
  .describe("keyed loan schedule row");

/** The list-path tag projection, keyed by its planned transaction. */
export const plannedTagRowSchema = transactionTagRefSchema
  .extend({ planned_transaction_id: pgInt })
  .describe("planned transaction tag row");

/** Narrow projection of `listActiveUnexecuted`. */
export const plannedMatchCandidateRowSchema = z
  .object({
    id: pgInt,
    recipient_id: pgInt.nullable(),
    recipient_cluster_id: pgInt.nullable(),
    amount: pgNumeric,
    planned_date: pgDate,
    currency: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    memo: z.string().nullable(),
    recipient_name: z.string().nullable(),
  })
  .describe("planned match candidate row");

/** Narrow projection of `getForForecast`. */
export const plannedForecastRowSchema = z
  .object({
    id: pgInt,
    planned_date: pgDate,
    amount: pgNumeric,
    currency: z.string().nullable(),
    memo: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    recipient_name: z.string().nullable(),
    category_name: z.string().nullable(),
  })
  .describe("planned forecast row");

/** Narrow projection of `getForCommitmentProjection`. */
export const plannedCommitmentRowSchema = z
  .object({
    id: pgInt,
    planned_date: pgDate,
    amount: pgNumeric,
    currency: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    recurrence_end_date: pgDate.nullable(),
    max_occurrences: pgInt.nullable(),
    /** COUNT(*)::int */
    execution_count: pgInt,
  })
  .describe("planned commitment row");

// ---------------------------------------------------------------------------
// Accounts (ADR-088)
// ---------------------------------------------------------------------------

/** A row of `accounts` as projected by `accountRepository`'s `COLUMNS` list. */
export const accountRowSchema = z
  .object({
    id: pgInt,
    /** Canonical name; unique on `lower(btrim(name))` (migration 0066). */
    name: z.string(),
    display_name: z.string().nullable(),
    institution: z.string().nullable(),
    currency: z.string(),
    /** `account_type` enum: checking|savings|brokerage|crypto_exchange|wallet|pension|liability. */
    type: z.string(),
    /** `account_liquidity_class` enum. */
    liquidity_class: z.string(),
    spendable: z.boolean(),
    in_net_worth: z.boolean(),
    /** `account_tax_wrapper` enum. */
    tax_wrapper: z.string(),
    /** `account_owner` enum: me|partner|joint. */
    owner: z.string(),
    multi_currency_cash: z.boolean(),
    has_cash_sleeve: z.boolean(),
    funding_account_id: pgInt.nullable(),
    is_active: z.boolean(),
    closed_at: pgTimestamptz.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("accounts row");

/** Raw `accountRepository.getAll` row, before `accountService.list` shapes it. */
export const accountBalanceQueryRowSchema = accountRowSchema
  .extend({
    /** jsonb partitions; `balance` is cast `::text` in SQL, so a string. */
    balance_parts: balancePartsSchema,
    has_transactions: z.boolean(),
    anchor_date: pgDayString.nullable(),
    /** Bare COUNT(*) */
    post_anchor_count: pgBigint.nullable(),
    /**
     * json_build_object over the NUMERIC column: JSON encodes it as a number,
     * so `balance` arrives as a JS number (unlike `balance_parts`).
     */
    statement_balances: z
      .array(
        z.object({
          currency: z.string(),
          balance: z.number(),
          balance_date: pgDayString,
        }),
      )
      .nullable(),
  })
  .describe("account balance row");

/** An `account_statement_balances` row as `upsertStatementBalance` returns it. */
export const statementBalanceRowSchema = z
  .object({
    account_id: pgInt,
    currency: z.string(),
    balance: pgNumeric,
    balance_date: pgDayString,
  })
  .describe("account statement balance row");

// ---------------------------------------------------------------------------
// Splits (transaction_splits + split_payments)
// ---------------------------------------------------------------------------

/** A raw `transaction_splits` row (`SELECT *` / `RETURNING *`). */
export const transactionSplitRowSchema = z
  .object({
    id: pgInt,
    transaction_id: pgInt,
    recipient_id: pgInt,
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7) */
    amount: pgNumeric,
    note: z.string().nullable(),
    is_settled: z.boolean(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
    /** Joined on the read paths (the FK makes the LEFT JOIN always match). */
    recipient_name: z.string().optional(),
    /** NUMERIC sum of `split_payments` on the read paths. */
    amount_paid: pgNumeric.optional(),
  })
  .describe("transaction_splits row");

/** A raw `getOwedByRecipientRows` row: the split plus its parent transaction. */
export const owedSplitRawRowSchema = transactionSplitRowSchema
  .extend({
    transaction_date: pgDate,
    transaction_memo: z.string().nullable(),
    transaction_amount: pgNumeric,
    transaction_currency: z.string().nullable(),
    bank_account: z.string().nullable(),
    transaction_recipient_name: z.string().nullable(),
    amount_paid: pgNumeric,
  })
  .describe("owed split row");

/** A raw `getOwedExportRowsByRecipient` row, before `amount` is coerced. */
export const owedExportRawRowSchema = z
  .object({
    date: pgDate,
    bank_account: z.string().nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    /** NUMERIC remaining amount */
    amount: pgNumeric,
    currency: z.string().nullable(),
    balance: pgNumeric.nullable(),
    category_name: z.string(),
    comment: z.string().nullable(),
  })
  .describe("owed export row");

/** An `agg_split_outstanding` summary row (`getOwedSummaryRows`). */
export const splitOutstandingRowSchema = z
  .object({
    recipient_id: pgInt,
    recipient_name: z.string(),
    total_owed: pgNumeric,
    total_paid: pgNumeric,
    /** Bare COUNT() */
    split_count: pgBigint,
  })
  .describe("split outstanding row");

/** SPLIT_TOTALS_SQL: both aggregates are NUMERIC. */
export const splitTotalsRowSchema = z
  .object({
    transaction_total: pgNumeric,
    current_split_total: pgNumeric,
  })
  .describe("split totals row");

/** A raw `split_payments` row (`SELECT *` / `RETURNING *`). */
export const splitPaymentRowSchema = z
  .object({
    id: pgInt,
    split_id: pgInt,
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7) */
    amount: pgNumeric,
    paid_at: pgDate,
    note: z.string().nullable(),
    created_at: pgTimestamptz,
  })
  .describe("split_payments row");
