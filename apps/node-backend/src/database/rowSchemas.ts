/**
 * Row schemas for the queries checked through `rowContracts.ts` (ADR-193).
 *
 * Each schema describes what the database driver returns, not the wire
 * shape. The SQLite driver (src/database/connection.ts, ADR-263) returns the
 * shapes node-postgres returned with its default type parsers:
 * NUMERIC/BIGINT/`COUNT(*)` with a `::bigint` alias hint are strings,
 * DATE/TIMESTAMPTZ are `Date`s, INTEGER and a bare `count(*)` are numbers, and
 * JSON columns arrive parsed. The primitives keep their `pg*` names. The matching TypeScript row types in
 * src/types/rows.ts are derived from these schemas, so the two cannot drift.
 *
 * Schemas only check: no coercion or transform (see `RowSchema`). Plain
 * `z.object` ignores columns it does not list, so `SELECT t.*` keeps working
 * when a migration adds a column. `.optional()` marks a column that only some
 * projections select; `.nullable()` marks SQL NULL.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Driver value primitives (named after the PostgreSQL types they stand for)
// ---------------------------------------------------------------------------

/** INTEGER / SMALLINT / SERIAL, and a bare SQLite `count(*)`. */
export const dbInt = z.int();
/** NUMERIC / DECIMAL: the exact decimal text. */
export const dbNumeric = z.string();
/** BIGINT / BIGSERIAL, and `count(*)` read with a `::bigint` alias hint. */
export const dbBigint = z.string();
/** DATE: a local-midnight `Date`, NOT a 'YYYY-MM-DD' string. */
export const dbDate = z.date();
/** TIMESTAMPTZ. */
export const dbTimestamptz = z.date();
/** A `to_char(..., 'YYYY-MM-DD')` projection (a Vision SQL function). */
export const dbDayString = z.string();

// ---------------------------------------------------------------------------
// Branded keys and currency codes (ADR-220)
// ---------------------------------------------------------------------------

/*
 * `.brand<B, "inout">()` tags input and output alike and is a no-op at
 * runtime: the check is still the plain primitive's and the row passes through
 * untouched, so these satisfy `RowSchema<T>` (input = output) while a real
 * transform still fails to compile. The tag matches `@vision/types/brands`.
 */

/** `accounts.id` and every column referencing it. */
export const dbAccountId = z.int().brand<"AccountId", "inout">();
/** `transactions.id` and every column referencing it. */
export const dbTransactionId = z.int().brand<"TransactionId", "inout">();
/** `categories.id` and every column referencing it. */
export const dbCategoryId = z.int().brand<"CategoryId", "inout">();
/** `recipients.id` and every column referencing it. */
export const dbRecipientId = z.int().brand<"RecipientId", "inout">();
/** `tags.id` and every column referencing it. */
export const dbTagId = z.int().brand<"TagId", "inout">();
/** `transaction_splits.id` and every column referencing it. */
export const dbSplitId = z.int().brand<"SplitId", "inout">();
/** `planned_transactions.id` and every column referencing it. */
export const dbPlannedTransactionId = z.int().brand<"PlannedTransactionId", "inout">();
/** `investments.id` and every column referencing it. */
export const dbInvestmentId = z.int().brand<"InvestmentId", "inout">();
/** `portfolio_transactions.id` and every column referencing it. */
export const dbPortfolioTransactionId = z.int().brand<"PortfolioTransactionId", "inout">();

/**
 * A currency column. The ISO shape is enforced by the tables' CHECK
 * constraints, not here: some are NOT VALID on long-lived databases, and a
 * legacy row must not turn every read of it into a contract failure.
 */
export const dbCurrency = z.string().brand<"CurrencyCode", "inout">();

/** A bare `SELECT COUNT(*)` row. */
export const countRowSchema = z
  .object({ count: dbBigint })
  .describe("count row");

/** A `SELECT id` / `RETURNING id` row over an INTEGER/SERIAL key. */
export const idRowSchema = z.object({ id: dbInt }).describe("id row");

/** `SELECT id` / `RETURNING id` over `accounts`. */
export const accountKeyRowSchema = z
  .object({ id: dbAccountId })
  .describe("account id row");
/** `SELECT id` / `RETURNING id` over `transactions`. */
export const transactionKeyRowSchema = z
  .object({ id: dbTransactionId })
  .describe("transaction id row");
/** `SELECT id` / `RETURNING id` over `categories`. */
export const categoryKeyRowSchema = z
  .object({ id: dbCategoryId })
  .describe("category id row");
/** `SELECT id` / `RETURNING id` over `recipients`. */
export const recipientKeyRowSchema = z
  .object({ id: dbRecipientId })
  .describe("recipient id row");
