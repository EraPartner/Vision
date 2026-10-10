/**
 * Shared domain row contracts for the data layer.
 *
 * These types describe what the repository queries ACTUALLY hand back, not
 * the idealised wire shape. That distinction is the whole point of the file —
 * `node-postgres` is used with its DEFAULT type parsers (there is no
 * `pg.types.setTypeParser` call anywhere in `src/`, see
 * {@link file://./../database/connection.ts}), so:
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
 * Two families of type live here:
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
 * Declared as `type` aliases rather than interfaces on purpose: aliases keep
 * the implicit index signature, so a row stays assignable to
 * `Record<string, unknown>` (as the JSDoc typedefs these replaced were).
 *
 * The raw `*Row` types of the transaction, planned-transaction, account and
 * split repositories are derived from the zod schemas in
 * src/database/rowSchemas.ts, which those repositories check at runtime
 * (ADR-193). Field documentation for them lives on the schemas.
 *
 * @module types/rows
 */

import type { z } from "zod";
import type {
  accountBalanceQueryRowSchema,
  accountRowSchema,
  enrichedTransactionDbRowSchema,
  loanScheduleRowSchema,
  plannedExecutionRowSchema,
  plannedForecastRowSchema,
  plannedMatchCandidateRowSchema,
  plannedTransactionListRowSchema,
  plannedTransactionRowSchema,
  splitPaymentRowSchema,
  transactionRowSchema,
  transactionSplitRowSchema,
  transactionTagRefSchema,
  unlinkedTransactionRowSchema,
} from "../database/rowSchemas.ts";
import type {
  assetPriceHistoryRowSchema,
  instrumentProviderMapRowSchema,
  portfolioMathTxRowSchema,
  portfolioPerformanceSnapshotRowSchema,
  watchlistRowSchema,
} from "../database/rows/portfolio.ts";
import type { CategoryRow as CatalogCategoryRow } from "../database/rows/catalog.ts";

// ---------------------------------------------------------------------------
// Query plumbing
// ---------------------------------------------------------------------------

/**
 * The slice of a `pg` client the repositories actually use — the callback
 * argument of `withTransaction()`, and the `{ query }` stand-in `writeAudit`
 * falls back to.
 *
 * Structural rather than `import('pg').PoolClient`: written when a legacy
 * checkJs program still saw `pg` as `any` (ADR-191).
 */
export type QueryRunner = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A row of `transactions` as returned by `SELECT t.*`. */
export type TransactionRow = z.output<typeof transactionRowSchema>;

/** A tag as attached to a transaction / planned transaction sub-collection. */
export type TransactionTagRef = z.output<typeof transactionTagRefSchema>;

/**
 * `TransactionRow` plus the joined/derived columns every list + detail read in
 * `transactionRepository` projects, plus the `tags` sub-collection attached by
 * `attachTagsToRows`.
 */
export type EnrichedTransactionRow = z.output<
  typeof enrichedTransactionDbRowSchema
> & {
  tags: TransactionTagRef[];
};

/**
 * Projection of `transactionRepository.listRecentUnlinked` — the planned-match
 * candidate shape. `transaction_date` is `t.date` aliased, so still a `Date`.
 */
export type UnlinkedTransactionRow = z.output<
  typeof unlinkedTransactionRowSchema
>;

// ---------------------------------------------------------------------------
// Planned transactions
// ---------------------------------------------------------------------------

/** A row of `planned_transactions` as returned by `SELECT pt.*`. */
export type PlannedTransactionRow = z.output<
  typeof plannedTransactionRowSchema
>;

/** A row of `planned_transaction_executions` (`SELECT *`, migration 0001). */
export type PlannedExecutionRow = z.output<typeof plannedExecutionRowSchema>;

/**
 * One installment of `planned_transaction_loan_schedule`, as projected by the
 * hydration queries (the `planned_transaction_id` key is stripped on the list
 * path and never selected on the detail path).
 */
export type LoanScheduleRow = z.output<typeof loanScheduleRowSchema>;

/**
 * `PlannedTransactionRow` with the shared `PLANNED_SELECT_FIELDS` join columns
 * and the sub-collections attached by `hydratePlannedRow` / `getAll`.
 */
export type HydratedPlannedTransactionRow = PlannedTransactionRow & {
  recipient_name: string | null;
  category_name: string | null;
  executions: PlannedExecutionRow[];
  execution_count: number;
  executed_transaction_id: number | null;
  loan_schedule: LoanScheduleRow[];
  tags: TransactionTagRef[];
};

