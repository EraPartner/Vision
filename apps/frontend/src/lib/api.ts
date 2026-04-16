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

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
import logger from '@/lib/logger';

export interface ImportProgress {
    phase: string;
    current: number;
    total: number;
    imported: number;
    duplicates: number;
    errors: number;
    percent: number;
}

export interface ImportResult {
    total_processed: number;
    imported: number;
    duplicates: number;
    errors: number;
    status?: string;
    error_message?: string;
}

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
        transaction_id?: number;
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
        normalize_to_eur?: boolean;
        target_currency?: string;
        sort_by?: string;
        sort_dir?: 'asc' | 'desc';
    }): Promise<TransactionsListResponse> {
        const res = await this.requestWithQuery<TransactionsListResponse>('/api/transactions', params);
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
        return this.requestWithQuery<CategoriesListResponse>('/api/categories', params);
    }

    async getCategory(id: number): Promise<Category> {
        return this.request<Category>(`/api/categories/${id}`);
    }

    async createCategory(category: CategoryCreate): Promise<{ category: Category; wasCreated: boolean }> {
        const { data, wasCreated } = await this.createWithStatus<CategoryCreate, Category>('/api/categories', category);
        return { category: data, wasCreated };
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
        uncategorized?: boolean;
        sort_by?: string;
        sort_dir?: 'asc' | 'desc';
    }): Promise<RecipientsListResponse> {
        return this.requestWithQuery<RecipientsListResponse>('/api/recipients', params);
    }

    async getRecipient(id: number): Promise<Recipient> {
        return this.request<Recipient>(`/api/recipients/${id}`);
    }

    async createRecipient(recipient: RecipientCreate): Promise<{ recipient: Recipient; wasCreated: boolean }> {
        const { data, wasCreated } = await this.createWithStatus<RecipientCreate, Recipient>('/api/recipients', recipient);
        return { recipient: data, wasCreated };
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
        return this.requestWithQuery<PlannedTransactionsListResponse>('/api/planned-transactions', params);
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
        const queryParams = new URLSearchParams();
        queryParams.append('bank_name', bankName);
        return this.postMultipartImport('/api/import/csv', file, queryParams);
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

        const parseSseBlock = (block: string): { eventName: string; dataRaw: string } | undefined => {
            let eventName = 'message';
            const dataLines: string[] = [];

            for (const rawLine of block.split(/\r?\n/)) {
                if (!rawLine || rawLine.startsWith(':')) continue;
                if (rawLine.startsWith('event:')) {
                    const parsedName = rawLine.slice('event:'.length).trim();
                    eventName = parsedName || 'message';
                    continue;
                }
                if (rawLine.startsWith('data:')) {
                    dataLines.push(rawLine.slice('data:'.length).trimStart());
                }
            }

            if (dataLines.length === 0) return undefined;
            return { eventName, dataRaw: dataLines.join('\n') };
        };

        const extractErrorDetail = (payload: unknown): string => {
            if (payload && typeof payload === 'object' && 'detail' in payload) {
                const detail = (payload as { detail?: unknown }).detail;
                if (typeof detail === 'string' && detail.trim()) return detail;
            }
            return 'Import failed';
        };

        const result = (async (): Promise<ImportResult> => {
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

                const processEventBlock = (block: string) => {
                    const parsedEvent = parseSseBlock(block);
                    if (!parsedEvent) return;

                    let payload: unknown;
                    try {
                        payload = JSON.parse(parsedEvent.dataRaw);
                    } catch {
                        throw new Error('Invalid import stream payload');
                    }

                    if (parsedEvent.eventName === 'progress') {
                        onProgress(payload as ImportProgress);
                        return;
                    }

                    if (parsedEvent.eventName === 'complete') {
                        finalResult = payload as ImportResult;
                        onProgress({
                            ...(payload as Partial<ImportProgress>),
                            phase: 'complete',
                            percent: 100,
                        } as ImportProgress);
                        return;
                    }

                    if (parsedEvent.eventName === 'error') {
                        throw new Error(extractErrorDetail(payload));
                    }
                };

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });

                    let separatorMatch = buffer.match(/\r?\n\r?\n/);
                    while (separatorMatch) {
                        const separatorIndex = separatorMatch.index ?? -1;
                        if (separatorIndex < 0) break;

                        const block = buffer.slice(0, separatorIndex);
                        buffer = buffer.slice(separatorIndex + separatorMatch[0].length);
                        processEventBlock(block);
                        separatorMatch = buffer.match(/\r?\n\r?\n/);
                    }
                }

                const trailing = decoder.decode();
                if (trailing) {
                    buffer += trailing;
                }
                if (buffer.trim()) {
                    processEventBlock(buffer.trimEnd());
                }

                return finalResult || {
                    total_processed: 0,
                    imported: 0,
                    duplicates: 0,
                    errors: 0,
                    status: 'completed',
                };
            } catch (err) {
                if ((err as Error).name === 'AbortError') {
                    throw new Error('Import cancelled');
                }
                throw err;
            }
        })();

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

        return this.postMultipartImport('/api/import/csv/custom', file, queryParams);
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

    async importRecipients(
        file: File,
        separator: string = ',',
        encoding: string = 'utf-8',
    ): Promise<{ total_processed: number; imported: number; skipped: number; errors: number; status: string }> {
        const queryParams = new URLSearchParams({ separator, encoding });
        return this.postMultipartImport('/api/import/recipients', file, queryParams);
    }

    async importCategories(
        file: File,
        separator: string = ',',
        encoding: string = 'utf-8',
    ): Promise<{ total_processed: number; imported: number; skipped: number; errors: number; status: string }> {
        const queryParams = new URLSearchParams({ separator, encoding });
        return this.postMultipartImport('/api/import/categories', file, queryParams);
    }

    // ==================== Update Methods ====================

    async checkForUpdates(): Promise<{
        up_to_date: boolean;
        current_version: string;
        latest_version: string | null;
        published_at?: string;
        release_notes?: string;
        html_url?: string;
        error?: string;
    }> {
        const updater = this.getElectronUpdater();
        if (updater?.checkRelease) {
            return updater.checkRelease();
        }
        return this.request('/api/admin/update/check');
    }

    /**
     * Pull the latest Docker image and hot-swap the running container.
     * Only available inside the Electron desktop app (window.electronUpdater).
     * Returns null when called from a browser context.
     */
    async triggerDockerUpdate(): Promise<{ success: boolean; wasNew: boolean; error?: string } | null> {
        const updater = this.getElectronUpdater();
        if (!updater) return null;
        return updater.pullImage();
    }

    async installShellUpdate(): Promise<{ success: boolean; version?: string; error?: string } | null> {
        const updater = this.getElectronUpdater();
        if (!updater?.installShellUpdate) return null;
        return updater.installShellUpdate();
    }

    /** Whether the app is running inside the Electron desktop wrapper. */
    isElectron(): boolean {
        return !!this.getElectronUpdater();
    }

    // ==================== Backup Methods (Electron only) ====================

    /**
     * Run a pg_dump backup immediately, writing a backup file to the configured directory.
     * Only available inside the Electron desktop app.
     * Returns null when called from a browser context.
     */
    async runBackup(destDir: string): Promise<{ success: boolean; file?: string; encrypted?: boolean; warning?: string; cleanupRemoved?: number; error?: string } | null> {
        const backup = this.getElectronBackup();
        if (!backup) return null;
        return backup.runBackup(destDir);
    }

    /**
     * Open the system file-picker to choose a .sql backup file to restore.
     * Only available inside the Electron desktop app.
     */
    async selectBackupFile(): Promise<string | null> {
        const backup = this.getElectronBackup();
        if (!backup) return null;
        return backup.selectFile();
    }

    /**
     * Restore the database from a plain-SQL backup file.
     * Stops the app container, drops & recreates the DB, restores with psql,
     * then restarts the app container. The page will become temporarily
     * unreachable while the restore runs.
     * Only available inside the Electron desktop app.
     */
    async restoreBackup(sqlFilePath: string): Promise<{ success: boolean; file?: string; error?: string } | null> {
        const backup = this.getElectronBackup();
        if (!backup) return null;
        return backup.restoreBackup(sqlFilePath);
    }

    /**
     * Open the system folder-picker to choose a backup directory.
     * Only available inside the Electron desktop app.
     */
    async selectBackupDir(): Promise<string | null> {
        const backup = this.getElectronBackup();
        if (!backup) return null;
        return backup.selectDir();
    }

    /**
     * Persist backup settings to the database via the backend API.
     * This ensures settings survive Docker container restarts and are the single
     * source of truth. Also mirrors to Electron settings.json (via IPC) as a
     * fallback for the will-quit backup handler in case the backend is already down.
     */
    async saveBackupSettings(settings: { backupDir: string; backupOnQuit: boolean }): Promise<void> {
        // Primary: persist to DB
        await this.saveSetting('backup_settings', settings);
        // Secondary: mirror to Electron settings.json (best-effort, non-blocking)
        const backup = this.getElectronBackup();
        if (backup) backup.saveSettings(settings).catch(() => {});
    }

    /**
     * Load backup settings from the database via the backend API.
     * Falls back to Electron settings.json (via IPC) if the backend is not yet available.
     */
    async loadBackupSettings(): Promise<{ backupDir: string; backupOnQuit: boolean } | null> {
        const backup = this.getElectronBackup();
        if (backup) {
            try {
                return await backup.loadSettings();
            } catch {
                // fall through to backend API read
            }
        }
        try {
            const result = await this.getSetting('backup_settings');
            if (result?.value) {
                const v = result.value as { backupDir?: string; backupOnQuit?: boolean };
                return { backupDir: v.backupDir ?? '', backupOnQuit: v.backupOnQuit ?? false };
            }
        } catch {
            // fall through
        }
        return null;
    }

    async getBackupEncryptionStatus(): Promise<{ success: boolean; secureStorageAvailable: boolean; hasStoredPassphrase: boolean; hasEnvPassphrase: boolean } | null> {
        const backup = this.getElectronBackup();
        if (!backup?.getEncryptionStatus) return null;
        return backup.getEncryptionStatus();
    }

    async setBackupPassphrase(passphrase: string): Promise<{ success: boolean; available: boolean; error?: string } | null> {
        const backup = this.getElectronBackup();
        if (!backup?.setPassphrase) return null;
        return backup.setPassphrase(passphrase);
    }

    // ==================== Info/Statistics Methods ====================

    async getStatistics(params?: { currency?: string }): Promise<{
        total_transactions: number;
        total_amount: number;
        categories: Array<{ name: string; count: number }>;
    }> {
        return this.requestWithQuery('/api/info', params);
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
        currency?: string;
    }): Promise<{
        total_count: number;
        total_amount: number;
        average: number;
        min: number | null;
        max: number | null;
    }> {
        return this.requestWithQuery('/api/info/transaction-summary', params);
    }

    async getTransactionCount(): Promise<{ total_transactions: number }> {
        return this.request('/api/info/transaction-count');
    }

    async getCashflowComparison(params?: {
        excluded_category_ids?: number[];
        excluded_recipient_ids?: number[];
        currency?: string;
    }): Promise<{
        days_in_month: number;
        current_day: number;
        month: number;
        year: number;
        without_planned: Array<{ day: number; average: number; current: number | null }>;
        with_planned: Array<{ day: number; average: number; current: number | null }>;
    }> {
        const q = this.buildExclusionQuery(params);
        return this.request(`/api/info/cashflow-comparison${q ? `?${q}` : ''}`);
    }

    async getMonthlyFinancialSummary(params?: {
        excluded_category_ids?: number[];
        excluded_recipient_ids?: number[];
        currency?: string;
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
        const q = this.buildExclusionQuery(params);
        return this.request(`/api/info/monthly-summary${q ? `?${q}` : ''}`);
    }

    async getBankBalances(params?: { currency?: string }): Promise<{
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
        return this.requestWithQuery('/api/info/bank-balances', params);
    }

    async getBelgianInflationRates(params?: { start_month?: string; end_month?: string; db_only?: boolean }): Promise<{
        source: 'memory' | 'database' | 'statbel' | 'eurostat';
        total_rates: number;
        rates: Array<{ month: string; monthly_rate: number }>;
    }> {
        return this.requestWithQuery('/api/info/inflation-rates', params);
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
        try {
            return await this.request('/api/info/recurring-patterns');
        } catch (err) {
            // Fail-soft: recurrence detection is optional UI enrichment.
            // Returning an empty payload avoids repeated query retries/noise.
            logger.warn('Recurring patterns unavailable; using empty result', err);
            return { patterns: [], total: 0 };
        }
    }

    // ==================== Portfolio / Investments ====================

    async getInvestments(params?: {
        limit?: number;
        offset?: number;
        asset_class?: string;
        active?: boolean;
    }): Promise<InvestmentsListResponse> {
        return this.requestWithQuery<InvestmentsListResponse>('/api/investments', params);
    }

    async getInvestment(id: number): Promise<Investment> {
        return this.request<Investment>(`/api/investments/${id}`);
    }

    async createInvestment(data: InvestmentCreate): Promise<Investment> {
        return this.request<Investment>('/api/investments', { method: 'POST', body: JSON.stringify(data) });
    }

    async refreshInvestmentPrices(): Promise<{ updated: number; total: number; prices: Record<string, number>; priceSources: Record<string, 'live' | 'close' | 'cached'> }> {
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

    async getInvestmentPriceHistory(investmentId: number, params?: {
        from_ms?: number;
        to_ms?: number;
        db_only?: boolean;
    }): Promise<{ investment_id: number; provider: string; points: Array<{ timestampMs: number; price: number }> }> {
        return this.requestWithQuery(`/api/investments/${investmentId}/price-history`, params);
    }

    async getPortfolioTransactions(investmentId: number, params?: {
        type?: string;
        limit?: number;
        offset?: number;
    }): Promise<PortfolioTransactionsListResponse> {
        const res = await this.requestWithQuery<PortfolioTransactionsListResponse>(`/api/investments/${investmentId}/transactions`, params);
        res.items = res.items.map((tx) => ({
            ...tx,
            date: tx.date ?? tx.transaction_date,
        }));
        return res;
    }

    async getPortfolioTransactionsBulk(params: {
        investment_ids: string;
        type?: string;
        per_investment_limit?: number;
        limit?: number;
        offset?: number;
    }): Promise<PortfolioTransactionsListResponse> {
        const res = await this.requestWithQuery<PortfolioTransactionsListResponse>('/api/investments/transactions', params);
        res.items = res.items.map((tx) => ({
            ...tx,
            date: tx.date ?? tx.transaction_date,
        }));
        return res;
    }

    async createPortfolioTransaction(investmentId: number, data: PortfolioTransactionCreate): Promise<PortfolioTransaction> {
        return this.request<PortfolioTransaction>(`/api/investments/${investmentId}/transactions`, {
            method: 'POST', body: JSON.stringify(data),
        });
    }

    async updatePortfolioTransaction(txnId: number, data: Partial<PortfolioTransactionCreate>): Promise<PortfolioTransaction> {
        return this.request<PortfolioTransaction>(`/api/investments/transactions/${txnId}`, {
            method: 'PATCH', body: JSON.stringify(data),
        });
    }

    async deletePortfolioTransaction(txnId: number): Promise<void> {
        await this.request<void>(`/api/investments/transactions/${txnId}`, { method: 'DELETE' });
    }

    // ==================== Market News ====================

    async getMarketNews(symbols?: string[], count?: number): Promise<{ articles: MarketNewsArticle[] }> {
        const params: Record<string, any> = {};
        if (symbols?.length) params.symbols = symbols.join(',');
        if (count) params.count = count;
        return this.requestWithQuery('/api/market/news', params);
    }

    // ==================== Net Worth ====================

    async getNetWorth(params?: { currency?: string }): Promise<NetWorthResponse> {
        return this.requestWithQuery('/api/info/net-worth', params);
    }

    // ==================== Portfolio Performance ====================

    async getPortfolioPerformance(params?: {
        currency?: string;
        period?: string;
    }): Promise<{
        currency: string;
        start_date: string;
        end_date: string;
        snapshots: Array<{
            date: string;
            invested: number;
            value: number;
            stocks_etfs_value: number;
            crypto_value: number;
            metals_value: number;
            stocks_etfs_invested: number;
            crypto_invested: number;
            metals_invested: number;
            inflation_adjusted_value: number;
            gain_loss: number;
            return_pct: number;
        }>;
        metrics: {
            currentValue: number;
            totalInvested: number;
            totalGainLoss: number;
            totalReturnPct: number;
            annualizedReturn: number;
            realReturnPct: number;
            cumulativeInflation: number;
        } | null;
        heatmap: {
            years: number[];
            data: Record<number, (number | null)[]>;
            maxAbsPct: number;
        };
        breakdownSummary: Array<{
            id: number;
            name: string;
            symbol: string;
            assetClass: string;
            currency: string;
            currentValue: number;
            totalInvested: number;
            gainLoss: number;
            gainLossPercent: number;
        }>;
    }> {
        return this.requestWithQuery('/api/info/portfolio-performance', params);
    }

    // ==================== Recipient Insights ====================

    async getRecipientInsights(params?: { currency?: string }): Promise<{
        topMerchants: Array<{
            recipientId: number;
            name: string;
            totalSpend: number;
            transactionCount: number;
            avgAmount: number;
            firstSeen: string;
            lastSeen: string;
        }>;
        monthOverMonth: Array<{
            recipientId: number;
            name: string;
            currentSpend: number;
            previousSpend: number;
            changePercent: number;
        }>;
    }> {
        return this.requestWithQuery('/api/info/recipient-insights', params);
    }

    // ==================== Splits / Owes Methods ====================

    async getOwedSummary(): Promise<{ items: any[] }> {
        return this.request('/api/splits/owed');
    }

    async getOwedByRecipient(recipientId: number): Promise<{ items: any[] }> {
        return this.request(`/api/splits/owed/${recipientId}`);
    }

    async exportOwedByRecipientCsv(recipientId: number): Promise<Blob> {
        const response = await fetch(`${API_BASE_URL}/api/splits/owed/${recipientId}/export/csv`, {
            method: 'GET',
        });

        if (!response.ok) {
            let detail = 'Failed to export owed transactions';
            try {
                const payload = await response.json();
                detail = payload?.detail || detail;
            } catch {
                // keep fallback detail
            }
            throw new Error(detail);
        }

        return response.blob();
    }

    async getSplitsByTransaction(transactionId: number): Promise<{ items: any[] }> {
        return this.request(`/api/splits/transaction/${transactionId}`);
    }

    async createSplitsBatch(transactionId: number, splits: Array<{ recipient_id: number; amount: number; note?: string }>): Promise<{ items: any[] }> {
        return this.request('/api/splits/batch', {
            method: 'POST',
            body: JSON.stringify({ transaction_id: transactionId, splits }),
        });
    }

    async recordSplitPayment(splitId: number, amount: number, note?: string, paid_at?: string): Promise<any> {
        return this.request(`/api/splits/${splitId}/pay`, {
            method: 'POST',
            body: JSON.stringify({ amount, note, paid_at }),
        });
    }

    async settleSplit(splitId: number): Promise<any> {
        return this.request(`/api/splits/${splitId}/settle`, { method: 'POST' });
    }

    async settleAllSplitsByRecipient(recipientId: number): Promise<{ settled_count: number }> {
        return this.request(`/api/splits/owed/${recipientId}/settle-all`, { method: 'POST' });
    }

    async deleteSplit(splitId: number): Promise<any> {
        return this.request(`/api/splits/${splitId}`, { method: 'DELETE' });
    }

    // ==================== Admin / Maintenance ====================

    async refreshMaterializedViews(): Promise<{ message: string; duration_ms: number }> {
        return this.request('/api/info/refresh-views', { method: 'POST' });
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
     * Build query string when present and perform a GET request.
     */
    private requestWithQuery<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
        const query = this.buildQuery(params);
        return this.request<T>(`${endpoint}${query ? `?${query}` : ''}`);
    }

    private buildExclusionQuery(params?: {
        excluded_category_ids?: number[];
        excluded_recipient_ids?: number[];
        currency?: string;
    }): string {
        const queryParams = new URLSearchParams();

        if (params?.excluded_category_ids?.length) {
            params.excluded_category_ids.forEach((id) => queryParams.append('excluded_category_ids', String(id)));
        }
        if (params?.excluded_recipient_ids?.length) {
            params.excluded_recipient_ids.forEach((id) => queryParams.append('excluded_recipient_ids', String(id)));
        }
        if (params?.currency) {
            queryParams.set('currency', params.currency);
        }

        return queryParams.toString();
    }

    private async createWithStatus<TPayload, TData>(endpoint: string, payload: TPayload): Promise<{ data: TData; wasCreated: boolean }> {
        const url = `${API_BASE_URL}${endpoint}`;
        const response = await this.rawFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        const data = await response.json();
        return { data, wasCreated: response.status === 201 };
    }

    private async postMultipartImport<T>(endpoint: string, file: File, queryParams: URLSearchParams): Promise<T> {
        const formData = new FormData();
        formData.append('file', file);

        const query = queryParams.toString();
        const url = `${API_BASE_URL}${endpoint}${query ? `?${query}` : ''}`;
        const response = await this.rawFetch(url, { method: 'POST', body: formData });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Request failed' }));
            throw new Error(error.detail || error.message || 'Request failed');
        }

        return response.json();
    }

    private getElectronUpdater(): {
        checkRelease?: () => Promise<{
            up_to_date: boolean;
            current_version: string;
            latest_version: string | null;
            published_at?: string;
            release_notes?: string;
            html_url?: string;
            error?: string;
        }>;
        pullImage: () => Promise<{ success: boolean; wasNew: boolean; error?: string }>;
        installShellUpdate?: () => Promise<{ success: boolean; version?: string; error?: string }>;
    } | undefined {
        return (window as Window & {
            electronUpdater?: {
                checkRelease?: () => Promise<{
                    up_to_date: boolean;
                    current_version: string;
                    latest_version: string | null;
                    published_at?: string;
                    release_notes?: string;
                    html_url?: string;
                    error?: string;
                }>;
                pullImage: () => Promise<{ success: boolean; wasNew: boolean; error?: string }>;
                installShellUpdate?: () => Promise<{ success: boolean; version?: string; error?: string }>;
            };
        }).electronUpdater;
    }

    private getElectronBackup(): {
        runBackup: (destDir: string) => Promise<{ success: boolean; file?: string; encrypted?: boolean; warning?: string; cleanupRemoved?: number; error?: string }>;
        selectFile: () => Promise<string | null>;
        restoreBackup: (sqlFilePath: string) => Promise<{ success: boolean; file?: string; error?: string }>;
        selectDir: () => Promise<string | null>;
        saveSettings: (settings: { backupDir: string; backupOnQuit: boolean }) => Promise<void>;
        loadSettings: () => Promise<{ backupDir: string; backupOnQuit: boolean }>;
        getEncryptionStatus?: () => Promise<{ success: boolean; secureStorageAvailable: boolean; hasStoredPassphrase: boolean; hasEnvPassphrase: boolean }>;
        setPassphrase?: (passphrase: string) => Promise<{ success: boolean; available: boolean; error?: string }>;
    } | undefined {
        return (window as Window & {
            electronBackup?: {
                runBackup: (destDir: string) => Promise<{ success: boolean; file?: string; encrypted?: boolean; warning?: string; cleanupRemoved?: number; error?: string }>;
                selectFile: () => Promise<string | null>;
                restoreBackup: (sqlFilePath: string) => Promise<{ success: boolean; file?: string; error?: string }>;
                selectDir: () => Promise<string | null>;
                saveSettings: (settings: { backupDir: string; backupOnQuit: boolean }) => Promise<void>;
                loadSettings: () => Promise<{ backupDir: string; backupOnQuit: boolean }>;
                getEncryptionStatus?: () => Promise<{ success: boolean; secureStorageAvailable: boolean; hasStoredPassphrase: boolean; hasEnvPassphrase: boolean }>;
                setPassphrase?: (passphrase: string) => Promise<{ success: boolean; available: boolean; error?: string }>;
            };
        }).electronBackup;
    }

    // ==================== Saved Charts Methods ====================

    async getSavedCharts(): Promise<SavedChart[]> {
        return this.request('/api/saved-charts');
    }

    async createSavedChart(payload: SavedChartCreate): Promise<SavedChart> {
        return this.request('/api/saved-charts', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    async updateSavedChart(id: number, payload: Partial<SavedChartCreate>): Promise<SavedChart> {
        return this.request(`/api/saved-charts/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });
    }

    async deleteSavedChart(id: number): Promise<void> {
        return this.request(`/api/saved-charts/${id}`, { method: 'DELETE' });
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

export interface SavedChart {
    id: number;
    name: string;
    chart_type: 'line' | 'bar' | 'area';
    category_ids: number[];
    created_at: string;
    updated_at: string;
}

export interface SavedChartCreate {
    name: string;
    chartType: 'line' | 'bar' | 'area';
    categoryIds: number[];
}

export interface MarketNewsArticle {
    title: string;
    link: string;
    publisher: string;
    publishedAt: number | null;
    thumbnail: string | null;
    relatedSymbols: string[];
}

export interface NetWorthSnapshot {
    date: string;
    liquid: number;
    investments: number;
    netWorth: number;
}

export interface NetWorthResponse {
    current: {
        liquid: number;
        investments: number;
        netWorth: number;
    };
    monthlyChange: number;
    monthlyChangePercent: number;
    snapshots: NetWorthSnapshot[];
}

export const apiClient = new ApiClient();
export type { Transaction, Category, Recipient, PlannedTransaction, Investment, PortfolioTransaction };
