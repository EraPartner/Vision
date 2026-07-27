/**
 * Shared domain row contracts for the data layer.
 *
 * These typedefs describe what the repository queries ACTUALLY hand back, not
 * the idealised wire shape. That distinction is the whole point of the file —
 * `node-postgres` is used with its DEFAULT type parsers (there is no
 * `pg.types.setTypeParser` call anywhere in `src/`, see
 * {@link file://./../database/connection.js}), so:
 *
 *   | Postgres type        | JS value from pg      |
 *   |----------------------|-----------------------|
 *   | INTEGER / SMALLINT   | `number`              |
 *   | BIGINT / BIGSERIAL   | `string`  (!)         |
 *   | NUMERIC / DECIMAL    | `string`  (!)         |
 *   | REAL / DOUBLE        | `number`              |
 *   | BOOLEAN              | `boolean`             |
 *   | TEXT / VARCHAR       | `string`              |
 *   | DATE                 | `Date` (local midnight) |
 *   | TIMESTAMPTZ          | `Date`                |
 *   | JSONB                | parsed value          |
 *   | `COUNT(*)`           | `string` (bigint)     |
 *   | `COUNT(*)::int`      | `number`              |
 *   | `to_char(d, ...)`    | `string`              |
 *
 * Two families of typedef live here:
 *
 *   - `*Row` — the raw projection of a query. NUMERIC stays `string`, DATE stays
 *     `Date`.
 *   - `Formatted*` / `*Emitted` — the shape a repository returns AFTER its own
 *     mapper ran (`formatSplit`, `mapInvestmentRow`, `mapPortfolioTxRow`,
 *     `coerceNumericFields`, `toWireDate`). Those coerce NUMERIC → `number` and
 *     DATE → `'YYYY-MM-DD'`, so they are genuinely different types and are named
 *     differently on purpose.
 *
 * A `?` on a property means "may be absent from the projection" (the column is
 * only selected on some code paths); `| null` means "selected, but SQL NULL is
 * possible".
 *
 * @module types/rows
 */

// ---------------------------------------------------------------------------
// Query plumbing
// ---------------------------------------------------------------------------

/**
 * The slice of a `pg` client the repositories actually use — the callback
 * argument of `withTransaction()`, and the `{ query }` stand-in `writeAudit`
 * falls back to.
 *
 * Deliberately structural rather than `import('pg').PoolClient`: `pg` ships no
 * type declarations and `@types/pg` is not a dependency, so referencing its
 * types resolves to an implicit `any` (TS7016) under `noImplicitAny`.
 *
 * @typedef {object} QueryRunner
 * @property {(text: string, params?: any[]) => Promise<{ rows: any[], rowCount: number|null }>} query
 */

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * A row of `transactions` as returned by `SELECT t.*`.
 *
 * @typedef {object} TransactionRow
 * @property {number} id
 * @property {Date} date DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string.
 * @property {string} amount NUMERIC(18,4) — pg emits NUMERIC as a string.
 * @property {string|null} currency VARCHAR(3); NOT NULL + DEFAULT 'EUR' from migration 0046, nullable on older rows.
 * @property {string|null} balance NUMERIC(15,2); NULL on manually-created rows (import pipeline only — ADR-094).
 * @property {string|null} memo
 * @property {string|null} comment
 * @property {string|null} bank_account Denormalised account label; being retired in favour of `account_id` (ADR-088).
 * @property {number|null} [account_id] FK → accounts (migration 0050).
 * @property {number|null} recipient_id
 * @property {number|null} recipient_bank_account_id
 * @property {number|null} category_id
 * @property {boolean} is_active
 * @property {string|null} [import_batch_id] BIGINT FK → import_batches — pg emits BIGINT as a string.
 * @property {number|null} [matched_pattern_id]
 * @property {string|null} [tx_hash]
 * @property {boolean} [is_transfer]
 * @property {number|null} [transfer_peer_id]
 * @property {'auto'|'manual'|null} [transfer_source]
 * @property {Date|null} [created_at]
 * @property {Date|null} [updated_at]
 */

