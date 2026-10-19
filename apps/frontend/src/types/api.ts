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
 * packages/shared-utils/src/money.ts). Do not assume raw repository rows are
 * already numeric.
 */
import type { AssetClass } from "@vision/types/assetClasses";
import type {
    PortfolioTxnType,
    PortfolioIncomeRecognitionRole,
} from "@vision/types/portfolioTxnTypes";
import type { RecurrenceInterval } from "@vision/types/recurrence";
import type { operations } from "./generated";
import type {
    AccountId,
    CategoryId,
    CurrencyCode,
    InvestmentId,
    PlannedTransactionId,
    PortfolioTransactionId,
    RecipientId,
    TagId,
    TransactionId,
} from "@vision/types/brands";

export interface Link {
    rel: string;
    href: string;
    method: string;
    title?: string;
}

// ==================== Category Types ====================

export interface Category {
    id: CategoryId;
    general: string;
    detail: string;
    description?: string;
    is_active: boolean;
    created_at: string;
    updated_at?: string;
    links: Link[];
}

/** Canonical category tree node. The path arrays, not general/detail, define ancestry. */
export interface CategoryNode {
    id: CategoryId;
    name: string;
    parentId: CategoryId | null;
    pathIds: CategoryId[];
    path: string[];
    category_name: string;
    depth: number;
    description?: string | null;
    is_active: boolean;
    hierarchyOnly: boolean;
    legacyCompatible: boolean;
}

export interface CategoryNodeCreate {
    name: string;
    parentId: CategoryId | null;
    description?: string | null;
}

export interface CategoryNodeUpdate {
    name?: string;
    parentId?: CategoryId | null;
    description?: string | null;
    is_active?: boolean;
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
    description?: string | undefined;
}

export interface CategoryUpdate {
    general?: string;
    detail?: string;
    description?: string;
    is_active?: boolean;
}

// ==================== Account Types (ADR-088) ====================

export type AccountType =
    | "checking"
    | "savings"
    | "brokerage"
    | "crypto_exchange"
    | "wallet"
    | "pension"
    | "liability";
export type AccountLiquidityClass = "liquid" | "semi_liquid" | "illiquid";
export type AccountTaxWrapper = "none" | "pension" | "tax_advantaged";
export type AccountOwner = "me" | "partner" | "joint";

export interface Account {
    id: AccountId;
    name: string;
    display_name?: string | undefined;
    institution?: string | undefined;
    currency: CurrencyCode;
    type: AccountType;
    liquidity_class: AccountLiquidityClass;
    spendable: boolean;
    in_net_worth: boolean;
    tax_wrapper: AccountTaxWrapper;
    owner: AccountOwner;
    multi_currency_cash: boolean;
    has_cash_sleeve: boolean;
    funding_account_id?: AccountId | undefined;
    /** Authoritative statement readings, one per native currency (ADR-089 D2). */
    statement_balances?:
        | Array<{
              currency: CurrencyCode;
              balance: number;
              balance_date: string;
          }>
        | undefined;
    /**
     * The account's anchor+delta computed balance (ADR-094), denominated in
     * `currency`; computed, read-only. A multi-currency account's partitions are
     * converted into `currency` at today's rate, so this figure moves with FX.
     */
    computed_balance?: number | undefined;
    /** Native per-currency ledger partitions returned by the list endpoint. */
    balance_parts?: Array<{ currency: CurrencyCode; balance: number }> | undefined;
    /** True when computed_balance excludes one or more partitions with no rate. */
    balance_incomplete?: boolean | undefined;
    /** Currency codes excluded from computed_balance because no conversion rate exists. */
    unconverted_currencies?: CurrencyCode[] | undefined;
    /**
     * The reconciliation base: the computed balance of the ONE currency
     * partition the selected collection reading is a statement for, in
     * `reconcilable_currency` and never FX-converted. Equal to
     * `computed_balance` on a single-currency account; on a multi-currency one
     * it is the figure the server reconciles against, so the reconcile dialog
     * must preview against this and not `computed_balance`. List endpoint only.
     */
    reconcilable_balance?: number | undefined;
    /** Currency of `reconcilable_balance` and `drift`. List endpoint only. */
    reconcilable_currency?: CurrencyCode | undefined;
    /**
     * selected statement balance − reconcilable_balance, in `reconcilable_currency`;
     * null when no statement balance (ADR-094). Native-currency by design, so
     * the badge never moves with the daily exchange rate.
     */
    drift?: number | undefined;
    /** YYYY-MM-DD date of the stamped statement anchor behind computed_balance (WP-A1 provenance); absent when unstamped. Only set by the list endpoint. */
    anchor_date?: string | undefined;
    /** Active entries after the anchor, or all active entries when unstamped (WP-A1 provenance). Only set by the list endpoint. */
    post_anchor_count?: number | undefined;
    /** Whether the account has any active ledger rows; only set by the list endpoint. */
    has_transactions?: boolean | undefined;
    is_active: boolean;
    /** Server-stamped when the account is closed (is_active=false); cleared on reactivate (D5). */
    closed_at?: string | null | undefined;
    created_at: string;
    updated_at?: string | undefined;
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
    currency?: CurrencyCode | null;
    type?: AccountType;
    liquidity_class?: AccountLiquidityClass;
    spendable?: boolean;
    in_net_worth?: boolean;
    tax_wrapper?: AccountTaxWrapper;
    owner?: AccountOwner;
    multi_currency_cash?: boolean;
    has_cash_sleeve?: boolean;
    funding_account_id?: AccountId;
}

