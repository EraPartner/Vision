/**
 * Hand-written, ergonomic TypeScript types for the Vision REST API, consumed
 * across the frontend. The authoritative contract lives in `openapi.yaml`; the
 * machine-generated mirror is `./generated.ts` (regenerated + drift-checked in
 * CI via `bun run generate:types`). These hand types are kept assignable to the
 * generated contract by the compile-time assertions in `./contract-guard.ts`,
 * which fail `bun run typecheck` if the two drift apart.
 *
 * Note: money/quantity fields are typed `number` here, but pg returns NUMERIC
 * columns as strings — the backend repository layer coerces them on emit (see
 * packages/shared-utils/src/money.js). Do not assume raw repository rows are
 * already numeric.
 */
import type { AssetClass } from '@vision/types/assetClasses';
import type { PortfolioTxnType } from '@vision/types/portfolioTxnTypes';
import type { RecurrenceInterval } from '@vision/types/recurrence';
import type { operations } from './generated';

export interface Link {
    rel: string;
    href: string;
    method: string;
    title?: string;
}

// ==================== Category Types ====================

export interface Category {
    id: number;
    general: string;
    detail: string;
    description?: string;
    is_active: boolean;
    created_at: string;
    updated_at?: string;
    links: Link[];
}

export interface CategoriesListResponse {
    items: Category[];
    total: number;
    /** Present only when the request paginated (explicit limit/offset — pagination is opt-in). */
    limit?: number;
    offset?: number;
    links: Link[];
}

export interface CategoryCreate {
    general: string;
    detail: string;
    description?: string;
}

export interface CategoryUpdate {
    general?: string;
    detail?: string;
    description?: string;
    is_active?: boolean;
}

// ==================== Account Types (ADR-088) ====================

export type AccountType =
    | 'checking'
    | 'savings'
    | 'brokerage'
    | 'crypto_exchange'
    | 'wallet'
    | 'pension'
    | 'liability';
export type AccountLiquidityClass = 'liquid' | 'semi_liquid' | 'illiquid';
export type AccountTaxWrapper = 'none' | 'pension' | 'tax_advantaged';
export type AccountOwner = 'me' | 'partner' | 'joint';

export interface Account {
    id: number;
    name: string;
    display_name?: string;
    institution?: string;
    currency: string;
    type: AccountType;
    liquidity_class: AccountLiquidityClass;
    spendable: boolean;
    in_net_worth: boolean;
    tax_wrapper: AccountTaxWrapper;
    owner: AccountOwner;
    multi_currency_cash: boolean;
    has_cash_sleeve: boolean;
    funding_account_id?: number;
    statement_balance?: number;
    statement_balance_date?: string;
    /**
     * The account's anchor+delta computed balance (ADR-094), denominated in
     * `currency`; computed, read-only. A multi-currency account's partitions are
     * converted into `currency` at today's rate, so this figure moves with FX.
     */
    computed_balance?: number;
    /**
     * The reconciliation base: the computed balance of the ONE currency
     * partition `statement_balance` is a statement for, in
     * `reconcilable_currency` and never FX-converted. Equal to
     * `computed_balance` on a single-currency account; on a multi-currency one
     * it is the figure the server reconciles against, so the reconcile dialog
     * must preview against this and not `computed_balance`. List endpoint only.
     */
    reconcilable_balance?: number;
    /** Currency of `reconcilable_balance` and `drift`. List endpoint only. */
    reconcilable_currency?: string;
    /**
     * statement_balance − reconcilable_balance, in `reconcilable_currency`;
     * null when no statement balance (ADR-094). Native-currency by design, so
     * the badge never moves with the daily exchange rate.
     */
    drift?: number;
    /** YYYY-MM-DD date of the stamped statement anchor behind computed_balance (WP-A1 provenance); absent when unstamped. Only set by the list endpoint. */
    anchor_date?: string;
    /** Active entries after the anchor, or all active entries when unstamped (WP-A1 provenance). Only set by the list endpoint. */
    post_anchor_count?: number;
    /** Whether the account has any active ledger rows; only set by the list endpoint. */
    has_transactions?: boolean;
    is_active: boolean;
    /** Server-stamped when the account is closed (is_active=false); cleared on reactivate (D5). */
    closed_at?: string | null;
    created_at: string;
    updated_at?: string;
}

export interface AccountsListResponse {
    items: Account[];
    total: number;
    links?: Link[];
}

