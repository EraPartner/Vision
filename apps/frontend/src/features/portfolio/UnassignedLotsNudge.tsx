import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { LOT_TXN_TYPES } from "@vision/shared-utils/portfolio";
import { accountLabel } from "@/features/accounts/groupAccounts";
import { useManualTradeBrokerOptions } from "@/features/portfolio/manualTradeBroker";
import {
    useAllPortfolioTransactionsQuery,
    useInvestmentMutations,
} from "@/hooks/portfolio/useInvestments";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { PortfolioTransaction } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

interface Props {
    investmentId: number;
    investmentName: string;
    transactions: readonly PortfolioTransaction[];
}

export function UnassignedLotsNudge({
    investmentId,
    investmentName,
    transactions,
}: Props) {
    const { t } = useLanguage();
    const completeHistory = useAllPortfolioTransactionsQuery(investmentId);
    const completeTransactions = completeHistory.data ?? [];
    const { accounts, defaultBrokerId } = useManualTradeBrokerOptions(
        completeHistory.data ?? transactions,
        investmentId,
    );
    const { bulkRetagTransactions, isRetaggingTransactions } =
        useInvestmentMutations();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const idempotencyRef = useRef<
        { fingerprint: string; key: string } | undefined
    >(undefined);
    const unassignedIds = useMemo(
        () =>
            completeTransactions
                .filter(
                    (transaction) =>
                        transaction.investment_id === investmentId &&
                        transaction.account_id == null &&
                        LOT_TXN_TYPES.has(transaction.type),
                )
                .map((transaction) => transaction.id)
                .sort((a, b) => a - b),
        [completeTransactions, investmentId],
    );
    const [selectedBroker, setSelectedBroker] = useState<string>();
    const effectiveBroker =
        selectedBroker ??
        (defaultBrokerId != null
            ? String(defaultBrokerId)
            : accounts[0]
              ? String(accounts[0].id)
              : "");

    if (completeHistory.isLoading) {
        return (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t("portfolio.unassignedLotsLoading")}
            </div>
        );
    }
    if (completeHistory.isError) {
        return (
            <div className="mt-2 text-xs font-medium text-warning" role="alert">
                {t("portfolio.unassignedLotsLoadFailed")}
            </div>
        );
    }
    if (unassignedIds.length === 0) return null;
    const overLimit = unassignedIds.length > 500;

    const assign = async () => {
        const broker = accounts.find(
            (account) => account.id === Number(effectiveBroker),
        );
        if (!broker || overLimit) return;
        const approved = await confirm({
            title: t("portfolio.assignLotsReviewTitle"),
            description: t("portfolio.assignLotsReviewDescription", {
                count: String(unassignedIds.length),
                instrument: investmentName,
                broker: accountLabel(broker),
            }),
            confirmLabel: t("portfolio.assignLotsConfirm"),
        });
        if (!approved) return;

        const fingerprint = `${unassignedIds.join(",")}|${effectiveBroker}`;
        if (idempotencyRef.current?.fingerprint !== fingerprint) {
            idempotencyRef.current = {
                fingerprint,
                key: crypto.randomUUID(),
            };
        }
        let receipt;
        try {
            receipt = await bulkRetagTransactions({
                transaction_ids: unassignedIds,
                from_account_id: null,
                to_account_id: Number(effectiveBroker),
                idempotency_key: idempotencyRef.current.key,
            });
        } catch {
            // The mutation owns the authored error toast. Keep the key so a
            // retry after an ambiguous failure reaches server idempotency.
            return;
        }
        idempotencyRef.current = undefined;
        toast.success(
            t("portfolio.assignLotsSuccess", {
                count: String(receipt.changed_count),
            }),
        );
    };

    return (
        <>
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
                <AlertTriangle
                    className="h-3.5 w-3.5 shrink-0 text-warning"
                    aria-hidden="true"
                />
                <span className="text-xs text-muted-foreground">
                    {t("portfolio.unassignedLots", {
                        count: String(unassignedIds.length),
                    })}
                </span>
                {accounts.length > 0 ? (
                    <>
                        <Select
                            value={effectiveBroker}
                            onValueChange={setSelectedBroker}
                        >
                            <SelectTrigger
                                className="h-7 w-auto min-w-32 text-xs"
                                aria-label={t("portfolio.assignLotsBroker")}
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {accounts.map((account) => (
                                    <SelectItem
                                        key={account.id}
                                        value={String(account.id)}
                                    >
                                        {accountLabel(account)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={
                                !effectiveBroker ||
                                overLimit ||
                                isRetaggingTransactions
                            }
                            onClick={assign}
                        >
                            {isRetaggingTransactions && (
                                <Loader2
                                    className="mr-1 h-3 w-3 animate-spin"
                                    aria-hidden="true"
                                />
                            )}
                            {t("portfolio.assignLots")}
                        </Button>
                        {overLimit && (
                            <span className="text-xs font-medium text-warning">
                                {t("portfolio.assignLotsOverLimit")}
                            </span>
                        )}
                    </>
                ) : (
                    <span className="text-xs font-medium text-warning">
                        {t("portfolio.unassignedLotsNoBroker")}
                    </span>
                )}
            </div>
            <ConfirmDialog />
        </>
    );
}
