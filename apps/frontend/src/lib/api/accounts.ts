import type {
    Account,
    AccountCreate,
    AccountUpdate,
    AccountsListResponse,
} from "@/types/api";
import {
    AccountListSchema,
    AccountMergePreviewSchema,
    AccountMergeResultSchema,
    AccountPortfolioLotRetagPreviewSchema,
    AccountSchema,
    AccountTotalsSchema,
    OpeningBalanceResultSchema,
} from "@vision/types/contracts";
import type { AccountTotals } from "@vision/types/contracts";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery } from "@/lib/api/helpers";
import type {
    AccountId,
    CurrencyCode,
    PortfolioTransactionId,
    TransactionId,
} from "@vision/types/brands";
import {
    AccountIdSchema,
    CurrencyCodeSchema,
    TransactionIdSchema,
} from "@vision/types/brands";
import { z } from "zod";

// Money fields the Account type declares as numbers. accountService.list emits
// them as JSON numbers and AccountListSchema requires that, so no numeric
// conversion is needed; the one real conversion is `null` (no statement
// reading) becoming `undefined`: the frontend convention is that absent means
// absent.
function normalizeAccount(a: Account): Account {
    return {
        ...a,
        computed_balance: a.computed_balance ?? undefined,
        reconcilable_balance: a.reconcilable_balance ?? undefined,
        drift: a.drift ?? undefined,
    };
}

export async function getAccounts(params?: {
    active?: "true" | "false" | "all" | undefined;
}): Promise<AccountsListResponse> {
    const res = await requestWithQuery<AccountsListResponse>(
        "/api/accounts",
        params,
        { schema: AccountListSchema },
    );
    return { ...res, items: res.items.map(normalizeAccount) };
}

export type { AccountTotals };

/**
 * Accounts hub totals computed on the server in `currency`: converted
 * per-account balances, group subtotals and net cash (ADR-216).
 */
export function getAccountTotals(currency: CurrencyCode): Promise<AccountTotals> {
    return requestWithQuery<AccountTotals>(
        "/api/accounts/totals",
        { currency },
        { schema: AccountTotalsSchema },
    );
}

export function createAccount(account: AccountCreate): Promise<Account> {
    return apiRequest<Account>("/api/accounts", {
        method: "POST",
        body: JSON.stringify(account),
        schema: AccountSchema,
    });
}

