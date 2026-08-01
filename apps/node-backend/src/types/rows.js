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
 * A row of `planned_transaction_executions` (`SELECT *`, migration 0001).
 *
 * @typedef {object} PlannedExecutionRow
 * @property {number} id
 * @property {number} planned_transaction_id
 * @property {number} executed_transaction_id
 * @property {Date} execution_date DATE
 * @property {Date|null} [created_at] TIMESTAMPTZ DEFAULT NOW().
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
 * A row of `recipient_bank_accounts` (`SELECT *` / `RETURNING *`; baseline
 * schema).
 *
 * @typedef {object} RecipientBankAccountRow
 * @property {number} id
 * @property {number|null} recipient_id
 * @property {string} account_number VARCHAR(34), stored trimmed + uppercased.
 * @property {string|null} bank_name
 * @property {string|null} account_label
 * @property {string|null} address
 * @property {boolean} is_primary
 * @property {boolean} is_active
 * @property {Date|null} created_at
 * @property {Date|null} updated_at
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

/**
 * A row of `recipient_match_patterns` as returned by `SELECT *` (migration
 * 0015). `pattern_kind` is CHECK-constrained to 'regex'|'glob'|'literal_prefix',
 * `source` to 'user'|'suggested'|'system' — kept as plain `string` here since
 * Postgres CHECK constraints are not reflected in the driver's row shape.
 *
 * @typedef {object} RecipientMatchPatternRow
 * @property {number} id SERIAL
 * @property {number} recipient_id FK → recipients, ON DELETE CASCADE
 * @property {string} pattern
 * @property {string} pattern_kind 'regex'|'glob'|'literal_prefix', DEFAULT 'literal_prefix'
 * @property {boolean} case_sensitive DEFAULT false
 * @property {number} priority DEFAULT 100
 * @property {boolean} is_active DEFAULT true
 * @property {string} source 'user'|'suggested'|'system', DEFAULT 'user'
 * @property {string|null} notes
 * @property {Date} created_at TIMESTAMPTZ
 * @property {Date} updated_at TIMESTAMPTZ
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
 * `COMPUTED_BALANCE_LATERAL` + `computedBalanceByCurrencyAggLateral`.
 * `post_anchor_count` is re-emitted as a `number` (the raw `COUNT(*)` bigint
 * string is parsed) and both provenance fields become `undefined` rather than
 * `null` when nothing is stamped. `computed_balance` (Σ of the account's
 * currency partitions, converted into `currency`), `reconcilable_balance` (the
 * reconciliation base — `statementPartition`, in `reconcilable_currency`) and
 * `drift` (statement figure − that base) are derived in JS from the partitions,
 * so they are `number`s — matching the OpenAPI schema — rather than pg NUMERIC
 * strings. The three native figures satisfy
 * `drift = statement_balance − reconcilable_balance`.
 *
 * @typedef {AccountRow & {
 *   computed_balance: number,
 *   reconcilable_balance: number,
 *   reconcilable_currency: string,
 *   drift: number|null,
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
 * @property {number|null} [import_batch_id] The portfolio import batch that created
 *           this lot (migration 0086); NULL for manual entry and for lots committed
 *           before 0086 applied. Rollback bulk-deletes on it.
 * @property {Date} [created_at]
 * @property {Date} [updated_at]
 * @property {string} [asset_class] Not a column — only present when a caller merged the investment's class in.
 */