/**
 * `PlannedTransactionRow` with just the join columns — the un-hydrated shape
 * `getDueSoon` returns.
 */
export type PlannedTransactionListRow = z.output<
  typeof plannedTransactionListRowSchema
>;

/** Narrow projection of `plannedTransactionRepository.listActiveUnexecuted`. */
export type PlannedMatchCandidateRow = z.output<
  typeof plannedMatchCandidateRowSchema
>;

/** Narrow projection of `plannedTransactionRepository.getForForecast`. */
export type PlannedForecastRow = z.output<typeof plannedForecastRowSchema>;

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * `recipients`, `recipient_bank_accounts` and `recipient_match_patterns` rows.
 * Derived from the row schemas the recipient repositories and the pattern
 * service check them against.
 */
export type {
  EnrichedRecipientRow,
  RecipientBankAccountRow,
  RecipientMatchPatternRow,
  RecipientRow,
} from "../database/rows/catalog.ts";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** A row of `categories` (`SELECT *`), derived from its checked row schema. */
export type { CategoryRow } from "../database/rows/catalog.ts";

/** `CategoryRow` after `enrichCategory` adds the `GENERAL:DETAIL` display name. */
export type EnrichedCategoryRow = CatalogCategoryRow & {
  category_name: string;
};

// ---------------------------------------------------------------------------
// Accounts (ADR-088)
// ---------------------------------------------------------------------------

/**
 * A row of `accounts` as projected by `accountRepository`'s shared `COLUMNS`
 * list. Statement readings live in the currency-keyed collection and are not
 * scalar account columns.
 */
export type AccountRow = z.output<typeof accountRowSchema>;

/**
 * Raw account-list row returned by `accountRepository.getAll` before service
 * conversion and API shaping.
 */
export type AccountBalanceQueryRow = z.output<
  typeof accountBalanceQueryRowSchema
>;

/**
 * `AccountRow` plus the balance/provenance columns `accountService.list` adds.
 * `post_anchor_count` is re-emitted as a `number` (the raw `COUNT(*)` bigint
 * string is parsed) and both provenance fields become `undefined` rather than
 * `null` when nothing is stamped. `computed_balance` (Σ of the account's
 * currency partitions, converted into `currency`), `reconcilable_balance` (the
 * reconciliation base — `statementPartition`, in `reconcilable_currency`) and
 * `drift` (statement figure − that base) are derived in JS from the partitions,
 * so they are `number`s — matching the OpenAPI schema — rather than pg NUMERIC
 * strings. The three native figures satisfy
 * `drift = selected statement reading − reconcilable_balance`.
 */
export type AccountWithBalanceRow = AccountRow & {
  computed_balance: number;
  balance_parts: Array<{ currency: string; balance: number }>;
  balance_incomplete: boolean;
  unconverted_currencies: string[];
  reconcilable_balance: number;
  reconcilable_currency: string;
  drift: number | null;
  statement_balances: Array<{
    currency: string;
    balance: number;
    balance_date: string;
  }>;
  has_transactions: boolean;
  anchor_date?: string;
  post_anchor_count?: number;
};

// ---------------------------------------------------------------------------
// Splits (transaction_splits + split_payments)
// ---------------------------------------------------------------------------

/**
 * A raw row of `transaction_splits` (`SELECT *` / `RETURNING *`). NOT what the
 * repository returns — every read path funnels through `formatSplit`.
 */
export type TransactionSplitRow = z.output<typeof transactionSplitRowSchema>;

/**
 * What `formatSplit` emits: the canonical wire shape for a split. `amount` and
 * `amount_paid` are coerced to numbers; the timestamps stay `Date`.
 */
export type FormattedSplit = {
  id: number;
  transaction_id: number;
  recipient_id: number;
  recipient_name: string | null;
  amount: number;
  amount_paid: number;
  note: string | null;
  is_settled: boolean;
  created_at: Date;
  updated_at: Date;
};

/**
 * `FormattedSplit` plus the parent-transaction columns `getOwedByRecipient`
 * projects and the derived `remaining`.
 */
export type OwedSplitDetailRow = FormattedSplit & {
  transaction_date: Date;
  transaction_memo: string | null;
  transaction_amount: number;
  transaction_currency: string | null;
  bank_account: string | null;
  transaction_recipient_name: string | null;
  remaining: number;
};

/** A raw row of `split_payments` (`SELECT *` / `RETURNING *`). */
export type SplitPaymentRow = z.output<typeof splitPaymentRowSchema>;

/**
 * What `formatPayment` emits: `amount` coerced to a number and `paid_at`
 * rendered as a calendar-day string.
 */
