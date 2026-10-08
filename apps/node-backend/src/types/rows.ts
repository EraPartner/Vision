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
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
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

/** A row of `recipients` as returned by `SELECT *` / `SELECT r.*`. */
export type RecipientRow = {
  id: number;
  name: string;
  normalized_name: string;
  default_category_id: number | null;
  /** Merge target (self-referencing). */
  primary_recipient_id: number | null;
  notes: string | null;
  is_active: boolean;
  created_at?: Date | null;
  updated_at?: Date | null;
};

/**
 * A row of `recipient_bank_accounts` (`SELECT *` / `RETURNING *`; baseline
 * schema).
 */
export type RecipientBankAccountRow = {
  id: number;
  recipient_id: number | null;
  /** VARCHAR(34), stored trimmed + uppercased. */
  account_number: string;
  bank_name: string | null;
  account_label: string | null;
  address: string | null;
  is_primary: boolean;
  is_active: boolean;
  created_at: Date | null;
  updated_at: Date | null;
};

/** `RecipientRow` plus the derived columns the list / detail / update reads project. */
export type EnrichedRecipientRow = RecipientRow & {
  default_category_name: string | null;
  primary_bank_account: string | null;
  primary_recipient_name: string | null;
  alias_count: number;
};

/**
 * A row of `recipient_match_patterns` as returned by `SELECT *` (migration
 * 0015). `pattern_kind` is CHECK-constrained to 'regex'|'glob'|'literal_prefix',
 * `source` to 'user'|'suggested'|'system' — kept as plain `string` here since
 * Postgres CHECK constraints are not reflected in the driver's row shape.
 */