/**
 * A row of `portfolioTxRepo.reads.getRowsForPortfolioMath` — portfolio_transactions
 * JOINed to investments, deliberately NOT passed through `mapPortfolioTxRow` (see
 * that function's comment): every NUMERIC column stays a pg string, and the
 * transaction day is emitted under both `date` and `day` (identical values).
 *
 * @typedef {object} PortfolioMathTxRow
 * @property {number} id
 * @property {number} investment_id
 * @property {string} type `portfolio_txn_type` enum.
 * @property {string} amount NUMERIC(18,4), `COALESCE(pt.amount, 0)` — pg emits NUMERIC as a string.
 * @property {string} units NUMERIC(18,8), `COALESCE(pt.units, 0)`.
 * @property {string} fees NUMERIC, `COALESCE(pt.fees, 0)`.
 * @property {string} taxes NUMERIC, `COALESCE(pt.taxes, 0)`.
 * @property {string} date 'YYYY-MM-DD' — `to_char(pt.date::date, …)`.
 * @property {string} day 'YYYY-MM-DD' — same value as `date`, second alias.
 * @property {string} currency `COALESCE(pt.currency, i.currency, 'EUR')`.
 * @property {string|null} fx_rate_to_eur NUMERIC(20,10), not coalesced — null when unset.
 * @property {number|null} account_id
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
// Saved charts
// ---------------------------------------------------------------------------

/**
 * A row of `saved_charts` as projected by `savedChartsRepository`'s shared
 * `COLUMNS` list (baseline + migrations 0017/0063/0064). The two DATE columns
 * are `to_char`-formatted in SQL, so they are calendar-day strings, not `Date`s.
 * INTEGER[] columns come back from pg as `number[]` already; the repository's
 * `mapRow` re-normalises them (and the three booleans) defensively without
 * changing the type, so raw and emitted shapes coincide.
 *
 * @typedef {object} SavedChartRow
 * @property {number} id
 * @property {string} name
 * @property {string} chart_type
 * @property {number[]} category_ids INTEGER[].
 * @property {number[]} recipient_ids INTEGER[].
 * @property {number[]} tag_ids INTEGER[] (migration 0063).
 * @property {boolean} all_categories
 * @property {boolean} all_recipients
 * @property {boolean} all_tags
 * @property {string} chart_variant
 * @property {string} time_bucket
 * @property {string|null} date_range_start 'YYYY-MM-DD' — `to_char`-formatted in the projection.
 * @property {string|null} date_range_end 'YYYY-MM-DD' — `to_char`-formatted in the projection.
 * @property {Date} created_at
 * @property {Date} updated_at
 */

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

/**
 * A raw row of `watchlist` (`SELECT *` / `RETURNING *`; baseline schema +
 * migration 0058). NOT what the repository returns — every read funnels
 * through `mapWatchlistRow`.
 *
 * @typedef {object} WatchlistRow
 * @property {number} id
 * @property {string} name
 * @property {string|null} symbol
 * @property {string} asset_class `asset_class` enum: stock|etf|crypto|metals|real_estate|savings|bond.
 * @property {string} target_price NUMERIC(18,6) — pg emits NUMERIC as a string.
 * @property {string} currency
 * @property {string|null} notes
 * @property {string|null} price_provider_id
 * @property {string|null} added_price NUMERIC(18,6); NULL on rows predating migration 0058.
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * A `watchlist` row after `mapWatchlistRow` coerced the two NUMERIC columns
 * (`WATCHLIST_NUMERIC_FIELDS`) to numbers.
 *
 * @typedef {object} FormattedWatchlistRow
 * @property {number} id
 * @property {string} name
 * @property {string|null} symbol
 * @property {string} asset_class
 * @property {number} target_price
 * @property {string} currency
 * @property {string|null} notes
 * @property {string|null} price_provider_id
 * @property {number|null} added_price
 * @property {Date} created_at
 * @property {Date} updated_at
 * @property {number|null} [current_price] Not a column — only present when a caller (the watchlist route) merged the live quote in; bare repository reads never emit it.
 * @property {number|null} [price_change] Not a column — merged in by the watchlist route alongside `current_price`.
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
// AI chat (ai_conversations + ai_messages)
// ---------------------------------------------------------------------------

/**
 * An `ai_conversations` row as projected by `aiChatRepository`'s
 * `CONVERSATION_COLUMNS` — the timestamps are aliased to camelCase in SQL.
 *
 * @typedef {object} AiConversationRow
 * @property {string} id UUID.
 * @property {string} title
 * @property {string} model
 * @property {Date} createdAt Aliased from `created_at` (TIMESTAMPTZ).
 * @property {Date} updatedAt Aliased from `updated_at` (TIMESTAMPTZ).
 */