export type FormattedSplitPayment = {
  id: number;
  split_id: number;
  amount: number;
  /** 'YYYY-MM-DD' */
  paid_at: string | null;
  note: string | null;
  created_at: Date;
};

/**
 * Split-allocation totals for a transaction, after `mapSplitTotals` coerces the
 * two NUMERIC aggregates.
 */
export type SplitTotals = {
  transaction_total: number;
  current_split_total: number;
};

// ---------------------------------------------------------------------------
// Investments + portfolio transactions
// ---------------------------------------------------------------------------

/**
 * A row of `investments` after `mapInvestmentRow`: the four NUMERIC columns in
 * `INVESTMENT_NUMERIC_FIELDS` are coerced to numbers and `maturity_date` is
 * rendered as a calendar-day string. Every other column is raw.
 *
 * `investments` is a plain flat table on every install (ADR-109; legacy
 * inheritance installs were converted by migration 0087).
 */
export type InvestmentRow = {
  id: number;
  name: string;
  symbol: string | null;
  /** `asset_class` enum: stock|etf|crypto|metals|real_estate|savings|bond. */
  asset_class: string;
  currency: string;
  /** Coerced from NUMERIC(18,6). */
  current_price: number | null;
  /** Coerced from NUMERIC(8,4). */
  interest_rate: number | null;
  /** 'YYYY-MM-DD' — `toWireDate`-formatted. */
  maturity_date: string | null;
  location: string | null;
  municipality: string | null;
  /** Coerced from NUMERIC(12,2). */
  cadastral_income: number | null;
  /** Coerced from NUMERIC(8,4). */
  municipality_tax_rate: number | null;
  notes: string | null;
  is_active: boolean;
  /** `price_provider` enum. */
  price_provider: string;
  price_provider_id: string | null;
  price_provider_url: string | null;
  /** Absent on legacy schemas that predate the column. */
  price_provider_latest_url?: string | null;
  price_provider_latest_path?: string | null;
  price_provider_history_url?: string | null;
  price_provider_history_path?: string | null;
  price_provider_history_ts_path?: string | null;
  price_provider_history_price_path?: string | null;
  price_updated_at: Date | null;
  /** `COALESCE(tp.show_in_ticker, true)` — present on the joined reads (migration 0061), absent on a bare `RETURNING *`. */
  show_in_ticker?: boolean;
  created_at: Date;
  updated_at: Date;
};

/**
 * A row of `portfolio_transactions` after `mapPortfolioTxRow`: the six NUMERIC
 * columns are coerced to numbers and both DATE columns to 'YYYY-MM-DD' strings.
 */
export type PortfolioTransactionRow = {
  /** Read-only accounting role. */
  income_recognition_role?: "standard" | "included_in_units";
  id: number;
  investment_id: number;
  /** `portfolio_txn_type` enum — see `@vision/types/portfolioTxnTypes`. */
  type: string;
  /** 'YYYY-MM-DD' — coerced from a DATE by `mapPortfolioTxRow`. */
  date: string;
  /** Coerced from NUMERIC(18,4). */
  amount: number;
  /** Coerced from NUMERIC(18,8). */
  units: number | null;
  /** Coerced from NUMERIC(18,6). */
  price_per_unit: number | null;
  fees: number | null;
  taxes: number | null;
  /** Whether a dividend amount is gross or net; unknown for legacy or unclassified rows. */
  dividend_amount_convention: "gross" | "net" | "unknown";
  currency: string;
  /** Coerced from NUMERIC(20,10). */
  fx_rate_to_eur: number | null;
  note: string | null;
  is_recurring: boolean;
  /** Canonical checked recurrence cadence. */
  recurrence_interval: string | null;
  /** 'YYYY-MM-DD' */
  recurrence_end_date: string | null;
  /** Owning account for the lot (ADR-091). */
  account_id?: number | null;
  /**
   * The portfolio import batch that created
   *           this lot (migration 0086); NULL for manual entry and for lots committed
   *           before 0086 applied. BIGINT remains a node-postgres string on the wire;
   *           rollback bulk-deletes on it.
   */
  import_batch_id?: string | null;
  created_at?: Date;
  updated_at?: Date;
  /** Not a column — only present when a caller merged the investment's class in. */
  asset_class?: string;
};

/**
 * A row of `portfolioTxRepo.reads.getRowsForPortfolioMath` — portfolio_transactions
 * UNIONed with asset transfers and adjustments and JOINed to investments,
 * deliberately NOT passed through `mapPortfolioTxRow`: every NUMERIC column
 * stays a pg string, the UNION widens `id` to BIGINT (a string), and the
 * transaction day is emitted under both `date` and `day`. Derived from
 * `portfolioMathTxRowSchema` (src/database/rows/portfolio.ts), which the
 * repository checks at runtime.
 */
