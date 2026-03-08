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

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Max retry attempts for transient failures */
const MAX_RETRIES = 2;

/** HTTP status codes that are safe to retry */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

/**
 * Sleep for exponential backoff: base * 2^attempt (with jitter).
 */
function backoffDelay(attempt: number, baseMs: number = 500): Promise<void> {
  const delay = baseMs * Math.pow(2, attempt) + Math.random() * 200;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

class ApiClient {
    /** Active AbortControllers keyed by a caller-provided signal or auto-generated */
    private activeControllers = new Set<AbortController>();

    /**
     * Cancel all in-flight requests. Useful on logout or critical errors.
     */
    cancelAll(): void {
        for (const controller of this.activeControllers) {
            controller.abort();
        }
        this.activeControllers.clear();
    }

    // ==================== Transaction Methods ====================

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
        const query = this.buildQuery(params);
        const res = await this.request<TransactionsListResponse>(
            `/api/transactions${query ? `?${query}` : ''}`
        );
        res.items = res.items.map((tx: any) => ({
            ...tx,
            transaction_date: tx.transaction_date ?? tx.date,
        }));
        return res;
    }

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
        await this.request<void>(`/api/transactions/${id}`, { method: 'DELETE' });
    }

    // ==================== Category Methods ====================

    async getCategories(params?: {
        limit?: number;
        offset?: number;
        general?: string;
        detail?: string;
        active?: boolean;
        search?: string;
    }): Promise<CategoriesListResponse> {
        const query = this.buildQuery(params);
        return this.request<CategoriesListResponse>(
            `/api/categories${query ? `?${query}` : ''}`
        );
    }

    async getCategory(id: number): Promise<Category> {
        return this.request<Category>(`/api/categories/${id}`);
    }

    async createCategory(category: CategoryCreate): Promise<{ category: Category; wasCreated: boolean }> {
        const url = `${API_BASE_URL}/api/categories`;
        const response = await this.rawFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(category),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        return { category: data, wasCreated: response.status === 201 };
    }

    async updateCategory(id: number, category: CategoryUpdate): Promise<Category> {
        return this.request<Category>(`/api/categories/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(category),
        });
    }

    async deleteCategory(id: number): Promise<void> {
        await this.request<void>(`/api/categories/${id}`, { method: 'DELETE' });
    }

    // ==================== Recipient Methods ====================

    async getRecipients(params?: {
        limit?: number;
        offset?: number;
        name?: string;
        default_category_id?: number;
        active?: boolean;
        search?: string;
    }): Promise<RecipientsListResponse> {
        const query = this.buildQuery(params);
        return this.request<RecipientsListResponse>(
            `/api/recipients${query ? `?${query}` : ''}`
        );
    }

    async getRecipient(id: number): Promise<Recipient> {
        return this.request<Recipient>(`/api/recipients/${id}`);
    }

    async createRecipient(recipient: RecipientCreate): Promise<{ recipient: Recipient; wasCreated: boolean }> {
        const url = `${API_BASE_URL}/api/recipients`;
        const response = await this.rawFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(recipient),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        return { recipient: data, wasCreated: response.status === 201 };
    }

    async updateRecipient(id: number, recipient: RecipientUpdate): Promise<Recipient> {
        return this.request<Recipient>(`/api/recipients/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(recipient),
        });
    }

    async deleteRecipient(id: number): Promise<void> {
        await this.request<void>(`/api/recipients/${id}`, { method: 'DELETE' });
    }

    async mergeRecipients(primaryId: number, aliasIds: number[]): Promise<{ primary: Recipient; merged_ids: number[]; aliases: Array<{ id: number; name: string }> }> {
        return this.request(`/api/recipients/${primaryId}/merge`, {
            method: 'POST',
            body: JSON.stringify({ alias_ids: aliasIds }),
        });
    }

    async unmergeRecipient(id: number): Promise<Recipient> {
        return this.request<Recipient>(`/api/recipients/${id}/unmerge`, { method: 'POST' });
    }

    async getRecipientAliases(id: number): Promise<{ items: Recipient[]; total: number }> {
        return this.request(`/api/recipients/${id}/aliases`);
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
        const query = this.buildQuery(params);
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
        await this.request<void>(`/api/planned-transactions/${id}`, { method: 'DELETE' });
    }

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
        const response = await this.rawFetch(url, { method: 'POST', body: formData });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        return response.json();
    }

    /**
     * Import CSV with Server-Sent Events for real-time progress.
     * Returns an object with an abort function and a promise for the final result.
     */
    importCSVWithProgress(
        file: File,
        bankName: string,
        onProgress: (progress: ImportProgress) => void,
    ): { abort: () => void; result: Promise<ImportResult> } {
        const controller = new AbortController();
        const formData = new FormData();
        formData.append('file', file);

        const queryParams = new URLSearchParams();
        queryParams.append('bank_name', bankName);

        const url = `${API_BASE_URL}/api/import/csv/stream?${queryParams.toString()}`;

        const result = new Promise<ImportResult>(async (resolve, reject) => {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ detail: 'Request failed' }));
                    throw new Error(error.detail || error.message || 'Request failed');
                }

                const reader = response.body?.getReader();
                if (!reader) throw new Error('No response body');

                const decoder = new TextDecoder();
                let buffer = '';
                let finalResult: ImportResult | null = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    let currentEvent = '';
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            currentEvent = line.slice(7).trim();
                        } else if (line.startsWith('data: ')) {
                            const data = JSON.parse(line.slice(6));
                            if (currentEvent === 'progress') {
                                onProgress(data);
                            } else if (currentEvent === 'complete') {
                                finalResult = data;
                                onProgress({ ...data, phase: 'complete', percent: 100 });
                            } else if (currentEvent === 'error') {
                                throw new Error(data.detail || 'Import failed');
                            }
                        }
                    }
                }

                resolve(finalResult || { total_processed: 0, imported: 0, duplicates: 0, errors: 0, status: 'completed' });
            } catch (err) {
                if ((err as Error).name === 'AbortError') {
                    reject(new Error('Import cancelled'));
                } else {
                    reject(err);
                }
            }
        });

        return {
            abort: () => controller.abort(),
            result,
        };
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
        const response = await this.rawFetch(url, { method: 'POST', body: formData });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        return response.json();
    }

    // ==================== Settings Methods ====================

    async getSettings(): Promise<Record<string, any>> {
        return this.request('/api/settings');
    }

    async getSetting(key: string): Promise<{ key: string; value: any }> {
        return this.request(`/api/settings/${encodeURIComponent(key)}`);
    }

    async saveSetting(key: string, value: any): Promise<{ key: string; value: any }> {
        return this.request(`/api/settings/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: JSON.stringify({ value }),
        });
    }

    async saveSettingsBulk(settings: Record<string, any>): Promise<{ saved: number }> {
        return this.request('/api/settings', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
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
        adapters: Array<{ key: string; name: string; adapter_class: string }>;
        total_count: number;
    }> {
        return this.request('/api/info/supported-adapters');
    }

    /** @deprecated Use getSupportedParsers instead */
    async getBanks(): Promise<{ banks: string[] }> {
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
        const query = this.buildQuery(params);
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

    async getBankBalances(): Promise<{
        accounts: Array<{
            bank_account: string;
            balance: number;
            transaction_count: number;
            first_transaction: string;
            last_transaction: string;
        }>;
        total_net_position: number;
        history: Record<string, Array<{ month: string; balance: number }>>;
        total_history: Array<{ month: string; balance: number }>;
    }> {
        return this.request('/api/info/bank-balances');
    }

    async getRecurringPatterns(): Promise<{
        patterns: Array<{
            recipientId: number;
            recipientName: string;
            detectedPattern: string;
            intervalDays: number;
            consistency: number;
            occurrences: number;
            averageAmount: number;
            latestAmount: number;
            currency: string;
            categoryId: number | null;
            categoryName: string | null;
            bankAccount: string | null;
            firstSeen: string;
            lastSeen: string;
            predictedNext: string;
            amountChanges: Array<{
                date: string;
                previousAmount: number;
                newAmount: number;
                percentChange: number;
                direction: string;
            }>;
            isAlreadyPlanned: boolean;
            confidence: number;
        }>;
        total: number;
    }> {
        return this.request('/api/info/recurring-patterns');
    }

    // ==================== Portfolio / Investments ====================

    async getInvestments(params?: {
        limit?: number;
        offset?: number;
        asset_class?: string;
        active?: boolean;
    }): Promise<InvestmentsListResponse> {
        const query = this.buildQuery(params);
        return this.request<InvestmentsListResponse>(`/api/investments${query ? `?${query}` : ''}`);
    }

    async getInvestment(id: number): Promise<Investment> {
        return this.request<Investment>(`/api/investments/${id}`);
    }

    async createInvestment(data: InvestmentCreate): Promise<Investment> {
        return this.request<Investment>('/api/investments', { method: 'POST', body: JSON.stringify(data) });
    }

    async refreshInvestmentPrices(): Promise<{ updated: number; total: number; prices: Record<string, number> }> {
        return this.request('/api/investments/refresh-prices', { method: 'POST' });
    }

    async getPriceProviders(): Promise<{ providers: Array<{ key: string; name: string; description: string }> }> {
        return this.request('/api/investments/providers');
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
        const query = this.buildQuery(params);
        return this.request<PortfolioTransactionsListResponse>(`/api/investments/${investmentId}/transactions${query ? `?${query}` : ''}`);
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

    /**
     * Build a URL query string from an object of params.
     */
    private buildQuery(params?: Record<string, any>): string {
        if (!params) return '';
        const queryParams = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                queryParams.append(key, String(value));
            }
        });
        return queryParams.toString();
    }

    /**
     * Raw fetch with timeout and AbortController support.
     * Does NOT parse response – caller handles that.
     */
    private async rawFetch(
        url: string,
        options: RequestInit = {},
        timeoutMs: number = DEFAULT_TIMEOUT_MS
    ): Promise<Response> {
        const controller = new AbortController();
        this.activeControllers.add(controller);

        // Merge caller signal if present
        if (options.signal) {
            options.signal.addEventListener('abort', () => controller.abort());
        }

        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            return response;
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error('Request timed out or was cancelled');
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            this.activeControllers.delete(controller);
        }
    }

    /**
     * Core request method with timeout, retry with exponential backoff,
     * and structured error handling.
     */
    private async request<T>(
        endpoint: string,
        options: RequestInit = {},
        retries: number = MAX_RETRIES,
    ): Promise<T> {
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        const url = `${API_BASE_URL}${endpoint}`;
        const method = options.method || 'GET';
        const isIdempotent = ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method);

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= (isIdempotent ? retries : 0); attempt++) {
            if (attempt > 0) {
                await backoffDelay(attempt - 1);
            }

            try {
                const response = await this.rawFetch(url, { ...options, headers });

                // Retry on transient server errors for idempotent methods
                if (RETRYABLE_STATUS_CODES.has(response.status) && isIdempotent && attempt < retries) {
                    lastError = new Error(`Server returned ${response.status}`);
                    continue;
                }

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ detail: 'Request failed' }));

                    if (response.status === 422 && error.detail && Array.isArray(error.detail)) {
                        const validationErrors = error.detail.map((err: any) => {
                            const field = err.loc ? err.loc.join('.') : 'unknown';
                            return `${field}: ${err.msg}`;
                        }).join('; ');
                        throw new Error(`Validation error: ${validationErrors}`);
                    }

                    if (response.status === 429) {
                        const retryAfter = error.retry_after || 'a few';
                        throw new Error(`Too many requests. Please try again in ${retryAfter} seconds.`);
                    }

                    if (typeof error.detail === 'string') throw new Error(error.detail);
                    if (error.message && typeof error.message === 'string') throw new Error(error.message);
                    throw new Error(`Request failed with status ${response.status}`);
                }

                // Handle 204 No Content
                if (response.status === 204) {
                    return undefined as unknown as T;
                }

                return response.json();
            } catch (err: any) {
                lastError = err;
                // Don't retry non-idempotent or non-network errors
                if (!isIdempotent || err.message?.includes('Validation error') || err.message?.includes('Too many requests')) {
                    throw err;
                }
                if (attempt >= retries) throw err;
            }
        }

        throw lastError || new Error('Request failed');
    }
}

export const apiClient = new ApiClient();
export type { Transaction, Category, Recipient, PlannedTransaction, Investment, PortfolioTransaction };
