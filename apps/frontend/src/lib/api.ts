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
  PlannedTransaction,
  PlannedTransactionCreate,
  PlannedTransactionsListResponse,
  PlannedTransactionUpdate,
  PlannedTransactionExecuteRequest,
  Investment,
  InvestmentCreate,
  InvestmentUpdate,
  InvestmentsListResponse,
  PortfolioTransaction,
  PortfolioTransactionCreate,
  PortfolioTransactionsListResponse,
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
        search?: string;
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
        const res = await this.request<TransactionsListResponse>(
            `/api/transactions${query ? `?${query}` : ''}`
        );
        // Backend serialises the date field as "date" (alias), remap to transaction_date
        res.items = res.items.map((tx: any) => ({
            ...tx,
            transaction_date: tx.transaction_date ?? tx.date,
        }));
        return res;
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
        search?: string;
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

    async createCategory(category: CategoryCreate): Promise<{ category: Category; wasCreated: boolean }> {
        const url = `${API_BASE_URL}/api/categories`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(category),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        
        return {
            category: data,
            wasCreated: response.status === 201
        };
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
        default_category_id?: number;
        active?: boolean;
        search?: string;
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

    async createRecipient(recipient: RecipientCreate): Promise<{ recipient: Recipient; wasCreated: boolean }> {
        const url = `${API_BASE_URL}/api/recipients`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(recipient),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        
        return {
            recipient: data,
            wasCreated: response.status === 201
        };
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

    // ==================== Planned Transactions Methods ====================

    async getPlannedTransactions(params?: {
        limit?: number;
        offset?: number;
        start_date?: string;
        end_date?: string;
        bank_account?: string;
        category_id?: number;
        recipient_id?: number;
        is_recurring?: boolean;
        is_executed?: boolean;
        active?: boolean;
        search?: string;
    }): Promise<PlannedTransactionsListResponse> {
        const queryParams = new URLSearchParams();

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    queryParams.append(key, String(value));
                }
            });
        }

        const query = queryParams.toString();
        return this.request<PlannedTransactionsListResponse>(
            `/api/planned-transactions${query ? `?${query}` : ''}`
        );
    }

    async getPlannedTransaction(id: number): Promise<PlannedTransaction> {
        return this.request<PlannedTransaction>(`/api/planned-transactions/${id}`);
    }

    async createPlannedTransaction(transaction: PlannedTransactionCreate): Promise<PlannedTransaction> {
        return this.request<PlannedTransaction>('/api/planned-transactions', {
            method: 'POST',
            body: JSON.stringify(transaction),
        });
    }

    async updatePlannedTransaction(id: number, transaction: PlannedTransactionUpdate): Promise<PlannedTransaction> {
        return this.request<PlannedTransaction>(`/api/planned-transactions/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(transaction),
        });
    }

    async deletePlannedTransaction(id: number): Promise<void> {
        await this.request<void>(`/api/planned-transactions/${id}`, {
            method: 'DELETE',
        });
    }

    // Execute a planned transaction by linking an existing transaction to it.
    // Calls POST /api/planned-transactions/{id}/execute with body { executed_transaction_id, execution_date? }
    async executePlannedTransaction(id: number, executeRequest: PlannedTransactionExecuteRequest): Promise<PlannedTransaction> {
        return this.request<PlannedTransaction>(`/api/planned-transactions/${id}/execute`, {
            method: 'POST',
            body: JSON.stringify(executeRequest),
        });
    }

    // ==================== CSV Import Methods ====================

    async importCSV(file: File, bankName: string): Promise<{ batch_id: string; imported: number; duplicates: number; total_processed: number; message: string }> {
        const formData = new FormData();
        formData.append('file', file);

        const queryParams = new URLSearchParams();
        queryParams.append('bank_name', bankName);

        const url = `${API_BASE_URL}/api/import/csv?${queryParams.toString()}`;

        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        return response.json();
    }

    async importCSVCustom(
        file: File,
        bankName: string,
        dateFormat: string,
        dateColumn: string,
        recipientColumn: string,
        amountColumn: string,
        memoColumn?: string,
        separator: string = ',',
        encoding: string = 'utf-8',
        skipRows: number = 0
    ): Promise<{ batch_id: string; imported: number; duplicates: number; total_processed: number; message: string }> {
        const formData = new FormData();
        formData.append('file', file);

        const queryParams = new URLSearchParams();
        queryParams.append('bank_name', bankName);
        queryParams.append('date_format', dateFormat);
        queryParams.append('date_column', dateColumn);
        queryParams.append('recipient_column', recipientColumn);
        queryParams.append('amount_column', amountColumn);
        if (memoColumn) queryParams.append('memo_column', memoColumn);
        queryParams.append('separator', separator);
        queryParams.append('encoding', encoding);
        queryParams.append('skip_rows', skipRows.toString());

        const url = `${API_BASE_URL}/api/import/csv/custom?${queryParams.toString()}`;

        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        return response.json();
    }

    // ==================== Info/Statistics Methods ====================

    async getStatistics(): Promise<{
        total_transactions: number;
        total_amount: number;
        categories: Array<{ name: string; count: number }>;
    }> {
        return this.request('/api/info');
    }

    async getSupportedParsers(): Promise<{
        adapters: Array<{
            key: string;
            name: string;
            adapter_class: string;
        }>;
        total_count: number;
    }> {
        return this.request('/api/info/supported-adapters');
    }

    /** @deprecated Use getSupportedParsers instead */
    async getBanks(): Promise<{ banks: string[] }> {
        // Fallback for compatibility - converts new format to old
        const data = await this.getSupportedParsers();
        return { banks: data.adapters.map(a => a.key) };
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

    async getCashflowComparison(): Promise<{
        days_in_month: number;
        current_day: number;
        month: number;
        year: number;
        without_planned: Array<{ day: number; average: number; current: number | null }>;
        with_planned: Array<{ day: number; average: number; current: number | null }>;
    }> {
        return this.request('/api/info/cashflow-comparison');
    }

    async getMonthlyFinancialSummary(params?: {
        excluded_category_ids?: number[];
    }): Promise<{
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
        const queryParams = new URLSearchParams();
        if (params?.excluded_category_ids?.length) {
            params.excluded_category_ids.forEach(id => queryParams.append('excluded_category_ids', String(id)));
        }
        const q = queryParams.toString();
        return this.request(`/api/info/monthly-summary${q ? `?${q}` : ''}`);
    }

    // ==================== Portfolio / Investments ====================

    async getInvestments(params?: {
        limit?: number;
        offset?: number;
        asset_class?: string;
        active?: boolean;
    }): Promise<InvestmentsListResponse> {
        const queryParams = new URLSearchParams();
        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) queryParams.append(key, String(value));
            });
        }
        const q = queryParams.toString();
        return this.request<InvestmentsListResponse>(`/api/investments${q ? `?${q}` : ''}`);
    }

    async getInvestment(id: number): Promise<Investment> {
        return this.request<Investment>(`/api/investments/${id}`);
    }

    async createInvestment(data: InvestmentCreate): Promise<Investment> {
        return this.request<Investment>('/api/investments', { method: 'POST', body: JSON.stringify(data) });
    }

    async updateInvestment(id: number, data: InvestmentUpdate): Promise<Investment> {
        return this.request<Investment>(`/api/investments/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    }

    async deleteInvestment(id: number): Promise<void> {
        await this.request<void>(`/api/investments/${id}`, { method: 'DELETE' });
    }

    async getPortfolioTransactions(investmentId: number, params?: {
        type?: string;
        limit?: number;
        offset?: number;
    }): Promise<PortfolioTransactionsListResponse> {
        const queryParams = new URLSearchParams();
        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) queryParams.append(key, String(value));
            });
        }
        const q = queryParams.toString();
        return this.request<PortfolioTransactionsListResponse>(`/api/investments/${investmentId}/transactions${q ? `?${q}` : ''}`);
    }

    async createPortfolioTransaction(investmentId: number, data: PortfolioTransactionCreate): Promise<PortfolioTransaction> {
        return this.request<PortfolioTransaction>(`/api/investments/${investmentId}/transactions`, {
            method: 'POST', body: JSON.stringify(data),
        });
    }

    async deletePortfolioTransaction(txnId: number): Promise<void> {
        await this.request<void>(`/api/investments/transactions/${txnId}`, { method: 'DELETE' });
    }

    // ==================== Private Helpers ====================

    private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        const url = `${API_BASE_URL}${endpoint}`;

        const response = await fetch(url, {
            ...options,
            headers,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({detail: 'Request failed'}));
            
            if (response.status === 422 && error.detail && Array.isArray(error.detail)) {
                const validationErrors = error.detail.map((err: any) => {
                    const field = err.loc ? err.loc.join('.') : 'unknown';
                    return `${field}: ${err.msg}`;
                }).join('; ');
                throw new Error(`Validation error: ${validationErrors}`);
            }
            
            if (typeof error.detail === 'string') throw new Error(error.detail);
            if (error.message && typeof error.message === 'string') throw new Error(error.message);
            throw new Error(`Request failed with status ${response.status}`);
        }

        return response.json();
    }
}

export const apiClient = new ApiClient();
export type {Transaction, Category, Recipient, PlannedTransaction, Investment, PortfolioTransaction};