/**
 * An `ai_messages` row as projected by `aiChatRepository`'s `MESSAGE_COLUMNS`
 * — the snake_case columns are aliased to camelCase in SQL.
 *
 * @typedef {object} AiMessageRow
 * @property {string} id UUID.
 * @property {string} conversationId UUID FK → ai_conversations.
 * @property {'user'|'assistant'|'tool'|'system'} role
 * @property {string|null} content
 * @property {string|null} toolName
 * @property {any} toolArgs JSONB — parsed value or null.
 * @property {any} toolResult JSONB — parsed value or null.
 * @property {'complete'|'streaming'|'aborted'|'error'} status
 * @property {Date} createdAt
 */

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * A raw row of `attachments` (`SELECT *` / `RETURNING *`, migration 0004). All
 * three BIGINT columns come back from pg as strings.
 *
 * @typedef {object} AttachmentRow
 * @property {string} id BIGSERIAL — string, not number.
 * @property {string} transaction_id BIGINT FK → transactions — string.
 * @property {string} filename
 * @property {string} stored_path
 * @property {string} mime_type
 * @property {string} size_bytes BIGINT — string.
 * @property {Date} created_at
 */

/**
 * What `attachmentRepository`'s `formatRow` emits: `size_bytes` coerced to a
 * number; `id` / `transaction_id` stay BIGINT strings.
 *
 * @typedef {object} FormattedAttachment
 * @property {string} id
 * @property {string} transaction_id
 * @property {string} filename
 * @property {string} stored_path
 * @property {string} mime_type
 * @property {number} size_bytes
 * @property {Date} created_at
 */

// ---------------------------------------------------------------------------
// Custom parser configs
// ---------------------------------------------------------------------------

/**
 * A raw row of `custom_parser_configs` (migrations 0037 + 0041). NOT what the
 * repository returns — every path funnels through its `mapRow`.
 *
 * @typedef {object} CustomParserConfigRow
 * @property {number} id
 * @property {string} name
 * @property {'transaction'|'portfolio'} kind
 * @property {any} config_json JSONB — pg hands it back already parsed.
 * @property {Date} created_at
 * @property {Date} updated_at
 */

/**
 * What `customParserConfigRepository`'s `mapRow` emits: `config_json` re-keyed
 * to `config` (parsed if it somehow arrived as a string).
 *
 * @typedef {object} FormattedCustomParserConfig
 * @property {number} id
 * @property {string} name
 * @property {'transaction'|'portfolio'} kind
 * @property {any} config Parsed JSONB parser definition.
 * @property {Date} created_at
 * @property {Date} updated_at
 */

// ---------------------------------------------------------------------------
// Research provider mappings (ADR-079)
// ---------------------------------------------------------------------------