export interface AccountCreate {
    name: string;
    display_name?: string;
    institution?: string;
    currency?: string;
    type?: AccountType;
    liquidity_class?: AccountLiquidityClass;
    spendable?: boolean;
    in_net_worth?: boolean;
    tax_wrapper?: AccountTaxWrapper;
    owner?: AccountOwner;
    multi_currency_cash?: boolean;
    has_cash_sleeve?: boolean;
    funding_account_id?: number;
    statement_balance?: number;
    statement_balance_date?: string;
}

// On PATCH, explicit null clears the field (the backend maps it to SQL NULL);
// undefined/omitted leaves it untouched.
export interface AccountUpdate extends Partial<Omit<AccountCreate,
    'display_name' | 'institution' | 'funding_account_id' | 'statement_balance' | 'statement_balance_date'>> {
    is_active?: boolean;
    display_name?: string | null;
    institution?: string | null;
    funding_account_id?: number | null;
    statement_balance?: number | null;
    statement_balance_date?: string | null;
}

// ==================== Recipient Types ====================

export interface Recipient {
    id: number;
    name: string;
    primary_bank_account?: string;
    default_category_id?: number;
    default_category_name?: string;
    primary_recipient_id?: number | null;
    primary_recipient_name?: string | null;
    alias_count?: number;
    notes?: string;
    is_active: boolean;
    created_at: string;
    updated_at?: string;
    links: Link[];
}

export interface RecipientsListResponse {
    items: Recipient[];
    total: number;
    limit: number;
    offset: number;
    links: Link[];
}

export interface RecipientCreate {
    name: string;
    default_category_id?: number;
    notes?: string;
}

export interface RecipientUpdate {
    name?: string;
    default_category_id?: number | null;
    notes?: string;
    is_active?: boolean;
}

// ==================== Transaction Types ====================

export interface Transaction {
    id: number;
    transaction_date: string; // date field, aliased as "date" in API
    // Nullable on the wire: rows without a label exist (e.g. ADR-090 trade
    // cash legs), and a PATCH null-to-clear leaves NULL behind.
    bank_account: string | null;
    recipient_id?: number | null;
    recipient_name?: string; // Recipient name
    memo?: string | null;
    amount: number;
    amount_eur?: number;
    currency?: string;
    balance?: number;
    /** Per-account running balance (SQL window); only present when the list was fetched with include_balance=true (WP-B4). */
    running_balance?: number;
    category_id?: number | null;
    category_name?: string; // Category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES')
    comment?: string | null;
    tags?: Tag[];
    created_at: string;
    updated_at?: string;
    links: Link[];
}

export interface TransactionsListResponse {
    items: Transaction[];
    total: number;
    limit: number;
    offset: number;
    links: Link[];
}

export interface TransactionCreate {
    transaction_date: string; // YYYY-MM-DD format
    bank_account: string;
    recipient_id: number;
    memo?: string;
    amount: number;
    currency?: string;
    balance?: number;
    category_id?: number;
    comment?: string;
    tags?: string[];
}

// Nullable fields carry PATCH null-to-clear semantics: explicit null clears
// the value server-side, undefined (absent key) leaves it unchanged. `??
// undefined` on a cleared value silently dropped the key — the clear no-op'd.
// `balance` is deliberately absent: the running balance is bank-stamped import
// data (ADR-094) and the backend PATCH whitelist drops it — sending it was a
// silent no-op that made the field look editable.
export interface TransactionUpdate {
    transaction_date?: string;
    bank_account?: string | null;
    recipient_id?: number | null;
    recipient_name?: string;
    memo?: string | null;
    amount?: number;
    currency?: string;
    category_id?: number | null;
    category_name?: string;
    comment?: string | null;
    is_active?: boolean;
    tags?: string[];
}

// ==================== Planned Transaction Types ====================

// ==================== Planned Transaction Types ====================

export interface PlannedTransactionExecution {
    id: number;
    executed_transaction_id: number;
    execution_date: string; // YYYY-MM-DD format
    created_at: string;
}

export type PlannedLoanType = 'amortizing' | 'fixed_principal' | 'interest_only';

export interface PlannedLoanScheduleEntry {
    installment_number: number;
    due_date: string;
    payment_amount: number;
    principal_amount: number;
    interest_amount: number;
    remaining_principal: number;
}

