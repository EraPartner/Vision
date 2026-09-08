import { useMemo } from "react";
import type { Account, PortfolioTransaction } from "@/types/api";
import { isPortfolioType } from "@/features/accounts/groupAccounts";
import { useAccounts } from "@/hooks/useAccounts";

export function activeBrokerAccounts(accounts: readonly Account[]): Account[] {
    return accounts.filter(
        (account) => account.is_active && isPortfolioType(account.type),
    );
}

function isNewer(
    candidate: PortfolioTransaction,
    current?: PortfolioTransaction,
): boolean {
    if (!current) return true;
    const candidateKey = [
        candidate.date || "",
        candidate.created_at || "",
        String(candidate.id).padStart(20, "0"),
    ].join("|");
    const currentKey = [
        current.date || "",
        current.created_at || "",
        String(current.id).padStart(20, "0"),
    ].join("|");
    return candidateKey > currentKey;
}

function latestAssignedAccount(
    transactions: readonly PortfolioTransaction[],
    validAccountIds: ReadonlySet<number>,
    predicate: (transaction: PortfolioTransaction) => boolean,
): number | undefined {
    let latest: PortfolioTransaction | undefined;
    for (const transaction of transactions) {
        if (
            transaction.account_id == null ||
            !validAccountIds.has(transaction.account_id) ||
            !predicate(transaction)
        ) {
            continue;
        }
        if (isNewer(transaction, latest)) latest = transaction;
    }
    return latest?.account_id ?? undefined;
}

/** ADR-108 manual-trade default: instrument, then global manual history. */
export function resolveManualTradeBrokerId({
    investmentId,
    transactions,
    accounts,
}: {
    investmentId?: number;
    transactions: readonly PortfolioTransaction[];
    accounts: readonly Account[];
}): number | undefined {
    const validAccountIds = new Set(
        activeBrokerAccounts(accounts).map((account) => account.id),
    );
    const instrumentAccount = latestAssignedAccount(
        transactions,
        validAccountIds,
        (transaction) => transaction.investment_id === investmentId,
    );
    if (instrumentAccount !== undefined) return instrumentAccount;

    return latestAssignedAccount(
        transactions,
        validAccountIds,
        (transaction) => transaction.import_batch_id == null,
    );
}

export function useManualTradeBrokerOptions(
    transactions: readonly PortfolioTransaction[],
    investmentId?: number,
) {
    const { data } = useAccounts({ active: "true" });
    const accounts = useMemo(
        () => activeBrokerAccounts(data?.items ?? []),
        [data?.items],
    );
    const defaultBrokerId = useMemo(
        () =>
            resolveManualTradeBrokerId({
                investmentId,
                transactions,
                accounts,
            }),
        [investmentId, transactions, accounts],
    );
    return { accounts, defaultBrokerId };
}