export function updateAccount(
    id: AccountId,
    account: AccountUpdate,
): Promise<Account> {
    return apiRequest<Account>(`/api/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(account),
        schema: AccountSchema,
    });
}

export async function deleteAccount(id: AccountId): Promise<void> {
    await apiRequest(`/api/accounts/${id}`, { method: "DELETE" });
}

export type AccountCloseBalanceHandling = "preserve" | "adjustment";

export interface AccountPortfolioLotRetagPreview {
    account_id: AccountId;
    eligible_count: number;
    transaction_ids: PortfolioTransactionId[];
    limit: number;
}

export function getAccountPortfolioLotRetagPreview(
    id: AccountId,
): Promise<AccountPortfolioLotRetagPreview> {
    return apiRequest<AccountPortfolioLotRetagPreview>(
        `/api/accounts/${id}/portfolio-lot-retag-preview`,
        { schema: AccountPortfolioLotRetagPreviewSchema },
    );
}

export interface AccountCloseResult {
    account_id: AccountId;
    balance_handling: AccountCloseBalanceHandling;
    already_closed: boolean;
    adjustments: Array<{
        id: TransactionId;
        amount: number;
        currency: CurrencyCode;
        transfer_source: "adjustment";
    }>;
}

/** `POST /api/accounts/:id/close`: money amounts are JSON numbers. */
const AccountCloseResultSchema = z.looseObject({
    account_id: AccountIdSchema,
    balance_handling: z.enum(["preserve", "adjustment"]),
    already_closed: z.boolean(),
    adjustments: z.array(
        z.looseObject({
            id: TransactionIdSchema,
            amount: z.number(),
            currency: CurrencyCodeSchema,
            transfer_source: z.literal("adjustment"),
        }),
    ),
});

export function closeAccount(
    id: AccountId,
    balanceHandling: AccountCloseBalanceHandling,
): Promise<AccountCloseResult> {
    return apiRequest<AccountCloseResult>(`/api/accounts/${id}/close`, {
        method: "POST",
        body: JSON.stringify({ balance_handling: balanceHandling }),
        schema: AccountCloseResultSchema,
    });
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
    targetId: AccountId,
    sourceIds: AccountId[],
): Promise<AccountMergeResult> {
    return apiRequest<AccountMergeResult>(`/api/accounts/${targetId}/merge`, {
        method: "POST",
        body: JSON.stringify({ source_ids: sourceIds }),
        schema: AccountMergeResultSchema,
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
    projectedBalanceCurrency: CurrencyCode;
    /** Native per-currency partitions included in the preview. */
    balanceParts: Array<{ currency: CurrencyCode; balance: number }>;
    /** True when projectedBalance excludes partitions without a usable rate. */
    projectedBalanceIncomplete: boolean;
    /** Currency codes excluded from projectedBalance. */
    unconvertedCurrencies: CurrencyCode[];
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
    sourceId: AccountId,
    targetId: AccountId,
): Promise<AccountMergePreview> {
    return requestWithQuery<AccountMergePreview>(
        `/api/accounts/${sourceId}/merge-preview`,
        { into: targetId },
        { schema: AccountMergePreviewSchema },
    );
}

export interface OpeningBalanceInput {
    balance: number;
    date: string;
    currency?: CurrencyCode;
}

export interface OpeningBalanceResult {
    transaction: {
        id: TransactionId;
        /** NUMERIC decimal string: the anchor is a raw `RETURNING *` row. */
        balance: string;
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
    id: AccountId,
    input: OpeningBalanceInput,
): Promise<OpeningBalanceResult> {
    return apiRequest<OpeningBalanceResult>(
        `/api/accounts/${id}/opening-balance`,
        {
            method: "POST",
            body: JSON.stringify(input),
            schema: OpeningBalanceResultSchema,
        },
    );
}

export type ReconcileMode = "accept" | "adjustment";

export interface ReconcileResult {
    mode: ReconcileMode;
    /** Drift after the operation — always 0 on success. */
    drift: number;
    currency: CurrencyCode;
    statement_balance: number;
    /**
     * The reconciliation base after the operation — the balance of the ONE
     * currency partition the statement figure is a statement for (the account's
     * `reconcilable_balance`), NOT the FX-converted `computed_balance`.
     */
    computed_balance: number;
    /** The server-created adjustment row (mode 'adjustment'), else null. */
    transaction: { id: TransactionId; amount: number; transfer_source: string } | null;
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
/** `POST /api/accounts/:id/reconcile`: money amounts are JSON numbers. */
const ReconcileResultSchema = z.looseObject({
    mode: z.enum(["accept", "adjustment"]),
    drift: z.number(),
    currency: CurrencyCodeSchema,
    statement_balance: z.number(),
    computed_balance: z.number(),
    transaction: z
        .looseObject({
            id: TransactionIdSchema,
            amount: z.number(),
            transfer_source: z.string(),
        })
        .nullable(),
});

export function reconcileAccount(
    id: AccountId,
    mode: ReconcileMode,
    currency?: CurrencyCode,
): Promise<ReconcileResult> {
    return apiRequest<ReconcileResult>(`/api/accounts/${id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ mode, currency }),
        schema: ReconcileResultSchema,
    });
}

/** `PUT /api/accounts/:id/statement-balances/:currency`. */
const StatementBalanceSchema = z.looseObject({
    account_id: AccountIdSchema,
    currency: CurrencyCodeSchema,
    balance: z.number(),
    balance_date: z.string(),
});

export function setStatementBalance(
    id: AccountId,
    currency: CurrencyCode,
    input: { balance: number; date: string },
): Promise<{
    account_id: AccountId;
    currency: CurrencyCode;
    balance: number;
    balance_date: string;
}> {
    return apiRequest(`/api/accounts/${id}/statement-balances/${currency}`, {
        method: "PUT",
        body: JSON.stringify(input),
        schema: StatementBalanceSchema,
    });
}

export function deleteStatementBalance(
    id: AccountId,
    currency: CurrencyCode,
): Promise<{ account_id: AccountId; currency: CurrencyCode }> {
    return apiRequest(`/api/accounts/${id}/statement-balances/${currency}`, {
        method: "DELETE",
    });
}