/**
 * A row of `instrument_provider_map` (migration 0042) as projected by
 * `instrumentProviderMapRepository`'s shared `COLUMNS` list — the full table.
 *
 * @typedef {object} InstrumentProviderMapRow
 * @property {number} id
 * @property {string} instrument_key ISIN (`key_type='isin'`) or internal id.
 * @property {'isin'|'internal'} key_type
 * @property {string} provider
 * @property {string|null} provider_symbol
 * @property {string|null} resolved_name
 * @property {string|null} exchange
 * @property {string|null} currency
 * @property {'confirmed'|'auto'|'failed'} status
 * @property {Date|null} verified_at TIMESTAMPTZ
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

// ---------------------------------------------------------------------------
// Import staging
// ---------------------------------------------------------------------------

/**
 * A row of `import_staging_rows` — the transaction import pipeline's work
 * table (migration 0001; `match_source` / `matched_pattern_id` /
 * `match_similarity` / `user_override_recipient_id` added by 0015,
 * `override_category_id` by 0020).
 *
 * Everything the adapter produced is nullable here on purpose: the STAGE phase
 * writes whatever it parsed and the VALIDATE phase is what rejects rows. The
 * pipeline phases select column subsets, so use `Pick<>` at the call site.
 *
 * `amount` and `balance` are NUMERIC → pg strings. `tx_date` is a DATE → a
 * local-midnight `Date`; validate.js and commit.js both project it as
 * `to_char(tx_date, 'YYYY-MM-DD')` instead, precisely so the fallback hash and
 * the insert can't shift a day (see the comment at the top of validate.js).
 * `match_similarity` is REAL, which pg DOES emit as a number.
 *
 * @typedef {object} ImportStagingRow
 * @property {string} id BIGSERIAL — string, not number.
 * @property {string} batch_id BIGINT — string.
 * @property {number} row_index INTEGER
 * @property {'pending'|'validated'|'matched'|'committed'|'duplicate'|'error'} status
 * @property {Date|null} tx_date DATE — local-midnight `Date` when selected raw.
 * @property {string|null} bank_account
 * @property {string|null} recipient_raw
 * @property {string|null} memo
 * @property {string|null} amount NUMERIC(20,4) — string.
 * @property {string|null} currency
 * @property {string|null} balance NUMERIC(20,4) — string.
 * @property {string|null} recipient_account
 * @property {string|null} recipient_address
 * @property {string|null} recipient_bank_name
 * @property {string|null} comment
 * @property {string|null} raw_data
 * @property {string|null} tx_hash sha256 hex of raw_data (or the field fallback).
 * @property {number|null} resolved_recipient_id
 * @property {number|null} resolved_bank_account_id
 * @property {string|null} error_message
 * @property {'pattern'|'exact'|'fuzzy'|'new'|null} [match_source] migration 0015.
 * @property {number|null} [matched_pattern_id] migration 0015.
 * @property {number|null} [match_similarity] REAL — a number, not a string (migration 0015).
 * @property {number|null} [user_override_recipient_id] migration 0015.
 * @property {number|null} [override_category_id] migration 0020.
 * @property {Date} created_at TIMESTAMPTZ
 */

/**
 * A row of `portfolio_import_batches` (migration 0040; `account_id` added by
 * 0057, `is_brokerage` by 0060, the 'complete_with_errors' status by 0081).
 *
 * @typedef {object} PortfolioImportBatchRow
 * @property {string} id BIGSERIAL — string, not number.
 * @property {string} adapter_name
 * @property {string|null} source_filename
 * @property {string|null} source_size_bytes BIGINT — string.
 * @property {any} custom_config JSONB — pg hands it back already parsed.
 * @property {string|null} default_asset_class `asset_class` enum.
 * @property {string|null} default_type `portfolio_txn_type` enum.
 * @property {'pending'|'staging'|'validating'|'matching'|'awaiting_review'|'committing'|'complete'|'complete_with_errors'|'failed'|'aborted'} status
 * @property {number} rows_total
 * @property {number} rows_imported
 * @property {number} rows_duplicate
 * @property {number} rows_error
 * @property {string|null} error_summary
 * @property {Date} started_at
 * @property {Date|null} completed_at
 * @property {number|null} account_id FK → accounts (migration 0057).
 * @property {boolean} is_brokerage migration 0060.
 */