// On PATCH, explicit null clears the field (the backend maps it to SQL NULL);
// undefined/omitted leaves it untouched.
export interface AccountUpdate extends Partial<
    Omit<AccountCreate, "display_name" | "institution" | "funding_account_id">
> {
    is_active?: boolean;
    display_name?: string | null;
    institution?: string | null;
    funding_account_id?: AccountId | null;
}

// ==================== Recipient Types ====================

export interface Recipient {
    id: RecipientId;
    name: string;
    primary_bank_account?: string;
    default_category_id?: CategoryId;
    default_category_name?: string;
    primary_recipient_id?: RecipientId | null;
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
    default_category_id?: CategoryId;
    notes?: string | undefined;
}

export interface RecipientUpdate {
    name?: string;
    default_category_id?: CategoryId | null;
    notes?: string | undefined;
    is_active?: boolean;
}

// ==================== Transaction Types ====================

export interface Transaction {
    id: TransactionId;
    transaction_date: string;
    // Nullable on the wire: rows without a label exist (e.g. ADR-090 trade
    // cash legs), and a PATCH null-to-clear leaves NULL behind.
    bank_account: string | null;
    account_id?: AccountId | null | undefined;
    is_transfer?: boolean | undefined;
    transfer_peer_id?: TransactionId | null | undefined;
    transfer_source?:
        | "auto"
        | "manual"
        | "opening"
        | "adjustment"
        | "brokerage"
        | null
        | undefined;
    recipient_id?: RecipientId | null | undefined;
    recipient_name?: string | undefined; // Recipient name
    memo?: string | null | undefined;
    amount: number;
    amount_eur?: number | undefined;
    /** normalize_to_eur only: no stored rate, `amount_eur` is the native amount (ADR-216). */
    amount_eur_unconverted?: true | undefined;
    currency?: CurrencyCode | undefined;
    balance?: number | undefined;
    /** Per-account, per-currency running balance; present when include_balance=true. */
    running_balance?: number | undefined;
    category_id?: CategoryId | null | undefined;
    category_name?: string | undefined; // Category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES')
    comment?: string | null | undefined;
    tags?: Tag[] | undefined;
    created_at: string;
    updated_at?: string | undefined;
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
    account_id: AccountId;
    recipient_id: RecipientId;
    memo?: string | undefined;
    amount: number;
    currency?: CurrencyCode | undefined;
    balance?: number | undefined;
    category_id?: CategoryId | undefined;
    comment?: string | undefined;
    tags?: string[] | undefined;
    /** Explicit user confirmation that an otherwise matching manual row is intentional. */
    allow_duplicate?: boolean;
}

// Nullable fields carry PATCH null-to-clear semantics: explicit null clears
// the value server-side, undefined (absent key) leaves it unchanged. `??
// undefined` on a cleared value silently dropped the key — the clear no-op'd.
// `balance` is deliberately absent: the running balance is bank-stamped import
// data (ADR-094) and the backend PATCH whitelist drops it — sending it was a
// silent no-op that made the field look editable.
export interface TransactionUpdate {
    transaction_date?: string;
    account_id?: AccountId | null;
    recipient_id?: RecipientId | null;
    recipient_name?: string;
    memo?: string | null;
    amount?: number;
    currency?: CurrencyCode | undefined;
    category_id?: CategoryId | null;
    category_name?: string;
    comment?: string | null | undefined;
    is_active?: boolean;
    tags?: string[];
}

// ==================== Planned Transaction Types ====================

// ==================== Planned Transaction Types ====================

export interface PlannedTransactionExecution {
    id: number;
    executed_transaction_id: TransactionId;
    execution_date: string; // YYYY-MM-DD format
    created_at: string;
}

export type PlannedLoanType =
    "amortizing" | "fixed_principal" | "interest_only";

export interface PlannedLoanScheduleEntry {
    installment_number: number;
    due_date: string;
    payment_amount: number;
    principal_amount: number;
    interest_amount: number;
    remaining_principal: number;
}