export type PortfolioMathTxRow = z.output<typeof portfolioMathTxRowSchema>;

/** Per-type aggregate from `portfolioTxRepo.reads.getSummary`. */
export type PortfolioTransactionSummaryRow = {
  income_recognition_role?: "standard" | "included_in_units";
  type: string;
  total_amount: number;
  total_units: number;
  total_fees: number;
  total_taxes: number;
  count: number;
};

// ---------------------------------------------------------------------------
// Saved charts
// ---------------------------------------------------------------------------

/**
 * A row of `saved_charts` as projected by `savedChartsRepository`'s shared
 * `COLUMNS` list, derived from its checked row schema. The two DATE columns
 * are `to_char`-formatted in SQL, so they are calendar-day strings.
 */
export type { SavedChartRow } from "../database/rows/catalog.ts";

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

/**
 * A raw row of `watchlist` (`SELECT *` / `RETURNING *`). NOT what the
 * repository returns — every read funnels through `mapWatchlistRow`. Derived
 * from `watchlistRowSchema` (src/database/rows/portfolio.ts).
 */
export type WatchlistRow = z.output<typeof watchlistRowSchema>;

/**
 * A `watchlist` row after `mapWatchlistRow` coerced the two NUMERIC columns
 * (`WATCHLIST_NUMERIC_FIELDS`) to numbers.
 */
export type FormattedWatchlistRow = {
  id: number;
  name: string;
  symbol: string | null;
  asset_class: string;
  target_price: number;
  currency: string;
  notes: string | null;
  price_provider_id: string | null;
  added_price: number | null;
  created_at: Date;
  updated_at: Date;
  /** Not a column — only present when a caller (the watchlist route) merged the live quote in; bare repository reads never emit it. */
  current_price?: number | null;
  /** Not a column — merged in by the watchlist route alongside `current_price`. */
  price_change?: number | null;
};

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** A row of `tags`, derived from its checked row schema. */
export type { TagRow } from "../database/rows/catalog.ts";

// ---------------------------------------------------------------------------
// AI chat (ai_conversations + ai_messages)
// ---------------------------------------------------------------------------

/**
 * `ai_conversations` / `ai_messages` rows as projected by `aiChatRepository`
 * (snake_case aliased to camelCase in SQL). Derived from the row schemas the
 * repository checks them against.
 */
export type { AiConversationRow, AiMessageRow } from "../database/rows/ai.ts";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * A raw row of `attachments` (`SELECT *` / `RETURNING *`), derived from its
 * checked row schema: `id` and `size_bytes` are BIGINT strings,
 * `transaction_id` is INTEGER (migration 0027).
 */
export type { AttachmentRow } from "../database/rows/catalog.ts";

/**
 * What `attachmentRepository`'s `formatRow` emits: `size_bytes` coerced to a
 * number; `id` stays a BIGINT string.
 */
