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
}

// ==================== Recipient Types ====================

export interface Recipient {
    id: number;
    name: string;
    account_number?: string;
    default_category_id?: number;
    notes?: string;
    address?: string;
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
    account_number?: string;
    default_category_id?: number;
    notes?: string;
    address?: string;
}

export interface RecipientUpdate {
    name?: string;
    account_number?: string;
    category_id?: number;
    notes?: string;
    address?: string;
    is_active?: boolean;
}

// ==================== Transaction Types ====================

export interface Transaction {
    id: number;
    transaction_date: string; // date field, aliased as "date" in API
    bank_account: string;
    recipient_id?: number;
    memo?: string;
    amount: number;
    currency?: string;
    balance?: number;
    category_id?: number;
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
    memo?: string;
    amount?: number;
    currency?: string;
    balance?: number;
    category_id?: number;
    comment?: string;
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