export interface PlannedTransaction {
    id: PlannedTransactionId;
    planned_date: string; // YYYY-MM-DD format
    recurrence_end_date?: string | null | undefined;
    max_occurrences?: number | null | undefined;
    bank_account: string;
    account_id?: AccountId | null | undefined;
    recipient_id?: RecipientId | undefined;
    recipient_name?: string | undefined;
    memo?: string | undefined;
    amount: number;
    currency?: CurrencyCode | undefined;
    category_id?: CategoryId | undefined;
    category_name?: string | undefined; // Category name in 'GENERAL:DETAIL' format
    comment?: string | undefined;
    url?: string | undefined; // Optional URL associated with planned expense
    is_recurring: boolean;
    recurrence_pattern?: string | undefined;
    is_loan?: boolean | undefined;
    loan_type?: PlannedLoanType | null | undefined;
    loan_principal?: number | null | undefined;
    loan_annual_interest_rate?: number | null | undefined;
    loan_term_months?: number | null | undefined;
    loan_start_date?: string | null | undefined;
    loan_payment_day?: number | null | undefined;
    loan_regular_payment_amount?: number | null | undefined;
    loan_first_payment_date?: string | null | undefined;
    loan_schedule?: PlannedLoanScheduleEntry[] | undefined;
    is_executed: boolean;
    last_executed_date?: string | undefined; // YYYY-MM-DD format
    executed_transaction_id?: TransactionId | undefined;
    execution_count: number;
    executions?: PlannedTransactionExecution[] | undefined;
    tags?: Tag[] | undefined;
    is_active: boolean;
    created_at: string;
    updated_at?: string | undefined;
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
    recurrence_end_date?: string | undefined;
    max_occurrences?: number | undefined;
    account_id: AccountId;
    recipient_id?: RecipientId | undefined;
    memo?: string | undefined;
    amount: number;
    currency?: CurrencyCode | undefined;
    category_id?: CategoryId | undefined;
    comment?: string | undefined;
    url?: string | undefined;
    is_recurring?: boolean | undefined;
    recurrence_pattern?: string | undefined;
    is_loan?: boolean | undefined;
    loan_type?: PlannedLoanType | undefined;
    loan_principal?: number | undefined;
    loan_annual_interest_rate?: number | undefined;
    loan_term_months?: number | undefined;
    loan_start_date?: string | undefined;
    loan_payment_day?: number | undefined;
    tags?: string[] | undefined;
}

export interface PlannedTransactionUpdate {
    planned_date?: string;
    recurrence_end_date?: string | null;
    max_occurrences?: number | null;
    account_id?: AccountId | null;
    recipient_id?: RecipientId;
    recipient_name?: string;
    memo?: string;
    amount?: number;
    currency?: CurrencyCode;
    category_id?: CategoryId;
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
    executed_transaction_id: TransactionId;
    execution_date?: string | undefined; // YYYY-MM-DD format, defaults to today
}

// ==================== Portfolio Types ====================

// AssetClass / PortfolioTxnType / RecurrenceInterval derive from the canonical
// runtime arrays in @vision/types; re-exported here so existing '@/types/api'
// imports keep working. Portfolio and planned transactions share `biweekly`.
export type { AssetClass, PortfolioTxnType, RecurrenceInterval };
export type PriceProvider =
    "manual" | "binance" | "yahoo" | "custom" | "kinesis";

export interface Investment {
    id: InvestmentId;
    name: string;
    symbol?: string;
    asset_class: AssetClass;
    currency: CurrencyCode;
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
    symbol?: string | undefined;
    asset_class: AssetClass;
    currency?: CurrencyCode | undefined;
    current_price?: number | undefined;
    interest_rate?: number | undefined;
    maturity_date?: string | undefined;
    location?: string | undefined;
    municipality?: string | undefined;
    cadastral_income?: number | undefined;
    municipality_tax_rate?: number | undefined;
    notes?: string | undefined;
    price_provider?: PriceProvider | undefined;
    price_provider_id?: string | undefined;
    price_provider_url?: string | undefined;
    price_provider_latest_url?: string | undefined;
    price_provider_latest_path?: string | undefined;
    price_provider_history_url?: string | undefined;
    price_provider_history_path?: string | undefined;
    price_provider_history_ts_path?: string | undefined;
    price_provider_history_price_path?: string | undefined;
}

export interface InvestmentUpdate {
    name?: string | undefined;
    symbol?: string | undefined;
    currency?: CurrencyCode | undefined;
    current_price?: number | undefined;
    interest_rate?: number | undefined;
    maturity_date?: string | undefined;
    location?: string | undefined;
    municipality?: string | undefined;
    cadastral_income?: number | undefined;
    municipality_tax_rate?: number | undefined;
    notes?: string | undefined;
    is_active?: boolean | undefined;
    show_in_ticker?: boolean | undefined;
    price_provider?: PriceProvider | undefined;
    price_provider_id?: string | undefined;
    price_provider_url?: string | undefined;
    price_provider_latest_url?: string | undefined;
    price_provider_latest_path?: string | undefined;
    price_provider_history_url?: string | undefined;
    price_provider_history_path?: string | undefined;
    price_provider_history_ts_path?: string | undefined;
    price_provider_history_price_path?: string | undefined;
}