/**
 * A row of `portfolio_import_staging_rows` — the portfolio import pipeline's
 * work table (migration 0040; `route` added by 0060).
 *
 * Every parsed field is nullable: STAGE writes what the adapter produced and
 * VALIDATE is what rejects rows. All NUMERIC columns are pg strings;
 * `match_similarity` is REAL, which pg DOES emit as a number. `tx_date` is a
 * DATE, so raw selects hand back a local-midnight `Date` — validate.js formats
 * it with LOCAL getters (`toYmd`) on purpose.
 *
 * @typedef {object} PortfolioImportStagingRow
 * @property {string} id BIGSERIAL — string, not number.
 * @property {string} batch_id BIGINT — string.
 * @property {number} row_index INTEGER
 * @property {'pending'|'validated'|'matched'|'committed'|'duplicate'|'error'} status
 * @property {Date|null} tx_date DATE — local-midnight `Date` when selected raw.
 * @property {string|null} type_raw the CSV's own type label, pre-normalization.
 * @property {string|null} type `portfolio_txn_type` enum — stamped by VALIDATE.
 * @property {string|null} symbol_raw
 * @property {string|null} name_raw
 * @property {string|null} units NUMERIC(18,8) — string.
 * @property {string|null} price_per_unit NUMERIC(18,6) — string.
 * @property {string|null} amount NUMERIC(18,4) — string.
 * @property {string|null} fees NUMERIC(18,4) — string.
 * @property {string|null} taxes NUMERIC(18,4) — string.
 * @property {string|null} currency
 * @property {string|null} fx_rate_to_eur NUMERIC(20,10) — string.
 * @property {string|null} note
 * @property {string|null} raw_data
 * @property {string|null} tx_hash
 * @property {number|null} resolved_investment_id
 * @property {number|null} user_override_investment_id
 * @property {'symbol'|'name_exact'|null} match_source
 * @property {number|null} match_similarity REAL — a number, not a string.
 * @property {number|null} committed_txn_id
 * @property {string|null} error_message
 * @property {'cash'|'portfolio'|null} [route] migration 0060 — brokerage routing (ADR-095).
 * @property {Date} created_at TIMESTAMPTZ
 */

// ---------------------------------------------------------------------------
// Asset price history
// ---------------------------------------------------------------------------

/**
 * A row of `asset_price_history` (migration 0001; the FK to `investments` was
 * added by 0026 and is dropped again by priceCache's `_dropForeignKey`).
 *
 * `close_price` is NUMERIC so pg emits it as a string, and `price_date` is a
 * DATE so pg emits a local-midnight `Date` — `dateOnlyToTimestampMs` exists
 * precisely to unpick that (see its comment: treating it as a string NaN'd out
 * every cached read).
 *
 * @typedef {object} AssetPriceHistoryRow
 * @property {number} id SERIAL
 * @property {number} investment_id INTEGER NOT NULL
 * @property {Date} price_date DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string.
 * @property {string} close_price NUMERIC(18,6) — pg emits NUMERIC as a string.
 * @property {string} source VARCHAR(50) DEFAULT 'provider'
 * @property {Date} fetched_at TIMESTAMPTZ
 * @property {Date|null} updated_at TIMESTAMPTZ
 */

/**
 * One point of a price series as the price layer passes it around: an
 * epoch-millis timestamp (pinned to UTC noon of the calendar day) and a
 * finite, strictly-positive price. Produced by `normalizeHistoryPoints`, which
 * drops anything failing those invariants.
 *
 * @typedef {object} PricePoint
 * @property {number} timestampMs
 * @property {number} price
 */

// ---------------------------------------------------------------------------
// Portfolio performance snapshots
// ---------------------------------------------------------------------------

/**
 * A row of `portfolio_performance_snapshots` as returned by `SELECT *`
 * (migration 0018; `value_fx_neutral` added by migration 0039).
 *
 * Every money/percentage column is NUMERIC, so pg emits it as a string — the
 * consumers all run them through `toDecimal`/`toNumber`. Every column except
 * `value_fx_neutral` is NOT NULL with a DEFAULT.
 *
 * `value_fx_neutral` is optional AND nullable on purpose: `getSnapshots` uses
 * `SELECT *` precisely so the projection still works on a database that has not
 * applied 0039 (the property is then absent, not null).
 *
 * @typedef {object} PortfolioPerformanceSnapshotRow
 * @property {number} id SERIAL
 * @property {Date} snapshot_date DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string.
 * @property {string} invested NUMERIC(18,6)
 * @property {string} value NUMERIC(18,6)
 * @property {string} stocks_etfs_value NUMERIC(18,6)
 * @property {string} crypto_value NUMERIC(18,6)
 * @property {string} metals_value NUMERIC(18,6)
 * @property {string} cash_value NUMERIC(18,6)
 * @property {string} gain_loss NUMERIC(18,6)
 * @property {string} return_pct NUMERIC(10,4)
 * @property {string} inflation_adjusted_value NUMERIC(18,6)
 * @property {string} cumulative_inflation NUMERIC(10,4) DEFAULT 1
 * @property {string} real_return_pct NUMERIC(10,4)
 * @property {string} stocks_etfs_invested NUMERIC(18,6)
 * @property {string} crypto_invested NUMERIC(18,6)
 * @property {string} metals_invested NUMERIC(18,6)
 * @property {string} currency VARCHAR(3) DEFAULT 'EUR'
 * @property {Date} computed_at TIMESTAMPTZ
 * @property {string|null} [value_fx_neutral] NUMERIC(18,2), migration 0039 — absent on un-migrated databases.
 */

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------