export interface PlannedTransaction {
    id: number;
    planned_date: string; // YYYY-MM-DD format
    recurrence_end_date?: string | null;
    max_occurrences?: number | null;
    bank_account: string;
    recipient_id?: number;
    recipient_name?: string;
    memo?: string;
    amount: number;
    currency?: string;
    category_id?: number;
    category_name?: string; // Category name in 'GENERAL:DETAIL' format
    comment?: string;
    url?: string; // Optional URL associated with planned expense
    is_recurring: boolean;
    recurrence_pattern?: string;
    is_loan?: boolean;
    loan_type?: PlannedLoanType | null;
    loan_principal?: number | null;
    loan_annual_interest_rate?: number | null;
    loan_term_months?: number | null;
    loan_start_date?: string | null;
    loan_payment_day?: number | null;
    loan_regular_payment_amount?: number | null;
    loan_first_payment_date?: string | null;
    loan_schedule?: PlannedLoanScheduleEntry[];
    is_executed: boolean;
    last_executed_date?: string; // YYYY-MM-DD format
    executed_transaction_id?: number;
    execution_count: number;
    executions?: PlannedTransactionExecution[];
    tags?: Tag[];
    is_active: boolean;
    created_at: string;
    updated_at?: string;
    links: Link[];
}

export interface PlannedTransactionsListResponse {
    items: PlannedTransaction[];
    total: number;
    limit: number;
    offset: number;
    links: Link[];
}

export interface PlannedTransactionCreate {
    planned_date: string; // YYYY-MM-DD format
    /** Recurrence bounds: the series completes past this date / at this count. */
    recurrence_end_date?: string;
    max_occurrences?: number;
    bank_account?: string;
    recipient_id?: number;
    memo?: string;
    amount: number;
    currency?: string;
    category_id?: number;
    comment?: string;
    url?: string;
    is_recurring?: boolean;
    recurrence_pattern?: string;
    is_loan?: boolean;
    loan_type?: PlannedLoanType;
    loan_principal?: number;
    loan_annual_interest_rate?: number;
    loan_term_months?: number;
    loan_start_date?: string;
    loan_payment_day?: number;
    tags?: string[];
}

export interface PlannedTransactionUpdate {
    planned_date?: string;
    recurrence_end_date?: string | null;
    max_occurrences?: number | null;
    bank_account?: string;
    recipient_id?: number;
    recipient_name?: string;
    memo?: string;
    amount?: number;
    currency?: string;
    category_id?: number;
    category_name?: string;
    comment?: string;
    url?: string;
    is_recurring?: boolean;
    recurrence_pattern?: string;
    is_loan?: boolean;
    loan_type?: PlannedLoanType | null;
    loan_principal?: number | null;
    loan_annual_interest_rate?: number | null;
    loan_term_months?: number | null;
    loan_start_date?: string | null;
    loan_payment_day?: number | null;
    is_executed?: boolean;
    is_active?: boolean;
    tags?: string[];
}

export interface PlannedTransactionExecuteRequest {
    executed_transaction_id: number;
    execution_date?: string; // YYYY-MM-DD format, defaults to today
}

// ==================== Portfolio Types ====================

// AssetClass / PortfolioTxnType / RecurrenceInterval derive from the canonical
// runtime arrays in @vision/types; re-exported here so existing '@/types/api'
// imports keep working. RecurrenceInterval is the portfolio vocabulary — the
// hyphenated 'bi-weekly' spelling; planned transactions use a different,
// unhyphenated one (see @vision/types/recurrence).
export type { AssetClass, PortfolioTxnType, RecurrenceInterval };
export type PriceProvider = 'manual' | 'binance' | 'yahoo' | 'custom' | 'kinesis';

export interface Investment {
    id: number;
    name: string;
    symbol?: string;
    asset_class: AssetClass;
    currency: string;
    current_price?: number;
    interest_rate?: number;
    maturity_date?: string;
    location?: string;
    municipality?: string;
    cadastral_income?: number;
    municipality_tax_rate?: number;
    notes?: string;
    price_provider: PriceProvider;
    price_provider_id?: string;
    price_provider_url?: string;
    price_provider_latest_url?: string;
    price_provider_latest_path?: string;
    price_provider_history_url?: string;
    price_provider_history_path?: string;
    price_provider_history_ts_path?: string;
    price_provider_history_price_path?: string;
    price_updated_at?: string;
    is_active: boolean;
    /** Whether this holding appears in the portfolio price ticker (default true). */
    show_in_ticker: boolean;
    created_at: string;
    updated_at: string;
}

export interface InvestmentsListResponse {
    items: Investment[];
    total: number;
    limit: number;
    offset: number;
    links: Link[];
}

export interface InvestmentCreate {
    name: string;
    symbol?: string;
    asset_class: AssetClass;
    currency?: string;
    current_price?: number;
    interest_rate?: number;
    maturity_date?: string;
    location?: string;
    municipality?: string;
    cadastral_income?: number;
    municipality_tax_rate?: number;
    notes?: string;
    price_provider?: PriceProvider;
    price_provider_id?: string;
    price_provider_url?: string;
    price_provider_latest_url?: string;
    price_provider_latest_path?: string;
    price_provider_history_url?: string;
    price_provider_history_path?: string;
    price_provider_history_ts_path?: string;
    price_provider_history_price_path?: string;
}

