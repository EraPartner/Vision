/**
 * TypeScript types for the FastAPI backend
 * Based on the backend API schemas (apps/backend/api/api_schemas.py)
 */

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
    limit: number;
    offset: number;
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
    bank_account: string;
    recipient_id?: number;
    recipient_name?: string; // Recipient name
    memo?: string;
    amount: number;
    amount_eur?: number;
    currency?: string;
    balance?: number;
    category_id?: number;
    category_name?: string; // Category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES')
    comment?: string;
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
}

export interface TransactionUpdate {
    transaction_date?: string;
    bank_account?: string;
    recipient_id?: number;
    recipient_name?: string;
    memo?: string;
    amount?: number;
    currency?: string;
    balance?: number;
    category_id?: number;
    category_name?: string;
    comment?: string;
    is_active?: boolean;
}

// ==================== Planned Transaction Types ====================

// ==================== Planned Transaction Types ====================

export interface PlannedTransactionExecution {
    id: number;
    executed_transaction_id: number;
    execution_date: string; // YYYY-MM-DD format
    created_at: string;
}

export interface PlannedTransaction {
    id: number;
    planned_date: string; // YYYY-MM-DD format
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
    is_executed: boolean;
    last_executed_date?: string; // YYYY-MM-DD format
    executed_transaction_id?: number;
    execution_count: number;
    executions?: PlannedTransactionExecution[];
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
    bank_account: string;
    recipient_id: number;
    memo?: string;
    amount: number;
    currency?: string;
    category_id?: number;
    comment?: string;
    url?: string;
    is_recurring?: boolean;
    recurrence_pattern?: string;
}

export interface PlannedTransactionUpdate {
    planned_date?: string;
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
    is_executed?: boolean;
    is_active?: boolean;
}

export interface PlannedTransactionExecuteRequest {
    executed_transaction_id: number;
    execution_date?: string; // YYYY-MM-DD format, defaults to today
}

// ==================== Portfolio Types ====================

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'real_estate' | 'savings' | 'bond';
export type PortfolioTxnType = 'buy' | 'sell' | 'dividend' | 'fee' | 'tax' | 'interest' | 'rent_income' | 'appreciation';
export type RecurrenceInterval = 'daily' | 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly' | 'yearly';
export type PriceProvider = 'manual' | 'coingecko' | 'yahoo' | 'kraken' | 'custom';

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
    notes?: string;
    price_provider: PriceProvider;
    price_provider_id?: string;
    price_provider_url?: string;
    price_updated_at?: string;
    is_active: boolean;
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
    notes?: string;
    price_provider?: PriceProvider;
    price_provider_id?: string;
    price_provider_url?: string;
}

export interface InvestmentUpdate {
    name?: string;
    symbol?: string;
    asset_class?: AssetClass;
    currency?: string;
    current_price?: number;
    interest_rate?: number;
    maturity_date?: string;
    location?: string;
    notes?: string;
    is_active?: boolean;
    price_provider?: PriceProvider;
    price_provider_id?: string;
    price_provider_url?: string;
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
    amount: number;
    units?: number;
    price_per_unit?: number;
    fees?: number;
    taxes?: number;
    currency?: string;
    note?: string;
    is_recurring?: boolean;
    recurrence_interval?: RecurrenceInterval;
    recurrence_end_date?: string;
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