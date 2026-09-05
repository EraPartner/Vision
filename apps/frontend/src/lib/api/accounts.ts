import type {
    Account,
    AccountCreate,
    AccountUpdate,
    AccountsListResponse,
} from "@/types/api";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery } from "@/lib/api/helpers";

// Money fields the Account type declares as numbers. `statement_balance` is a
// raw PostgreSQL NUMERIC column and still arrives as a string; the derived
// balance figures (computed_balance / reconcilable_balance / drift) are summed
// server-side in JS and already arrive as JSON numbers. Coercing all of them
// here — at the single fetch boundary — keeps the runtime shape honest for every
// consumer (e.g. AccountsPage's drift.toFixed()) regardless of which side of
// that boundary a given field is produced on. `null` becomes `undefined`: the
// backend's convention is that absent means absent.
function normalizeAccount(a: Account): Account {
    return {
        ...a,
        statement_balance:
            a.statement_balance == null
                ? undefined
                : Number(a.statement_balance),
        computed_balance:
            a.computed_balance == null ? undefined : Number(a.computed_balance),
        balance_parts: a.balance_parts?.map((part) => ({
            ...part,
            balance: Number(part.balance),
        })),
        statement_balances: a.statement_balances?.map((statement) => ({
            ...statement,
            balance: Number(statement.balance),
        })),
        reconcilable_balance:
            a.reconcilable_balance == null
                ? undefined
                : Number(a.reconcilable_balance),
        drift: a.drift == null ? undefined : Number(a.drift),
    };
}

export async function getAccounts(params?: {
    active?: "true" | "false" | "all";
}): Promise<AccountsListResponse> {
    const res = await requestWithQuery<AccountsListResponse>(
        "/api/accounts",
        params,
    );
    return { ...res, items: res.items.map(normalizeAccount) };
}

export function createAccount(account: AccountCreate): Promise<Account> {
    return apiRequest<Account>("/api/accounts", {
        method: "POST",
        body: JSON.stringify(account),
    });
}

export function updateAccount(
    id: number,
    account: AccountUpdate,
): Promise<Account> {
    return apiRequest<Account>(`/api/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(account),
    });
}

export async function deleteAccount(id: number): Promise<void> {
    await apiRequest<void>(`/api/accounts/${id}`, { method: "DELETE" });
}

export interface AccountMergeResult {
    into: number;
    merged: number[];
    reassigned: {
        transactions: number;
        planned: number;
        portfolio: number;
        funding: number;
    };
}

/** Merge source accounts into the survivor (targetId); repoints all references + deletes sources. */
export function mergeAccounts(
    targetId: number,
    sourceIds: number[],
): Promise<AccountMergeResult> {
    return apiRequest<AccountMergeResult>(`/api/accounts/${targetId}/merge`, {
        method: "POST",
        body: JSON.stringify({ source_ids: sourceIds }),
    });
}

export interface AccountMergePreview {
    into: number;
    source: number;
    /** Row counts that WOULD move (same categories POST /merge repoints). */
    reassigned: {
        transactions: number;
        planned: number;
        portfolio: number;
        funding: number;
    };
    /** Post-merge computed balance: per-currency over the union of both accounts' active rows, converted into the survivor's currency. */
    projectedBalance: number;
    /** The survivor's native currency (ISO-4217). */
    projectedBalanceCurrency: string;
    /** Native per-currency partitions included in the preview. */
    balanceParts: Array<{ currency: string; balance: number }>;
    /** True when projectedBalance excludes partitions without a usable rate. */
    projectedBalanceIncomplete: boolean;
    /** Currency codes excluded from projectedBalance. */
    unconvertedCurrencies: string[];
    /** Both accounts carry stamped balance histories with overlapping date ranges — the merge clears the survivor's statement anchor. */
    stampsInterleaved: boolean;
    /** Both accounts hold an opening balance in the same currency — POST /merge refuses (400) until one is removed. */
    openingAnchorCollision: boolean;
}

/**
 * Dry-run of merging `sourceId` INTO `targetId` (WP-A3 endpoint; read-only, no
 * mutation). Feeds the merge dialog's "{n} transactions + {m} planned will
 * move; resulting balance X" preview and the interleaved-stamp warning.
 */
export function previewMerge(
    sourceId: number,
    targetId: number,
): Promise<AccountMergePreview> {
    return requestWithQuery<AccountMergePreview>(
        `/api/accounts/${sourceId}/merge-preview`,
        { into: targetId },
    );
}

export interface OpeningBalanceInput {
    balance: number;
    date: string;
    currency?: string;
}

export interface OpeningBalanceResult {
    transaction: {
        id: number;
        balance: number;
        transfer_source: string;
    } | null;
    /** Set when the anchor date does not precede existing activity (anchor+delta makes it inert). */
    warning: string | null;
}

/**
 * Set (create or update) the opening-balance anchor for a manual/cash-only account
 * (ADR-094 second addendum, D4). Stamps one system row per account+currency; the
 * single sanctioned exception to the `transactions.balance` write-protection.
 */
export function setOpeningBalance(
    id: number,
    input: OpeningBalanceInput,
): Promise<OpeningBalanceResult> {
    return apiRequest<OpeningBalanceResult>(
        `/api/accounts/${id}/opening-balance`,
        {
            method: "POST",
            body: JSON.stringify(input),
        },
    );
}

export type ReconcileMode = "accept" | "adjustment";

export interface ReconcileResult {
    mode: ReconcileMode;
    /** Drift after the operation — always 0 on success. */
    drift: number;
    currency: string;
    statement_balance: number;
    /**
     * The reconciliation base after the operation — the balance of the ONE
     * currency partition the statement figure is a statement for (the account's
     * `reconcilable_balance`), NOT the FX-converted `computed_balance`.
     */
    computed_balance: number;
    /** The server-created adjustment row (mode 'adjustment'), else null. */
    transaction: { id: number; amount: number; transfer_source: string } | null;
}

/**
 * Reconcile an account's drift (ADR-094, Phase C). Both modes act on the
 * reconciliation base (`reconcilable_balance`), so a multi-currency account
 * resolves in its own currency and its other partitions are untouched.
 * `mode: 'accept'` rewrites the stored statement figures to that base;
 * `mode: 'adjustment'` stamps a server-side 'adjustment' ledger row in
 * `reconcilable_currency` so the base rises to meet the statement (balance-free
 * — ADR-094 descriptive-only default preserved).
 */
export function reconcileAccount(
    id: number,
    mode: ReconcileMode,
    currency?: string,
): Promise<ReconcileResult> {
    return apiRequest<ReconcileResult>(`/api/accounts/${id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ mode, currency }),
    });
}

export function setStatementBalance(
    id: number,
    currency: string,
    input: { balance: number; date: string },
): Promise<{
    account_id: number;
    currency: string;
    balance: number;
    balance_date: string;
}> {
    return apiRequest(`/api/accounts/${id}/statement-balances/${currency}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteStatementBalance(
    id: number,
    currency: string,
): Promise<{ account_id: number; currency: string }> {
    return apiRequest(`/api/accounts/${id}/statement-balances/${currency}`, {
        method: "DELETE",
    });
}