export interface InvestmentPricePoint {
    timestampMs: number;
    price: number;
}

export interface PortfolioTransaction {
    id: PortfolioTransactionId;
    investment_id: InvestmentId;
    type: PortfolioTxnType;
    date: string;
    amount: number;
    units?: number | undefined;
    price_per_unit?: number | undefined;
    fees?: number | undefined;
    taxes?: number | undefined;
    dividend_amount_convention?: DividendAmountConvention | undefined;
    /** Absent in older responses means standard; assigned only by proved import. */
    readonly income_recognition_role?:
        PortfolioIncomeRecognitionRole | undefined;
    currency: CurrencyCode;
    fx_rate_to_eur?: number | undefined;
    account_id?: AccountId | null | undefined;
    import_batch_id?: string | null | undefined;
    note?: string | undefined;
    is_recurring: boolean;
    recurrence_interval?: RecurrenceInterval | undefined;
    recurrence_end_date?: string | undefined;
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

export interface PortfolioBrokerRetagRequest {
    transaction_ids: PortfolioTransactionId[];
    from_account_id: AccountId | null;
    to_account_id: AccountId | null;
    idempotency_key: string;
}

export interface PortfolioBrokerRetagReceipt {
    receipt_id: number;
    idempotency_key: string;
    from_account_id: AccountId | null;
    to_account_id: AccountId | null;
    transaction_ids: PortfolioTransactionId[];
    previous_assignments: Array<{
        transaction_id: PortfolioTransactionId;
        account_id: AccountId | null;
    }>;
    selected_count: number;
    changed_count: number;
    created_at: string;
    replayed: boolean;
}

export interface PortfolioTransactionCreate {
    type: PortfolioTxnType;
    date: string;
    amount?: number | undefined;
    units?: number | undefined;
    price_per_unit?: number | undefined;
    fees?: number | undefined;
    taxes?: number | undefined;
    dividend_amount_convention?: DividendAmountConvention | undefined;
    currency?: CurrencyCode | undefined;
    fx_rate_to_eur?: number | undefined;
    account_id?: AccountId | undefined;
    /** Cash account whose sleeve the trade's cash leg posts to (ADR-090); create-only. */
    cash_account_id?: AccountId | undefined;
    note?: string | undefined;
    is_recurring?: boolean | undefined;
    recurrence_interval?: RecurrenceInterval | undefined;
    recurrence_end_date?: string | undefined;
}

export type DividendAmountConvention = "gross" | "net" | "unknown";

export type PortfolioTransactionUpdate =
    operations["updatePortfolioTransaction"]["requestBody"]["content"]["application/json"];

// ==================== Tag Types ====================

export interface Tag {
    id: TagId;
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
    transaction_ids: TransactionId[];
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
    transaction_id?: TransactionId | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    /** Preferred account filter (exact FK match, ADR-088). */
    account_id?: AccountId | undefined;
    bank_account?: string | undefined;
    bank_accounts?: string[] | undefined;
    category_id?: CategoryId | undefined;
    category_ids?: CategoryId[] | undefined;
    uncategorised?: boolean | undefined;
    recipient_id?: RecipientId | undefined;
    recipient_group_id?: RecipientId | undefined;
    recipient_name?: string | undefined;
    search?: string | undefined;
    active?: boolean | undefined;
    transaction_type?: "income" | "expense" | undefined;
    amount_min?: number | undefined;
    amount_max?: number | undefined;
    amount_signed?: boolean | undefined;
    tags?: string[] | undefined;
}

export type BulkSelectionRequest =
    | { ids: number[]; filter?: never }
    | {
          filter: BulkTransactionFilter;
          expected_count: number;
          ids?: never;
      };

export interface BulkUpdateFields {
    category_id?: CategoryId | null;
    recipient_id?: RecipientId;
    is_active?: boolean;
}

export type BulkUpdateRequest = BulkSelectionRequest & {
    fields: BulkUpdateFields;
};

export type BulkExportRequest = BulkSelectionRequest & {
    format: "csv" | "json";
    include_balance?: boolean;
};

export interface BulkDeleteResult {
    deleted: number;
    requested: number;
    matched: number;
}

export interface BulkUpdateResult {
    updated: number;
    requested: number;
    matched: number;
}

export interface BulkExportResult {
    blob: Blob;
    exported: number;
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