export interface InvestmentUpdate {
    name?: string;
    symbol?: string;
    currency?: string;
    current_price?: number;
    interest_rate?: number;
    maturity_date?: string;
    location?: string;
    municipality?: string;
    cadastral_income?: number;
    municipality_tax_rate?: number;
    notes?: string;
    is_active?: boolean;
    show_in_ticker?: boolean;
    price_provider?: PriceProvider;
    price_provider_id?: string;
    price_provider_url?: string;
    price_provider_latest_url?: string;
    price_provider_latest_path?: string;
    price_provider_history_url?: string;
    price_provider_history_path?: string;
    price_provider_history_ts_path?: string;
    price_provider_history_price_path?: string;
}

export interface InvestmentPricePoint {
    timestampMs: number;
    price: number;
}

export interface PortfolioTransaction {
    id: number;
    investment_id: number;
    type: PortfolioTxnType;
    date: string;
    amount: number;
    units?: number;
    price_per_unit?: number;
    fees?: number;
    taxes?: number;
    currency: string;
    fx_rate_to_eur?: number;
    account_id?: number;
    import_batch_id?: string | null;
    note?: string;
    is_recurring: boolean;
    recurrence_interval?: RecurrenceInterval;
    recurrence_end_date?: string;
    created_at: string;
    updated_at: string;
}

export interface PortfolioTransactionsListResponse {
    items: PortfolioTransaction[];
    total: number;
    limit: number;
    offset: number;
    links: Link[];
}

export interface PortfolioTransactionCreate {
    type: PortfolioTxnType;
    date: string;
    amount?: number;
    units?: number;
    price_per_unit?: number;
    fees?: number;
    taxes?: number;
    currency?: string;
    fx_rate_to_eur?: number;
    account_id?: number;
    /** Cash account whose sleeve the trade's cash leg posts to (ADR-090); create-only. */
    cash_account_id?: number;
    note?: string;
    is_recurring?: boolean;
    recurrence_interval?: RecurrenceInterval;
    recurrence_end_date?: string;
}

export type PortfolioTransactionUpdate =
    operations['updatePortfolioTransaction']['requestBody']['content']['application/json'];

// ==================== Tag Types ====================

export interface Tag {
    id: number;
    slug: string;
    color: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface TagListResponse {
    items: Tag[];
    total: number;
    /** Present only when the request paginated (explicit limit/offset — pagination is opt-in). */
    limit?: number;
    offset?: number;
}

export interface TagCreate {
    slug: string;
    color?: string;
}

export interface TagUpdate {
    color?: string;
    is_active?: boolean;
}

export interface BulkTagRequest {
    transaction_ids: number[];
    add_slugs?: string[];
    remove_slugs?: string[];
}

export interface BulkTagResult {
    added: number;
    removed: number;
    transactions_affected: number;
}

// ==================== Bulk Action Types ====================

export interface BulkTransactionFilter {
    transaction_id?: number;
    start_date?: string;
    end_date?: string;
    /** Preferred account filter (exact FK match, ADR-088). */
    account_id?: number;
    bank_account?: string;
    bank_accounts?: string[];
    category_id?: number;
    category_ids?: number[];
    recipient_id?: number;
    recipient_group_id?: number;
    recipient_name?: string;
    search?: string;
    active?: boolean;
    transaction_type?: 'income' | 'expense';
    amount_min?: number;
    amount_max?: number;
    amount_signed?: boolean;
    tags?: string[];
}

export type BulkSelectionRequest =
    | { ids: number[]; filter?: never }
    | { filter: BulkTransactionFilter; ids?: never };

export interface BulkUpdateFields {
    category_id?: number | null;
    recipient_id?: number;
    is_active?: boolean;
}

export type BulkUpdateRequest = BulkSelectionRequest & { fields: BulkUpdateFields };

export type BulkExportRequest = BulkSelectionRequest & {
    format: 'csv' | 'json';
    include_balance?: boolean;
};

export interface BulkDeleteResult {
    deleted: number;
}

export interface BulkUpdateResult {
    updated: number;
}

// ==================== Other Types ====================

export interface CategoryStats {
    name: string;
    count: number;
}

export interface StatisticsResponse {
    total_transactions: number;
    total_amount: number;
    categories: CategoryStats[];
}

export interface BankListResponse {
    banks: string[];
}