/**
 * A row of `exchange_rates` (migration 0001; `fetched_at` made NOT NULL with a
 * default in migration 0022).
 *
 * `rate_to_eur` is NUMERIC(20,10) so pg emits it as a string — every consumer
 * runs it through `toNumber(toDecimal(...))`. `is_latest` has `DEFAULT false`
 * but no NOT NULL, so it is nullable on paper.
 *
 * Note that most FX queries do NOT select `rate_date` raw: they project
 * `to_char(rate_date, 'YYYY-MM-DD') AS rate_date` (or `rate_date::text`)
 * precisely to avoid the local-midnight `Date`. Those projections are typed at
 * the call site with `Pick<>` plus an explicit `rate_date: string` override
 * rather than by loosening this typedef.
 *
 * @typedef {object} ExchangeRateRow
 * @property {number} id SERIAL
 * @property {string} currency_code VARCHAR(3)
 * @property {string} rate_to_eur NUMERIC(20,10) — pg emits NUMERIC as a string.
 * @property {Date} rate_date DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string.
 * @property {boolean|null} is_latest BOOLEAN DEFAULT false (no NOT NULL constraint).
 * @property {Date} fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW().
 * @property {Date|null} updated_at TIMESTAMPTZ
 */

/**
 * One entry of the in-memory historical-FX index built by
 * `buildHistoricalRateIndex`: a 'YYYY-MM-DD' day and the already-numeric
 * `rate_to_eur` for it.
 *
 * @typedef {object} HistoricalRatePoint
 * @property {string} date 'YYYY-MM-DD'
 * @property {number} rate
 */

/**
 * The historical-FX index: currency code → date-ascending rate points.
 *
 * @typedef {Map<string, HistoricalRatePoint[]>} HistoricalRateIndex
 */

/**
 * A `{ EUR: 1, USD: x, … }` map of "1 unit of X is this many EUR" multipliers,
 * as returned by the ECB / open.er-api fetchers, `loadFromDatabase`, and the
 * currency service's cache hierarchy.
 *
 * @typedef {Record<string, number>} RateTable
 */

// ---------------------------------------------------------------------------
// Belgian inflation rates
// ---------------------------------------------------------------------------

/**
 * A row of `belgian_inflation_rates` (migration 0001).
 *
 * @typedef {object} BelgianInflationRateRow
 * @property {number} id SERIAL
 * @property {Date} month_date DATE (first-of-month) — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string.
 * @property {string} monthly_rate NUMERIC(10,8) — pg emits NUMERIC as a string.
 * @property {string} source VARCHAR(50) NOT NULL DEFAULT 'statbel'.
 * @property {Date} fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW().
 * @property {Date|null} updated_at TIMESTAMPTZ
 */

/**
 * The service's normalized shape for one month's inflation rate — used both
 * for DB-loaded rows (after `monthKeyFromDatabaseValue`/`Number()`) and rates
 * parsed from an external payload (Statbel/Eurostat), which are the same
 * shape before being persisted.
 *
 * @typedef {object} BelgianInflationRate
 * @property {string} month 'YYYY-MM'.
 * @property {number} monthly_rate Already-numeric fraction (e.g. 0.0025), rounded to `RATE_DECIMALS`.
 */

export {};