/**
 * A tag as attached to a transaction / planned transaction sub-collection.
 *
 * @typedef {object} TransactionTagRef
 * @property {number} id
 * @property {string} slug
 * @property {string|null} color
 * @property {boolean} is_active
 */

/**
 * `TransactionRow` plus the joined/derived columns every list + detail read in
 * `transactionRepository` projects, plus the `tags` sub-collection attached by
 * `attachTagsToRows`.
 *
 * @typedef {TransactionRow & {
 *   recipient_name: string|null,
 *   category_name: string|null,
 *   effective_category_id?: number|null,
 *   running_balance?: string,
 *   tags: TransactionTagRef[],
 * }} EnrichedTransactionRow
 */

/**
 * Projection of `transactionRepository.listRecentUnlinked` — the planned-match
 * candidate shape. `transaction_date` is `t.date` aliased, so still a `Date`.
 *
 * @typedef {object} UnlinkedTransactionRow
 * @property {number} id
 * @property {number|null} recipient_id
 * @property {number|null} recipient_cluster_id
 * @property {string} amount NUMERIC
 * @property {Date} transaction_date
 * @property {string|null} currency
 * @property {string|null} memo
 * @property {string|null} recipient_name
 */

// ---------------------------------------------------------------------------
// Planned transactions
// ---------------------------------------------------------------------------

/**
 * A row of `planned_transactions` as returned by `SELECT pt.*`.
 *
 * @typedef {object} PlannedTransactionRow
 * @property {number} id
 * @property {Date} planned_date DATE
 * @property {string} amount NUMERIC(15,2)
 * @property {string|null} currency
 * @property {string|null} memo
 * @property {string|null} comment
 * @property {string|null} url
 * @property {string|null} bank_account
 * @property {number|null} [account_id]
 * @property {number|null} recipient_id
 * @property {number|null} category_id
 * @property {boolean} is_recurring
 * @property {string|null} recurrence_pattern
 * @property {Date|null} [recurrence_end_date]
 * @property {number|null} [max_occurrences]
 * @property {number|null} [reminder_days_before]
 * @property {boolean} is_loan
 * @property {string|null} loan_type
 * @property {string|null} loan_principal NUMERIC
 * @property {string|null} loan_annual_interest_rate NUMERIC
 * @property {number|null} loan_term_months
 * @property {Date|null} loan_start_date
 * @property {number|null} loan_payment_day
 * @property {string|null} loan_regular_payment_amount NUMERIC
 * @property {Date|null} loan_first_payment_date
 * @property {boolean} is_executed
 * @property {Date|null} last_executed_date
 * @property {boolean} is_active
 * @property {Date|null} [created_at]
 * @property {Date|null} [updated_at]
 */

/**
 * A row of `planned_transaction_executions`.
 *
 * @typedef {object} PlannedExecutionRow
 * @property {number} id
 * @property {number} planned_transaction_id
 * @property {number} executed_transaction_id
 * @property {Date} execution_date DATE
 */

/**
 * One installment of `planned_transaction_loan_schedule`, as projected by the
 * hydration queries (the `planned_transaction_id` key is stripped on the list
 * path and never selected on the detail path).
 *
 * @typedef {object} LoanScheduleRow
 * @property {number} installment_number
 * @property {Date} due_date DATE
 * @property {string} payment_amount NUMERIC
 * @property {string} principal_amount NUMERIC
 * @property {string} interest_amount NUMERIC
 * @property {string} remaining_principal NUMERIC
 */

/**
 * `PlannedTransactionRow` with the shared `PLANNED_SELECT_FIELDS` join columns
 * and the sub-collections attached by `hydratePlannedRow` / `getAll`.
 *
 * @typedef {PlannedTransactionRow & {
 *   recipient_name: string|null,
 *   category_name: string|null,
 *   executions: PlannedExecutionRow[],
 *   execution_count: number,
 *   executed_transaction_id: number|null,
 *   loan_schedule: LoanScheduleRow[],
 *   tags: TransactionTagRef[],
 * }} HydratedPlannedTransactionRow
 */