export type RecipientMatchPatternRow = {
  /** SERIAL */
  id: number;
  /** FK → recipients, ON DELETE CASCADE */
  recipient_id: number;
  pattern: string;
  /** 'regex'|'glob'|'literal_prefix', DEFAULT 'literal_prefix' */
  pattern_kind: string;
  /** DEFAULT false */
  case_sensitive: boolean;
  /** DEFAULT 100 */
  priority: number;
  /** DEFAULT true */
  is_active: boolean;
  /** 'user'|'suggested'|'system', DEFAULT 'user' */
  source: string;
  notes: string | null;
  /** TIMESTAMPTZ */
  created_at: Date;
  /** TIMESTAMPTZ */
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** A row of `categories`. */
export type CategoryRow = {
  id: number;
  general: string;
  detail: string;
  description: string | null;
  is_active: boolean;
  created_at?: Date | null;
  updated_at?: Date | null;
};

/** `CategoryRow` after `enrichCategory` adds the `GENERAL:DETAIL` display name. */
export type EnrichedCategoryRow = CategoryRow & { category_name: string };

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
 * JOINed to investments, deliberately NOT passed through `mapPortfolioTxRow` (see
 * that function's comment): every NUMERIC column stays a pg string, and the
 * transaction day is emitted under both `date` and `day` (identical values).
 */
export type PortfolioMathTxRow = {
  income_recognition_role?: "standard" | "included_in_units";
  id: number;
  investment_id: number;
  /** `portfolio_txn_type` enum. */
  type: string;
  /** NUMERIC(18,4), `COALESCE(pt.amount, 0)` — pg emits NUMERIC as a string. */
  amount: string;
  /** NUMERIC(18,8), `COALESCE(pt.units, 0)`. */
  units: string;
  /** NUMERIC, `COALESCE(pt.fees, 0)`. */
  fees: string;
  /** NUMERIC, `COALESCE(pt.taxes, 0)`. */
  taxes: string;
  /** 'YYYY-MM-DD' — `to_char(pt.date::date, …)`. */
  date: string;
  /** 'YYYY-MM-DD' — same value as `date`, second alias. */
  day: string;
  /** `COALESCE(pt.currency, i.currency, 'EUR')`. */
  currency: string;
  /** NUMERIC(20,10), not coalesced — null when unset. */
  fx_rate_to_eur: string | null;
  account_id: number | null;
  /** Canonical custody event origin. */
  source_account_id?: number;
  /** Canonical custody event destination. */
  destination_account_id?: number;
  /** Verified asset units spent on custody fees. */
  fee_units?: string;
};

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
 * `COLUMNS` list (baseline + migrations 0017/0063/0064). The two DATE columns
 * are `to_char`-formatted in SQL, so they are calendar-day strings, not `Date`s.
 * INTEGER[] columns come back from pg as `number[]` already; the repository's
 * `mapRow` re-normalises them (and the three booleans) defensively without
 * changing the type, so raw and emitted shapes coincide.
 */
export type SavedChartRow = {
  id: number;
  name: string;
  chart_type: string;
  /** INTEGER[]. */
  category_ids: number[];
  /** INTEGER[]. */
  recipient_ids: number[];
  /** INTEGER[] (migration 0063). */
  tag_ids: number[];
  all_categories: boolean;
  all_recipients: boolean;
  all_tags: boolean;
  chart_variant: string;
  time_bucket: string;
  /** 'YYYY-MM-DD' — `to_char`-formatted in the projection. */
  date_range_start: string | null;
  /** 'YYYY-MM-DD' — `to_char`-formatted in the projection. */
  date_range_end: string | null;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

/**
 * A raw row of `watchlist` (`SELECT *` / `RETURNING *`; baseline schema +
 * migration 0058). NOT what the repository returns — every read funnels
 * through `mapWatchlistRow`.
 */
export type WatchlistRow = {
  id: number;
  name: string;
  symbol: string | null;
  /** `asset_class` enum: stock|etf|crypto|metals|real_estate|savings|bond. */
  asset_class: string;
  /** NUMERIC(18,6) — pg emits NUMERIC as a string. */
  target_price: string;
  currency: string;
  notes: string | null;
  price_provider_id: string | null;
  /** NUMERIC(18,6); NULL on rows predating migration 0058. */
  added_price: string | null;
  created_at: Date;
  updated_at: Date;
};

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

/** A row of `tags`. */
export type TagRow = {
  id: number;
  slug: string;
  color: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// AI chat (ai_conversations + ai_messages)
// ---------------------------------------------------------------------------

/**
 * An `ai_conversations` row as projected by `aiChatRepository`'s
 * `CONVERSATION_COLUMNS` — the timestamps are aliased to camelCase in SQL.
 */
export type AiConversationRow = {
  /** UUID. */
  id: string;
  title: string;
  model: string;
  /** Aliased from `created_at` (TIMESTAMPTZ). */
  createdAt: Date;
  /** Aliased from `updated_at` (TIMESTAMPTZ). */
  updatedAt: Date;
};

/**
 * An `ai_messages` row as projected by `aiChatRepository`'s `MESSAGE_COLUMNS`
 * — the snake_case columns are aliased to camelCase in SQL.
 */
export type AiMessageRow = {
  /** UUID. */
  id: string;
  /** UUID FK → ai_conversations. */
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  toolName: string | null;
  /**
   * JSONB — the args the tool actually received (the
   *   dispatcher-coerced object); when coercion failed, the raw model-emitted
   *   value (e.g. a malformed JSON string) persisted next to the error result.
   *   Null on non-tool rows.
   */
  toolArgs: any;
  /** JSONB — parsed value or null. */
  toolResult: any;
  status: "complete" | "streaming" | "aborted" | "error";
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * A raw row of `attachments` (`SELECT *` / `RETURNING *`, migration 0004). All
 * three BIGINT columns come back from pg as strings.
 */
export type AttachmentRow = {
  /** BIGSERIAL — string, not number. */
  id: string;
  /** BIGINT FK → transactions — string. */
  transaction_id: string;
  filename: string;
  stored_path: string;
  mime_type: string;
  /** BIGINT — string. */
  size_bytes: string;
  created_at: Date;
};

/**
 * What `attachmentRepository`'s `formatRow` emits: `size_bytes` coerced to a
 * number; `id` / `transaction_id` stay BIGINT strings.
 */
export type FormattedAttachment = {
  id: string;
  transaction_id: string;
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
 * A raw row of `custom_parser_configs` (migrations 0037 + 0041). NOT what the
 * repository returns — every path funnels through its `mapRow`.
 */
export type CustomParserConfigRow = {
  id: number;
  name: string;
  kind: "transaction" | "portfolio";
  /** JSONB — pg hands it back already parsed. */
  config_json: any;
  created_at: Date;
  updated_at: Date;
};

/**
 * What `customParserConfigRepository`'s `mapRow` emits: `config_json` re-keyed
 * to `config` (parsed if it somehow arrived as a string).
 */
export type FormattedCustomParserConfig = {
  id: number;
  name: string;
  kind: "transaction" | "portfolio";
  /** Parsed JSONB parser definition. */
  config: any;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Research provider mappings (ADR-079)
// ---------------------------------------------------------------------------

/**
 * A row of `instrument_provider_map` (migration 0042) as projected by
 * `instrumentProviderMapRepository`'s shared `COLUMNS` list — the full table.
 */
export type InstrumentProviderMapRow = {
  id: number;
  /** ISIN (`key_type='isin'`) or internal id. */
  instrument_key: string;
  key_type: "isin" | "internal";
  provider: string;
  provider_symbol: string | null;
  resolved_name: string | null;
  exchange: string | null;
  currency: string | null;
  status: "confirmed" | "auto" | "failed";
  /** TIMESTAMPTZ */
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Import batches
// ---------------------------------------------------------------------------

/**
 * A row of `import_batches` as projected by `listBatches` / `getBatch`. `id` is
 * BIGSERIAL, so pg emits it as a string; `transactions_remaining` is
 * `COUNT(...)::int`, so it really is a number.
 */
export type ImportBatchRow = {
  /** BIGINT — string, not number. */
  id: string;
  adapter_name: string;
  source_filename: string | null;
  /** BIGINT — string. */
  source_size_bytes: string | null;
  /** JSONB; only selected by `getBatch`. */
  custom_config?: object | null;
  status:
    | "pending"
    | "staging"
    | "validating"
    | "matching"
    | "committing"
    | "complete"
    | "failed"
    | "aborted"
    | "awaiting_review";
  rows_total: number;
  rows_imported: number;
  rows_duplicate: number;
  rows_error: number;
  error_summary: string | null;
  started_at: Date;
  completed_at: Date | null;
  transactions_remaining: number;
};

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
 */
export type ImportStagingRow = {
  /** BIGSERIAL — string, not number. */
  id: string;
  /** BIGINT — string. */
  batch_id: string;
  /** INTEGER */
  row_index: number;
  status:
    "pending" | "validated" | "matched" | "committed" | "duplicate" | "error";
  /** DATE — local-midnight `Date` when selected raw. */
  tx_date: Date | null;
  bank_account: string | null;
  recipient_raw: string | null;
  memo: string | null;
  /** NUMERIC(20,4) — string. */
  amount: string | null;
  currency: string | null;
  /** NUMERIC(20,4) — string. */
  balance: string | null;
  recipient_account: string | null;
  recipient_address: string | null;
  recipient_bank_name: string | null;
  comment: string | null;
  raw_data: string | null;
  source_transaction_id?: string | null;
  source_account_identity?: string | null;
  source_record_hash?: string | null;
  dedup_fingerprint?: string | null;
  dedup_fingerprint_version?: number | null;
  dedup_occurrence?: number | null;
  resolved_recipient_id: number | null;
  error_message: string | null;
  /** migration 0015. */
  match_source?: "pattern" | "exact" | "fuzzy" | "new" | null;
  /** migration 0015. */
  matched_pattern_id?: number | null;
  /** REAL — a number, not a string (migration 0015). */
  match_similarity?: number | null;
  /** migration 0015. */
  user_override_recipient_id?: number | null;
  /** migration 0020. */
  override_category_id?: number | null;
  /** TIMESTAMPTZ */
  created_at: Date;
};

/**
 * A row of `portfolio_import_batches` (migration 0040; `account_id` added by
 * 0057, `is_brokerage` by 0060, the 'complete_with_errors' status by 0081).
 */
export type PortfolioImportBatchRow = {
  /** BIGSERIAL — string, not number. */
  id: string;
  adapter_name: string;
  source_filename: string | null;
  /** BIGINT — string. */
  source_size_bytes: string | null;
  /** JSONB — pg hands it back already parsed. */
  custom_config: any;
  /** `asset_class` enum. */
  default_asset_class: string | null;
  /** `portfolio_txn_type` enum. */
  default_type: string | null;
  status:
    | "pending"
    | "staging"
    | "validating"
    | "matching"
    | "awaiting_review"
    | "committing"
    | "complete"
    | "complete_with_errors"
    | "failed"
    | "aborted";
  rows_total: number;
  rows_imported: number;
  rows_duplicate: number;
  rows_error: number;
  error_summary: string | null;
  started_at: Date;
  completed_at: Date | null;
  /** FK → accounts (migration 0057). */
  account_id: number | null;
  /** migration 0060. */
  is_brokerage: boolean;
};

/**
 * A row of `portfolio_import_staging_rows` — the portfolio import pipeline's
 * work table (migration 0040; `route` added by 0060).
 *
 * Every parsed field is nullable: STAGE writes what the adapter produced and
 * VALIDATE is what rejects rows. All NUMERIC columns are pg strings;
 * `match_similarity` is REAL, which pg DOES emit as a number. `tx_date` is a
 * DATE, so raw selects hand back a local-midnight `Date` — validate.js formats
 * it with LOCAL getters (`toYmd`) on purpose.
 */
export type PortfolioImportStagingRow = {
  /** BIGSERIAL — string, not number. */
  id: string;
  /** BIGINT — string. */
  batch_id: string;
  /** INTEGER */
  row_index: number;
  status:
    "pending" | "validated" | "matched" | "committed" | "duplicate" | "error";
  /** DATE — local-midnight `Date` when selected raw. */
  tx_date: Date | null;
  /** the CSV's own type label, pre-normalization. */
  type_raw: string | null;
  /** `portfolio_txn_type` enum — stamped by VALIDATE. */
  type: string | null;
  symbol_raw: string | null;
  name_raw: string | null;
  /** NUMERIC(18,8) — string. */
  units: string | null;
  /** NUMERIC(18,6) — string. */
  price_per_unit: string | null;
  /** NUMERIC(18,4) — string. */
  amount: string | null;
  /** NUMERIC(18,4) — string. */
  fees: string | null;
  /** NUMERIC(18,4) — string. */
  taxes: string | null;
  currency: string | null;
  /** NUMERIC(20,10) — string. */
  fx_rate_to_eur: string | null;
  note: string | null;
  raw_data: string | null;
  source_transaction_id?: string | null;
  source_account_identity?: string | null;
  source_record_hash?: string | null;
  dedup_fingerprint?: string | null;
  dedup_fingerprint_version?: number | null;
  dedup_occurrence?: number | null;
  resolved_investment_id: number | null;
  user_override_investment_id: number | null;
  match_source: "symbol" | "name_exact" | null;
  /** REAL — a number, not a string. */
  match_similarity: number | null;
  committed_txn_id: number | null;
  error_message: string | null;
  /** migration 0060 — brokerage routing (ADR-095); custody routes 0121/0123. */
  route?:
    | "cash"
    | "portfolio"
    | "asset_transfer"
    | "asset_adjustment"
    | "account_internal"
    | null;
  /** TIMESTAMPTZ */
  created_at: Date;
};

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
 */
export type AssetPriceHistoryRow = {
  /** SERIAL */
  id: number;
  /** INTEGER NOT NULL */
  investment_id: number;
  /** DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string. */
  price_date: Date;
  /** NUMERIC(18,6) — pg emits NUMERIC as a string. */
  close_price: string;
  /** VARCHAR(50) DEFAULT 'provider' */
  source: string;
  /** TIMESTAMPTZ */
  fetched_at: Date;
  /** TIMESTAMPTZ */
  updated_at: Date | null;
};

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
 */
export type PortfolioPerformanceSnapshotRow = {
  /** SERIAL */
  id: number;
  /** DATE — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string. */
  snapshot_date: Date;
  /** NUMERIC(18,6) */
  invested: string;
  /** NUMERIC(18,6) */
  value: string;
  /** NUMERIC(18,6) */
  stocks_etfs_value: string;
  /** NUMERIC(18,6) */
  crypto_value: string;
  /** NUMERIC(18,6) */
  metals_value: string;
  /** NUMERIC(18,6) */
  cash_value: string;
  /** NUMERIC(18,6) */
  gain_loss: string;
  /** NUMERIC(10,4) */
  return_pct: string;
  /** NUMERIC(18,6) */
  inflation_adjusted_value: string;
  /** NUMERIC(10,4) DEFAULT 1 */
  cumulative_inflation: string;
  /** NUMERIC(10,4) */
  real_return_pct: string;
  /** NUMERIC(18,6) */
  stocks_etfs_invested: string;
  /** NUMERIC(18,6) */
  crypto_invested: string;
  /** NUMERIC(18,6) */
  metals_invested: string;
  /** VARCHAR(3) DEFAULT 'EUR' */
  currency: string;
  /** TIMESTAMPTZ */
  computed_at: Date;
  /** NUMERIC(18,2), migration 0039 — absent on un-migrated databases. */
  value_fx_neutral?: string | null;
};

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

/** A row of `belgian_inflation_rates` (migration 0001). */
export type BelgianInflationRateRow = {
  /** SERIAL */
  id: number;
  /** DATE (first-of-month) — a local-midnight `Date`, NOT a 'YYYY-MM-DD' string. */
  month_date: Date;
  /** NUMERIC(10,8) — pg emits NUMERIC as a string. */
  monthly_rate: string;
  /** VARCHAR(50) NOT NULL DEFAULT 'statbel'. */
  source: string;
  /** TIMESTAMPTZ NOT NULL DEFAULT NOW(). */
  fetched_at: Date;
  /** TIMESTAMPTZ */
  updated_at: Date | null;
};

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