/** `SELECT id` / `RETURNING id` over `planned_transactions`. */
export const plannedTransactionKeyRowSchema = z
  .object({ id: dbPlannedTransactionId })
  .describe("planned transaction id row");
/** `SELECT id` / `RETURNING id` over `tags`. */
export const tagKeyRowSchema = z.object({ id: dbTagId }).describe("tag id row");
/**
 * `SELECT id` / `RETURNING id` over `transaction_splits`.
 * @public
 */
export const splitKeyRowSchema = z
  .object({ id: dbSplitId })
  .describe("split id row");

/**
 * `computedBalanceByCurrencyAggLateral`'s jsonb partitions: `balance` is cast
 * `::text` in SQL, so a string; NULL when the account has no rows.
 */
export const balancePartsSchema = z
  .array(z.object({ currency: dbCurrency, balance: dbNumeric }))
  .nullable();

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A tag as attached to a transaction / planned transaction sub-collection. */
export const transactionTagRefSchema = z
  .object({
    id: dbTagId,
    slug: z.string(),
    color: z.string().nullable(),
    is_active: z.boolean(),
  })
  .describe("tag ref row");

/** `attachTagsToRows`' junction read. */
export const transactionTagRowSchema = transactionTagRefSchema
  .extend({ transaction_id: dbTransactionId })
  .describe("transaction tag row");

/** A row of `transactions` as returned by `SELECT t.*`. */
export const transactionRowSchema = z
  .object({
    id: dbTransactionId,
    date: dbDate,
    /** NUMERIC(18,4) */
    amount: dbNumeric,
    /** VARCHAR(3); NOT NULL + DEFAULT 'EUR' from migration 0046, nullable on older rows. */
    currency: dbCurrency.nullable(),
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7); NULL on manually-created rows (import pipeline only — ADR-094). */
    balance: dbNumeric.nullable(),
    /** Internal bank chronology; omitted from API rows. */
    bank_sequence: dbNumeric.nullable().optional(),
    memo: z.string().nullable(),
    comment: z.string().nullable(),
    /** Compatibility label projected from accounts.name; not stored after the ADR-088 contract operation. */
    bank_account: z.string().nullable().optional(),
    /** FK → accounts (migration 0050). */
    account_id: dbAccountId.nullable().optional(),
    recipient_id: dbRecipientId.nullable(),
    recipient_bank_account_id: dbInt.nullable(),
    category_id: dbCategoryId.nullable(),
    is_active: z.boolean(),
    /** BIGINT FK → import_batches. */
    import_batch_id: dbBigint.nullable().optional(),
    matched_pattern_id: dbInt.nullable().optional(),
    /** Internal SHA-256 of the staged literal record; omitted from API rows. */
    source_record_hash: z.string().nullable().optional(),
    /** Internal versioned import identity; omitted from API rows. */
    dedup_fingerprint: z.string().nullable().optional(),
    dedup_fingerprint_version: dbInt.nullable().optional(),
    is_transfer: z.boolean().optional(),
    transfer_peer_id: dbTransactionId.nullable().optional(),
    transfer_source: z
      .enum(["auto", "manual", "opening", "adjustment", "brokerage"])
      .nullable()
      .optional(),
    created_at: dbTimestamptz.nullable().optional(),
    updated_at: dbTimestamptz.nullable().optional(),
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
    effective_category_id: dbCategoryId.nullable().optional(),
    /** NUMERIC window sum, only with `includeBalance`. */
    running_balance: dbNumeric.optional(),
  })
  .describe("enriched transactions row");

/** A non-empty page row of `getUncategorisedWithCount`. */
export const uncategorisedPageRowSchema = enrichedTransactionDbRowSchema
  .extend({
    /** COUNT(*)::int */
    total_count: dbInt,
    /** ROW_NUMBER() is BIGINT. */
    _row_order: dbBigint,
  })
  .describe("uncategorised transactions page row");

/** The `total_count` every `getUncategorisedWithCount` row carries. */
export const uncategorisedTotalRowSchema = z
  .object({ total_count: dbInt })
  .describe("uncategorised transactions total row");