/**
 * `PlannedTransactionRow` with just the join columns — the un-hydrated shape
 * `getDueSoon` returns.
 *
 * @typedef {PlannedTransactionRow & {
 *   recipient_name: string|null,
 *   category_name: string|null,
 * }} PlannedTransactionListRow
 */

/**
 * Narrow projection of `plannedTransactionRepository.listActiveUnexecuted`.
 *
 * @typedef {object} PlannedMatchCandidateRow
 * @property {number} id
 * @property {number|null} recipient_id
 * @property {number|null} recipient_cluster_id
 * @property {string} amount NUMERIC
 * @property {Date} planned_date DATE
 * @property {string|null} currency
 * @property {boolean} is_recurring
 * @property {string|null} recurrence_pattern
 * @property {string|null} memo
 * @property {string|null} recipient_name
 */

/**
 * Narrow projection of `plannedTransactionRepository.getForForecast`.
 *
 * @typedef {object} PlannedForecastRow
 * @property {number} id
 * @property {Date} planned_date DATE
 * @property {string} amount NUMERIC
 * @property {string|null} currency
 * @property {string|null} memo
 * @property {boolean} is_recurring
 * @property {string|null} recurrence_pattern
 * @property {string|null} recipient_name
 * @property {string|null} category_name
 */

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * A row of `recipients` as returned by `SELECT *` / `SELECT r.*`.
 *
 * @typedef {object} RecipientRow
 * @property {number} id
 * @property {string} name
 * @property {string} normalized_name
 * @property {number|null} default_category_id
 * @property {number|null} primary_recipient_id Merge target (self-referencing).
 * @property {string|null} notes
 * @property {boolean} is_active
 * @property {Date|null} [created_at]
 * @property {Date|null} [updated_at]
 */

/**
 * `RecipientRow` plus the derived columns the list / detail / update reads project.
 *
 * @typedef {RecipientRow & {
 *   default_category_name: string|null,
 *   primary_bank_account: string|null,
 *   primary_recipient_name: string|null,
 *   alias_count: number,
 * }} EnrichedRecipientRow
 */

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * A row of `categories`.
 *
 * @typedef {object} CategoryRow
 * @property {number} id
 * @property {string} general
 * @property {string} detail
 * @property {string|null} description
 * @property {boolean} is_active
 * @property {Date|null} [created_at]
 * @property {Date|null} [updated_at]
 */

/**
 * `CategoryRow` after `enrichCategory` adds the `GENERAL:DETAIL` display name.
 *
 * @typedef {CategoryRow & { category_name: string }} EnrichedCategoryRow
 */

// ---------------------------------------------------------------------------
// Accounts (ADR-088)
// ---------------------------------------------------------------------------

/**
 * A row of `accounts` as projected by `accountRepository`'s shared `COLUMNS`
 * list. `statement_balance_date` is `to_char(...)`-formatted in SQL, so it is a
 * calendar-day string rather than a `Date` — unlike `closed_at` / the timestamps.
 *
 * @typedef {object} AccountRow
 * @property {number} id
 * @property {string} name Canonical name; unique on `lower(btrim(name))` (migration 0066).
 * @property {string|null} display_name
 * @property {string|null} institution
 * @property {string} currency
 * @property {string} type `account_type` enum: checking|savings|brokerage|crypto_exchange|wallet|pension|liability.
 * @property {string} liquidity_class `account_liquidity_class` enum.
 * @property {boolean} spendable
 * @property {boolean} in_net_worth
 * @property {string} tax_wrapper `account_tax_wrapper` enum.
 * @property {string} owner `account_owner` enum: me|partner|joint.
 * @property {boolean} multi_currency_cash
 * @property {boolean} has_cash_sleeve
 * @property {number|null} funding_account_id
 * @property {string|null} statement_balance NUMERIC(15,2).
 * @property {string|null} statement_balance_date 'YYYY-MM-DD' — `to_char`-formatted in the projection.
 * @property {boolean} is_active
 * @property {Date|null} closed_at
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * `AccountRow` plus the balance/provenance columns `getAll` adds via
 * `COMPUTED_BALANCE_LATERAL`. `post_anchor_count` is re-emitted as a `number`
 * (the raw `COUNT(*)` bigint string is parsed) and both provenance fields become
 * `undefined` rather than `null` when nothing is stamped.
 *
 * @typedef {AccountRow & {
 *   computed_balance: string|null,
 *   drift: string|null,
 *   has_transactions: boolean,
 *   anchor_date?: string,
 *   post_anchor_count?: number,
 * }} AccountWithBalanceRow
 */