export type FormattedAttachment = {
  id: string;
  transaction_id: number;
  filename: string;
  stored_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// Custom parser configs
// ---------------------------------------------------------------------------

/**
 * A raw row of `custom_parser_configs`, derived from the row schema
 * `customParserConfigRepository` checks it against. NOT what the repository
 * returns: every path funnels through its `mapRow`.
 */
export type { CustomParserConfigRow } from "../database/rows/imports.ts";

/**
 * What `customParserConfigRepository`'s `mapRow` emits: `config_json` re-keyed
 * to `config` (parsed if it somehow arrived as a string).
 */
export type FormattedCustomParserConfig = {
  id: number;
  name: string;
  kind: "transaction" | "portfolio";
  /**
   * Parsed JSONB parser definition, re-checked against the stored
   * parser-config schema of its `kind` (ADR-193); narrow it before use.
   */
  config: unknown;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Research provider mappings (ADR-079)
// ---------------------------------------------------------------------------

/**
 * A row of `instrument_provider_map` (migration 0042) as projected by
 * `instrumentProviderMapRepository`'s shared `COLUMNS` list — the full table.
 * Derived from `instrumentProviderMapRowSchema` (src/database/rows/portfolio.ts).
 */
export type InstrumentProviderMapRow = z.output<
  typeof instrumentProviderMapRowSchema
>;

// ---------------------------------------------------------------------------
// Import batches
// ---------------------------------------------------------------------------

/**
 * A row of `import_batches` as `getBatch` projects it (`listBatches` omits
 * `custom_config`), derived from its checked row schema. `id` is BIGSERIAL,
 * so a string; `transactions_remaining` is `COUNT(...)::int`, a number.
 */
export type { ImportBatchRow } from "../database/rows/imports.ts";

// ---------------------------------------------------------------------------
// Import staging
// ---------------------------------------------------------------------------

/**
 * A row of `import_staging_rows`, the transaction import pipeline's work
 * table, derived from the schema whose `pick`s the pipeline phases check
 * their projections against (see `database/rows/imports.ts`).
 */
export type { ImportStagingRow } from "../database/rows/imports.ts";

/**
 * `portfolio_import_batches` and `portfolio_import_staging_rows` rows, derived
 * from their row-contract schemas (ADR-193) so the type and the runtime check
 * cannot drift.
 */
export type {
  PortfolioImportBatchRow,
  PortfolioImportStagingRow,
} from "../database/rows/portfolioImport.ts";

// ---------------------------------------------------------------------------
// Asset price history
// ---------------------------------------------------------------------------

/**
 * A row of `asset_price_history`. `close_price` is NUMERIC so pg emits it as a
 * string, and `price_date` is a DATE so pg emits a local-midnight `Date` —
 * `dateOnlyToTimestampMs` exists precisely to unpick that. Derived from
 * `assetPriceHistoryRowSchema` (src/database/rows/portfolio.ts).
 */
export type AssetPriceHistoryRow = z.output<typeof assetPriceHistoryRowSchema>;

/**
 * One point of a price series as the price layer passes it around: an
 * epoch-millis timestamp (pinned to UTC noon of the calendar day) and a
 * finite, strictly-positive price. Produced by `normalizeHistoryPoints`, which
 * drops anything failing those invariants.
 */
export type PricePoint = {
  timestampMs: number;
  price: number;
};

// ---------------------------------------------------------------------------
// Portfolio performance snapshots
// ---------------------------------------------------------------------------

/**
 * A row of `portfolio_performance_snapshots` as returned by `SELECT *`. Every
 * money/percentage column is NUMERIC (a pg string). `value_fx_neutral` is
 * optional AND nullable: `getSnapshots` uses `SELECT *` so the projection still
 * works on a database without migration 0039. Derived from
 * `portfolioPerformanceSnapshotRowSchema` (src/database/rows/portfolio.ts).
 */
export type PortfolioPerformanceSnapshotRow = z.output<
  typeof portfolioPerformanceSnapshotRowSchema
>;

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
 */
export type ExchangeRateRow = {
  /** SERIAL */
  id: number;
  /** VARCHAR(3) */
  currency_code: string;
  /** NUMERIC(20,10) — pg emits NUMERIC as a string. */
  rate_to_eur: string;
  /** DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string. */
  rate_date: Date;
  /** BOOLEAN DEFAULT false (no NOT NULL constraint). */
  is_latest: boolean | null;
  /** TIMESTAMPTZ NOT NULL DEFAULT NOW(). */
  fetched_at: Date;
  /** TIMESTAMPTZ */
  updated_at: Date | null;
};

/**
 * One entry of the in-memory historical-FX index built by
 * `buildHistoricalRateIndex`: a 'YYYY-MM-DD' day and the already-numeric
 * `rate_to_eur` for it.
 */
export type HistoricalRatePoint = {
  /** 'YYYY-MM-DD' */
  date: string;
  rate: number;
};

/** The historical-FX index: currency code → date-ascending rate points. */
export type HistoricalRateIndex = Map<string, HistoricalRatePoint[]>;

/**
 * A `{ EUR: 1, USD: x, … }` map of "1 unit of X is this many EUR" multipliers,
 * as returned by the ECB / open.er-api fetchers, `loadFromDatabase`, and the
 * currency service's cache hierarchy.
 */
export type RateTable = Record<string, number>;

// ---------------------------------------------------------------------------
// Belgian inflation rates
// ---------------------------------------------------------------------------

/** A row of `belgian_inflation_rates`, derived from its checked row schema. */
export type { BelgianInflationRateRow } from "../database/rows/info.ts";

/**
 * The service's normalized shape for one month's inflation rate — used both
 * for DB-loaded rows (after `monthKeyFromDatabaseValue`/`Number()`) and rates
 * parsed from an external payload (Statbel/Eurostat), which are the same
 * shape before being persisted.
 */
export type BelgianInflationRate = {
  /** 'YYYY-MM'. */
  month: string;
  /** Already-numeric fraction (e.g. 0.0025), rounded to `RATE_DECIMALS`. */
  monthly_rate: number;
};
