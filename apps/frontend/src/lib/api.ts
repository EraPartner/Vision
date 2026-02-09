import type {
  CategoriesListResponse,
  Category,
  CategoryCreate,
  CategoryUpdate,
  Recipient,
  RecipientCreate,
  RecipientsListResponse,
  RecipientUpdate,
  Transaction,
  TransactionCreate,
  TransactionsListResponse,
  TransactionUpdate,
} from '@/types/api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';

class ApiClient {
    async getTransactions(params?: {
        limit?: number;
        offset?: number;
        start_date?: string;
        end_date?: string;
        bank_account?: string;
        category_id?: number;
        recipient_id?: number;
        recipient_name?: string;
        uncategorised?: boolean;
        active?: boolean;
    }): Promise<TransactionsListResponse> {
        const queryParams = new URLSearchParams();

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    queryParams.append(key, String(value));
                }
            });
        }

        const query = queryParams.toString();
        return this.request<TransactionsListResponse>(
            `/api/transactions${query ? `?${query}` : ''}`
        );
    }

    // ==================== Transaction Methods ====================

    async getTransaction(id: number): Promise<Transaction> {
        return this.request<Transaction>(`/api/transactions/${id}`);
    }

    async createTransaction(transaction: TransactionCreate): Promise<Transaction> {
        return this.request<Transaction>('/api/transactions', {
            method: 'POST',
            body: JSON.stringify(transaction),
        });
    }

    async updateTransaction(id: number, transaction: TransactionUpdate): Promise<Transaction> {
        return this.request<Transaction>(`/api/transactions/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(transaction),
        });
    }

    async deleteTransaction(id: number): Promise<void> {
        await this.request<void>(`/api/transactions/${id}`, {
            method: 'DELETE',
        });
    }

    async getCategories(params?: {
        limit?: number;
        offset?: number;
        general?: string;
        detail?: string;
        active?: boolean;
    }): Promise<CategoriesListResponse> {
        const queryParams = new URLSearchParams();

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    queryParams.append(key, String(value));
                }
            });
        }

        const query = queryParams.toString();
        return this.request<CategoriesListResponse>(
            `/api/categories${query ? `?${query}` : ''}`
        );
    }

    // ==================== Category Methods ====================

    async getCategory(id: number): Promise<Category> {
        return this.request<Category>(`/api/categories/${id}`);
    }

    async createCategory(category: CategoryCreate): Promise<Category> {
        return this.request<Category>('/api/categories', {
            method: 'POST',
            body: JSON.stringify(category),
        });
    }

    async updateCategory(id: number, category: CategoryUpdate): Promise<Category> {
        return this.request<Category>(`/api/categories/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(category),
        });
    }

    async deleteCategory(id: number): Promise<void> {
        await this.request<void>(`/api/categories/${id}`, {
            method: 'DELETE',
        });
    }

    async getRecipients(params?: {
        limit?: number;
        offset?: number;
        name?: string;
        account_number?: string;
        default_category_id?: number;
        active?: boolean;
    }): Promise<RecipientsListResponse> {
        const queryParams = new URLSearchParams();

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    queryParams.append(key, String(value));
                }
            });
        }

        const query = queryParams.toString();
        return this.request<RecipientsListResponse>(
            `/api/recipients${query ? `?${query}` : ''}`
        );
    }

    // ==================== Recipient Methods ====================

    async getRecipient(id: number): Promise<Recipient> {
        return this.request<Recipient>(`/api/recipients/${id}`);
    }

    async createRecipient(recipient: RecipientCreate): Promise<Recipient> {
        return this.request<Recipient>('/api/recipients', {
            method: 'POST',
            body: JSON.stringify(recipient),
        });
    }

    async updateRecipient(id: number, recipient: RecipientUpdate): Promise<Recipient> {
        return this.request<Recipient>(`/api/recipients/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(recipient),
        });
    }

    async deleteRecipient(id: number): Promise<void> {
        await this.request<void>(`/api/recipients/${id}`, {
            method: 'DELETE',
        });
    }

    async importCSV(file: File, bankName: string): Promise<{ batch_id: string; imported: number; duplicates: number; total_processed: number; message: string }> {
        const formData = new FormData();
        formData.append('file', file);

        const queryParams = new URLSearchParams();
        queryParams.append('bank_name', bankName);

        const url = `${API_BASE_URL}/api/import/csv?${queryParams.toString()}`;
        console.log(`API Request: POST ${url}`);

        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            console.error(`API Error: ${url}`, error);
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        console.log(`API Response: ${url}`, data);
        return data;
    }

    // ==================== Info/Statistics Methods ====================

    async getStatistics(): Promise<{
        total_transactions: number;
        total_amount: number;
        categories: Array<{ name: string; count: number }>;
    }> {
        return this.request('/api/info');
    }

    async getBanks(): Promise<{ banks: string[] }> {
        return this.request('/api/info/banks');
    }

    async getTransactionSummary(params?: {
        bank_account?: string;
        start_date?: string;
        end_date?: string;
    }): Promise<{
        total_count: number;
        total_amount: number;
        average: number;
        min: number | null;
        max: number | null;
    }> {
        const queryParams = new URLSearchParams();

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    queryParams.append(key, String(value));
                }
            });
        }

        const query = queryParams.toString();
        return this.request(`/api/info/transaction-summary${query ? `?${query}` : ''}`);
    }

    async getTransactionCount(): Promise<{ total_transactions: number }> {
        return this.request('/api/info/transaction-count');
    }

    async getMonthlyFinancialSummary(): Promise<{
        months: Array<{
            month: number;
            year: number;
            period_start: string;
            period_end: string;
            total_spending: number;
            total_income: number;
            net_amount: number;
            transaction_count: number;
        }>;
        summary: {
            total_spending: number;
            total_income: number;
            net_amount: number;
            transaction_count: number;
            period_start: string;
            period_end: string;
        };
    }> {
        return this.request('/api/info/monthly-summary');
    }

    // ==================== CSV Import ====================

    private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        const url = `${API_BASE_URL}${endpoint}`;
        console.log(`API Request: ${options.method || 'GET'} ${url}`);

        const response = await fetch(url, {
            ...options,
            headers,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            console.error(`API Error: ${url}`, error);
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        console.log(`API Response: ${url}`, data);
        return data;
    }
}

export const apiClient = new ApiClient();
export type {Transaction, Category, Recipient};