// ---------------------------------------------------------------------------
// Splits (transaction_splits + split_payments)
// ---------------------------------------------------------------------------

/**
 * A raw row of `transaction_splits` (`SELECT *` / `RETURNING *`). NOT what the
 * repository returns — every read path funnels through `formatSplit`.
 *
 * @typedef {object} TransactionSplitRow
 * @property {number} id
 * @property {number} transaction_id
 * @property {number} recipient_id
 * @property {string} amount NUMERIC(15,2)
 * @property {string|null} note
 * @property {boolean} is_settled
 * @property {Date} created_at
 * @property {Date} updated_at
 * @property {string} [recipient_name] Joined on the read paths.
 * @property {string} [amount_paid] NUMERIC sum of `split_payments` on the read paths.
 */

/**
 * What `formatSplit` emits: the canonical wire shape for a split. `amount` and
 * `amount_paid` are coerced to numbers; the timestamps stay `Date`.
 *
 * @typedef {object} FormattedSplit
 * @property {number} id
 * @property {number} transaction_id
 * @property {number} recipient_id
 * @property {string|null} recipient_name
 * @property {number} amount
 * @property {number} amount_paid
 * @property {string|null} note
 * @property {boolean} is_settled
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * `FormattedSplit` plus the parent-transaction columns `getOwedByRecipient`
 * projects and the derived `remaining`.
 *
 * @typedef {FormattedSplit & {
 *   transaction_date: Date,
 *   transaction_memo: string|null,
 *   transaction_amount: number,
 *   transaction_currency: string|null,
 *   bank_account: string|null,
 *   transaction_recipient_name: string|null,
 *   remaining: number,
 * }} OwedSplitDetailRow
 */

/**
 * A raw row of `split_payments` (`SELECT *` / `RETURNING *`).
 *
 * @typedef {object} SplitPaymentRow
 * @property {number} id
 * @property {number} split_id
 * @property {string} amount NUMERIC(15,2)
 * @property {Date} paid_at DATE
 * @property {string|null} note
 * @property {Date} created_at
 */

/**
 * What `formatPayment` emits: `amount` coerced to a number and `paid_at`
 * rendered as a calendar-day string.
 *
 * @typedef {object} FormattedSplitPayment
 * @property {number} id
 * @property {number} split_id
 * @property {number} amount
 * @property {string|null} paid_at 'YYYY-MM-DD'
 * @property {string|null} note
 * @property {Date} created_at
 */

/**
 * Split-allocation totals for a transaction, after `mapSplitTotals` coerces the
 * two NUMERIC aggregates.
 *
 * @typedef {object} SplitTotals
 * @property {number} transaction_total
 * @property {number} current_split_total
 */

// ---------------------------------------------------------------------------
// Investments + portfolio transactions
// ---------------------------------------------------------------------------

