import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Account, PortfolioBrokerRetagReceipt } from "@/types/api";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { invalidateAccountRepoint } from "@/lib/queryKeys";
import { useAccounts } from "@/hooks/useAccounts";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";
import {
    PortfolioLotRetagChoice,
    UNASSIGNED_PORTFOLIO_LOTS,
} from "@/features/portfolio/PortfolioLotRetagChoice";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface Props {
    account: Account;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function BrokerTransferDialog({ account, open, onOpenChange }: Props) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const accountsQuery = useAccounts({ active: "true" });
    const accounts = activeBrokerAccounts(accountsQuery.data?.items ?? []);
    const [destination, setDestination] = useState("");
    const [receipt, setReceipt] = useState<PortfolioBrokerRetagReceipt>();
    const idempotencyRef = useRef<
        { fingerprint: string; key: string } | undefined
    >(undefined);
    const preview = useQuery({
        queryKey: ["account-portfolio-lot-retag-preview", account.id],
        queryFn: () => apiClient.getAccountPortfolioLotRetagPreview(account.id),
        enabled: open,
    });

    useEffect(() => {
        if (!open) return;
        setDestination("");
        setReceipt(undefined);
        idempotencyRef.current = undefined;
    }, [open]);

    const transfer = useMutation({
        mutationFn: async () => {
            const data = preview.data;
            if (
                !data ||
                data.eligible_count === 0 ||
                data.eligible_count > data.limit ||
                data.transaction_ids.length !== data.eligible_count ||
                !destination
            ) {
                throw new Error(t("portfolio.brokerTransfer.unavailable"));
            }
            const toAccountId =
                destination === UNASSIGNED_PORTFOLIO_LOTS
                    ? null
                    : Number(destination);
            const fingerprint = `${data.transaction_ids.join(",")}|${account.id}|${toAccountId ?? "unassigned"}`;
            if (idempotencyRef.current?.fingerprint !== fingerprint) {
                idempotencyRef.current = {
                    fingerprint,
                    key: crypto.randomUUID(),
                };
            }
            return apiClient.bulkRetagPortfolioTransactions({
                transaction_ids: data.transaction_ids,
                from_account_id: account.id,
                to_account_id: toAccountId,
                idempotency_key: idempotencyRef.current.key,
            });
        },
        onSuccess: (result) => {
            setReceipt(result);
            invalidateAccountRepoint(queryClient);
            toast.success(t("portfolio.brokerTransfer.done"), {
                description: t("portfolio.brokerTransfer.doneHint", {
                    count: String(result.changed_count),
                }),
            });
        },
        onError: (error: Error) =>
            toast.error(t("portfolio.brokerTransfer.failed"), {
                description: apiErrorToMessage(error, t),
            }),
    });

    const overLimit =
        preview.data != null &&
        preview.data.eligible_count > preview.data.limit;
    const disabled =
        !destination ||
        preview.isLoading ||
        preview.isError ||
        !preview.data ||
        preview.data.eligible_count === 0 ||
        overLimit ||
        transfer.isPending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {t("portfolio.brokerTransfer.title", {
                            name: account.display_name || account.name,
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("portfolio.brokerTransfer.description")}
                    </DialogDescription>
                </DialogHeader>

                {receipt ? (
                    <div className="space-y-2 rounded-md border border-gain/30 bg-gain/5 p-3 text-sm">
                        <p className="font-medium">
                            {t("portfolio.brokerTransfer.receipt")}
                        </p>
                        <p>
                            {t("portfolio.brokerTransfer.receiptCount", {
                                count: String(receipt.changed_count),
                            })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("portfolio.brokerTransfer.receiptId", {
                                id: String(receipt.receipt_id),
                            })}
                        </p>
                    </div>
                ) : preview.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("portfolio.brokerTransfer.loading")}
                    </div>
                ) : preview.isError ? (
                    <p className="text-sm text-warning" role="alert">
                        {t("portfolio.brokerTransfer.unavailable")}
                    </p>
                ) : preview.data?.eligible_count === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t("portfolio.brokerTransfer.empty")}
                    </p>
                ) : (
                    <>
                        <PortfolioLotRetagChoice
                            sourceAccountId={account.id}
                            accounts={accounts}
                            eligibleCount={preview.data?.eligible_count ?? 0}
                            value={destination}
                            onValueChange={setDestination}
                            placeholder={t(
                                "portfolio.brokerTransfer.chooseDestination",
                            )}
                            disabled={overLimit}
                        />
                        {overLimit && (
                            <p className="text-xs text-warning">
                                {t("portfolio.brokerTransfer.overLimit", {
                                    limit: String(preview.data?.limit ?? 500),
                                })}
                            </p>
                        )}
                    </>
                )}

                <DialogFooter>
                    {receipt ? (
                        <Button onClick={() => onOpenChange(false)}>
                            {t("common.close")}
                        </Button>
                    ) : (
                        <>
                            <Button
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                {t("common.cancel")}
                            </Button>
                            <Button
                                disabled={disabled}
                                onClick={() => transfer.mutate()}
                            >
                                {transfer.isPending ? (
                                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                ) : (
                                    <ArrowRightLeft className="mr-1 h-4 w-4" />
                                )}
                                {t("portfolio.brokerTransfer.confirm")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