/** Projection of `listRecentUnlinked`; `transaction_date` is `t.date` aliased. */
export const unlinkedTransactionRowSchema = z
  .object({
    id: dbTransactionId,
    recipient_id: dbRecipientId.nullable(),
    recipient_cluster_id: dbRecipientId.nullable(),
    amount: dbNumeric,
    transaction_date: dbDate,
    currency: dbCurrency.nullable(),
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
  .pick({ id: true, amount: true, account_id: true, is_active: true, transfer_source: true })
  .describe("transfer leg row");

// ---------------------------------------------------------------------------
// Planned transactions
// ---------------------------------------------------------------------------

/** A row of `planned_transactions` as returned by `SELECT pt.*`. */
export const plannedTransactionRowSchema = z
  .object({
    id: dbPlannedTransactionId,
    planned_date: dbDate,
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7) */
    amount: dbNumeric,
    currency: dbCurrency.nullable(),
    memo: z.string().nullable(),
    comment: z.string().nullable(),
    url: z.string().nullable(),
    /** Compatibility label projected from accounts.name; not stored after the ADR-088 contract operation. */
    bank_account: z.string().nullable().optional(),
    account_id: dbAccountId.nullable().optional(),
    recipient_id: dbRecipientId.nullable(),
    category_id: dbCategoryId.nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    recurrence_end_date: dbDate.nullable().optional(),
    max_occurrences: dbInt.nullable().optional(),
    reminder_days_before: dbInt.nullable().optional(),
    is_loan: z.boolean(),
    loan_type: z.string().nullable(),
    loan_principal: dbNumeric.nullable(),
    loan_annual_interest_rate: dbNumeric.nullable(),
    loan_term_months: dbInt.nullable(),
    loan_start_date: dbDate.nullable(),
    loan_payment_day: dbInt.nullable(),
    loan_regular_payment_amount: dbNumeric.nullable(),
    loan_first_payment_date: dbDate.nullable(),
    is_executed: z.boolean(),
    last_executed_date: dbDate.nullable(),
    is_active: z.boolean(),
    created_at: dbTimestamptz.nullable().optional(),
    updated_at: dbTimestamptz.nullable().optional(),
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
  .extend({ total_count: dbBigint })
  .describe("planned_transactions page row");

/** A row of `planned_transaction_executions` (`SELECT *`, migration 0001). */
export const plannedExecutionRowSchema = z
  .object({
    id: dbInt,
    planned_transaction_id: dbPlannedTransactionId,
    executed_transaction_id: dbTransactionId,
    execution_date: dbDate,
    created_at: dbTimestamptz.nullable().optional(),
  })
  .describe("planned_transaction_executions row");

/** One installment of `planned_transaction_loan_schedule` (detail projection). */
export const loanScheduleRowSchema = z
  .object({
    installment_number: dbInt,
    due_date: dbDate,
    payment_amount: dbNumeric,
    principal_amount: dbNumeric,
    interest_amount: dbNumeric,
    remaining_principal: dbNumeric,
  })
  .describe("loan schedule row");

/** The list-path installment projection, keyed by its planned transaction. */
export const keyedLoanScheduleRowSchema = loanScheduleRowSchema
  .extend({ planned_transaction_id: dbPlannedTransactionId })
  .describe("keyed loan schedule row");

/** The list-path tag projection, keyed by its planned transaction. */
export const plannedTagRowSchema = transactionTagRefSchema
  .extend({ planned_transaction_id: dbPlannedTransactionId })
  .describe("planned transaction tag row");

/** Narrow projection of `listActiveUnexecuted`. */
export const plannedMatchCandidateRowSchema = z
  .object({
    id: dbPlannedTransactionId,
    recipient_id: dbRecipientId.nullable(),
    recipient_cluster_id: dbRecipientId.nullable(),
    amount: dbNumeric,
    planned_date: dbDate,
    currency: dbCurrency.nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    memo: z.string().nullable(),
    recipient_name: z.string().nullable(),
  })
  .describe("planned match candidate row");

/** Narrow projection of `getForForecast`. */
export const plannedForecastRowSchema = z
  .object({
    id: dbPlannedTransactionId,
    planned_date: dbDate,
    amount: dbNumeric,
    currency: dbCurrency.nullable(),
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
    id: dbPlannedTransactionId,
    planned_date: dbDate,
    amount: dbNumeric,
    currency: dbCurrency.nullable(),
    is_recurring: z.boolean(),
    recurrence_pattern: z.string().nullable(),
    recurrence_end_date: dbDate.nullable(),
    max_occurrences: dbInt.nullable(),
    /** COUNT(*)::int */
    execution_count: dbInt,
  })
  .describe("planned commitment row");

// ---------------------------------------------------------------------------
// Accounts (ADR-088)
// ---------------------------------------------------------------------------

/** A row of `accounts` as projected by `accountRepository`'s `COLUMNS` list. */
export const accountRowSchema = z
  .object({
    id: dbAccountId,
    /** Canonical name; unique on `lower(btrim(name))` (migration 0066). */
    name: z.string(),
    display_name: z.string().nullable(),
    institution: z.string().nullable(),
    currency: dbCurrency,
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
    funding_account_id: dbAccountId.nullable(),
    is_active: z.boolean(),
    closed_at: dbTimestamptz.nullable(),
    created_at: dbTimestamptz,
    updated_at: dbTimestamptz,
  })
  .describe("accounts row");

/** Raw `accountRepository.getAll` row, before `accountService.list` shapes it. */
export const accountBalanceQueryRowSchema = accountRowSchema
  .extend({
    /** jsonb partitions; `balance` is cast `::text` in SQL, so a string. */
    balance_parts: balancePartsSchema,
    has_transactions: z.boolean(),
    anchor_date: dbDayString.nullable(),
    /** Bare COUNT(*) */
    post_anchor_count: dbBigint.nullable(),
    /**
     * json_build_object over the NUMERIC column: JSON encodes it as a number,
     * so `balance` arrives as a JS number (unlike `balance_parts`).
     */
    statement_balances: z
      .array(
        z.object({
          currency: dbCurrency,
          balance: z.number(),
          balance_date: dbDayString,
        }),
      )
      .nullable(),
  })
  .describe("account balance row");

/** An `account_statement_balances` row as `upsertStatementBalance` returns it. */
export const statementBalanceRowSchema = z
  .object({
    account_id: dbAccountId,
    currency: dbCurrency,
    balance: dbNumeric,
    balance_date: dbDayString,
  })
  .describe("account statement balance row");

// ---------------------------------------------------------------------------
// Splits (transaction_splits + split_payments)
// ---------------------------------------------------------------------------

/** A raw `transaction_splits` row (`SELECT *` / `RETURNING *`). */
export const transactionSplitRowSchema = z
  .object({
    id: dbSplitId,
    transaction_id: dbTransactionId,
    recipient_id: dbRecipientId,
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7) */
    amount: dbNumeric,
    note: z.string().nullable(),
    is_settled: z.boolean(),
    created_at: dbTimestamptz,
    updated_at: dbTimestamptz,
    /** Joined on the read paths (the FK makes the LEFT JOIN always match). */
    recipient_name: z.string().optional(),
    /** NUMERIC sum of `split_payments` on the read paths. */
    amount_paid: dbNumeric.optional(),
  })
  .describe("transaction_splits row");

/** A raw `getOwedByRecipientRows` row: the split plus its parent transaction. */
export const owedSplitRawRowSchema = transactionSplitRowSchema
  .extend({
    transaction_date: dbDate,
    transaction_memo: z.string().nullable(),
    transaction_amount: dbNumeric,
    transaction_currency: dbCurrency.nullable(),
    bank_account: z.string().nullable(),
    transaction_recipient_name: z.string().nullable(),
    amount_paid: dbNumeric,
  })
  .describe("owed split row");

/** A raw `getOwedExportRowsByRecipient` row, before `amount` is coerced. */
export const owedExportRawRowSchema = z
  .object({
    date: dbDate,
    bank_account: z.string().nullable(),
    recipient_name: z.string().nullable(),
    memo: z.string().nullable(),
    /** NUMERIC remaining amount */
    amount: dbNumeric,
    currency: dbCurrency.nullable(),
    balance: dbNumeric.nullable(),
    category_name: z.string(),
    comment: z.string().nullable(),
  })
  .describe("owed export row");

/** An `agg_split_outstanding` summary row (`getOwedSummaryRows`). */
export const splitOutstandingRowSchema = z
  .object({
    recipient_id: dbRecipientId,
    recipient_name: z.string(),
    total_owed: dbNumeric,
    total_paid: dbNumeric,
    /** Bare COUNT() */
    split_count: dbBigint,
  })
  .describe("split outstanding row");

/** `getOwedSummaryRows`: one row per (recipient group, transaction currency). */
export const splitOutstandingCurrencyRowSchema = splitOutstandingRowSchema
  .extend({ currency: dbCurrency.nullable() })
  .describe("split outstanding currency row");

/** `getOwedRemainingByCurrency`: a recipient group's unsettled remainder per currency. */
export const owedRemainingCurrencyRowSchema = z
  .object({
    currency: dbCurrency.nullable(),
    remaining: dbNumeric,
    /** Bare COUNT() */
    split_count: dbBigint,
  })
  .describe("owed remaining currency row");

/** SPLIT_TOTALS_SQL: both aggregates are NUMERIC. */
export const splitTotalsRowSchema = z
  .object({
    transaction_total: dbNumeric,
    current_split_total: dbNumeric,
  })
  .describe("split totals row");

/** A raw `split_payments` row (`SELECT *` / `RETURNING *`). */
export const splitPaymentRowSchema = z
  .object({
    id: dbInt,
    split_id: dbSplitId,
    /** NUMERIC(18,4) since migration 0088 (ADR-060 D7) */
    amount: dbNumeric,
    paid_at: dbDate,
    note: z.string().nullable(),
    created_at: dbTimestamptz,
  })
  .describe("split_payments row");