/**
 * A row of `investments` after `mapInvestmentRow`: the four NUMERIC columns in
 * `INVESTMENT_NUMERIC_FIELDS` are coerced to numbers and `maturity_date` is
 * rendered as a calendar-day string. Every other column is raw.
 *
 * Note `investments` is a plain table on fresh installs but a VIEW over
 * `investments_base` + child tables on legacy inheritance installs (ADR-109);
 * the projected shape is the same either way.
 *
 * @typedef {object} InvestmentRow
 * @property {number} id
 * @property {string} name
 * @property {string|null} symbol
 * @property {string} asset_class `asset_class` enum: stock|etf|crypto|metals|real_estate|savings|bond.
 * @property {string} currency
 * @property {number|null} current_price Coerced from NUMERIC(18,6).
 * @property {number|null} interest_rate Coerced from NUMERIC(8,4).
 * @property {string|null} maturity_date 'YYYY-MM-DD' — `toWireDate`-formatted.
 * @property {string|null} location
 * @property {string|null} municipality
 * @property {number|null} cadastral_income Coerced from NUMERIC(12,2).
 * @property {number|null} municipality_tax_rate Coerced from NUMERIC(8,4).
 * @property {string|null} notes
 * @property {boolean} is_active
 * @property {string} price_provider `price_provider` enum.
 * @property {string|null} price_provider_id
 * @property {string|null} price_provider_url
 * @property {string|null} [price_provider_latest_url] Absent on legacy schemas that predate the column.
 * @property {string|null} [price_provider_latest_path]
 * @property {string|null} [price_provider_history_url]
 * @property {string|null} [price_provider_history_path]
 * @property {string|null} [price_provider_history_ts_path]
 * @property {string|null} [price_provider_history_price_path]
 * @property {Date|null} price_updated_at
 * @property {boolean} [show_in_ticker] `COALESCE(tp.show_in_ticker, true)` — present on the joined reads (migration 0061), absent on a bare `RETURNING *`.
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * A row of `portfolio_transactions` after `mapPortfolioTxRow`: the six NUMERIC
 * columns are coerced to numbers and both DATE columns to 'YYYY-MM-DD' strings.
 *
 * @typedef {object} PortfolioTransactionRow
 * @property {number} id
 * @property {number} investment_id
 * @property {string} type `portfolio_txn_type` enum — see `@vision/types/portfolioTxnTypes`.
 * @property {string} date 'YYYY-MM-DD' — coerced from a DATE by `mapPortfolioTxRow`.
 * @property {number} amount Coerced from NUMERIC(18,4).
 * @property {number|null} units Coerced from NUMERIC(18,8).
 * @property {number|null} price_per_unit Coerced from NUMERIC(18,6).
 * @property {number|null} fees
 * @property {number|null} taxes
 * @property {string} currency
 * @property {number|null} fx_rate_to_eur Coerced from NUMERIC(20,10).
 * @property {string|null} note
 * @property {boolean} is_recurring
 * @property {string|null} recurrence_interval `recurrence_interval` enum.
 * @property {string|null} recurrence_end_date 'YYYY-MM-DD'
 * @property {number|null} [account_id] Owning account for the lot (ADR-091).
 * @property {Date} [created_at]
 * @property {Date} [updated_at]
 * @property {string} [asset_class] Not a column — only present when a caller merged the investment's class in.
 */

/**
 * Per-type aggregate from `portfolioTxRepo.reads.getSummary`.
 *
 * @typedef {object} PortfolioTransactionSummaryRow
 * @property {string} type
 * @property {number} total_amount
 * @property {number} total_units
 * @property {number} total_fees
 * @property {number} total_taxes
 * @property {number} count
 */

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * A row of `tags`.
 *
 * @typedef {object} TagRow
 * @property {number} id
 * @property {string} slug
 * @property {string|null} color
 * @property {boolean} is_active
 * @property {Date} created_at
 * @property {Date} updated_at
 */

// ---------------------------------------------------------------------------
// Import batches
// ---------------------------------------------------------------------------

/**
 * A row of `import_batches` as projected by `listBatches` / `getBatch`. `id` is
 * BIGSERIAL, so pg emits it as a string; `transactions_remaining` is
 * `COUNT(...)::int`, so it really is a number.
 *
 * @typedef {object} ImportBatchRow
 * @property {string} id BIGINT — string, not number.
 * @property {string} adapter_name
 * @property {string|null} source_filename
 * @property {string|null} source_size_bytes BIGINT — string.
 * @property {object|null} [custom_config] JSONB; only selected by `getBatch`.
 * @property {'pending'|'staging'|'validating'|'matching'|'committing'|'complete'|'failed'|'aborted'|'awaiting_review'} status
 * @property {number} rows_total
 * @property {number} rows_imported
 * @property {number} rows_duplicate
 * @property {number} rows_error
 * @property {string|null} error_summary
 * @property {Date} started_at
 * @property {Date|null} completed_at
 * @property {number} transactions_remaining
 */

export {};
