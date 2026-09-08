/**
 * Close-account workflow — the ONE lifecycle verb (§3 F5): closing sets
 * is_active=false, and the server also drops the account from aggregates
 * (in_net_worth=false, WP-A3 semantics). History and transactions are kept;
 * the account can be reopened later. A cash account with a residual defaults
 * to one visible system adjustment per currency partition so the ledger closes
 * at zero; users can explicitly preserve the residual instead.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, DoorClosed, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api";
import { invalidateAccountRepoint } from "@/lib/queryKeys";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { toast } from "sonner";
import type { Account } from "@/types/api";
import { isHoldingsOnlyPortfolioType, isPortfolioType } from "./groupAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";
import {
    KEEP_PORTFOLIO_LOTS,
    PortfolioLotRetagChoice,
    UNASSIGNED_PORTFOLIO_LOTS,
} from "@/features/portfolio/PortfolioLotRetagChoice";

interface CloseAccountDialogProps {
    account: Account;
    open: boolean;
    onOpenChange: (o: boolean) => void;
}

export function CloseAccountDialog({
    account,
    open,
    onOpenChange,
}: CloseAccountDialogProps) {
    const { t } = useLanguage();
    const fmtCur = useCurrencyFormatter();
    const queryClient = useQueryClient();
    const [zeroOut, setZeroOut] = useState(true);
    const [portfolioChoice, setPortfolioChoice] = useState(KEEP_PORTFOLIO_LOTS);
    const idempotencyRef = useRef<
        { fingerprint: string; key: string } | undefined
    >(undefined);
    const holdingsOnly = isHoldingsOnlyPortfolioType(account.type);
    const portfolioAccount = isPortfolioType(account.type);
    const accountsQuery = useAccounts({ active: "true" });
    const brokerAccounts = activeBrokerAccounts(
        accountsQuery.data?.items ?? [],
    );
    const portfolioPreview = useQuery({
        queryKey: ["account-portfolio-lot-retag-preview", account.id],
        queryFn: () => apiClient.getAccountPortfolioLotRetagPreview(account.id),
        enabled: open && portfolioAccount,
    });

    useEffect(() => {
        if (open) {
            setZeroOut(true);
            setPortfolioChoice(KEEP_PORTFOLIO_LOTS);
            idempotencyRef.current = undefined;
        }
    }, [open]);

    const residualParts = holdingsOnly
        ? []
        : account.balance_parts !== undefined
          ? account.balance_parts.filter(
                (part) => Math.abs(Number(part.balance)) >= 0.005,
            )
          : Math.abs(account.computed_balance ?? 0) >= 0.005
            ? [
                  {
                      currency: account.currency,
                      balance: account.computed_balance ?? 0,
                  },
              ]
            : [];
    const hasResidual = residualParts.length > 0;
    const residualLabel = residualParts
        .map((part) => fmtCur(Number(part.balance), part.currency))
        .join(", ");
    const shouldRetag =
        portfolioAccount &&
        portfolioChoice !== KEEP_PORTFOLIO_LOTS &&
        (portfolioPreview.data?.eligible_count ?? 0) > 0;
    const retagUnavailable =
        shouldRetag &&
        (portfolioPreview.isLoading ||
            portfolioPreview.isError ||
            !portfolioPreview.data ||
            portfolioPreview.data.eligible_count > portfolioPreview.data.limit);

    const close = useMutation({
        mutationFn: async () => {
            let movedCount = 0;
            try {
                if (shouldRetag) {
                    const preview = portfolioPreview.data;
                    if (
                        !preview ||
                        preview.eligible_count > preview.limit ||
                        preview.transaction_ids.length !==
                            preview.eligible_count
                    ) {
                        throw new Error(
                            t("accounts.close.portfolioUnavailable"),
                        );
                    }
                    const destination =
                        portfolioChoice === UNASSIGNED_PORTFOLIO_LOTS
                            ? null
                            : Number(portfolioChoice);
                    const fingerprint = `${preview.transaction_ids.join(",")}|${account.id}|${destination ?? "unassigned"}`;
                    if (idempotencyRef.current?.fingerprint !== fingerprint) {
                        idempotencyRef.current = {
                            fingerprint,
                            key: crypto.randomUUID(),
                        };
                    }
                    const receipt =
                        await apiClient.bulkRetagPortfolioTransactions({
                            transaction_ids: preview.transaction_ids,
                            from_account_id: account.id,
                            to_account_id: destination,
                            idempotency_key: idempotencyRef.current.key,
                        });
                    movedCount = receipt.changed_count;
                }

                await apiClient.closeAccount(
                    account.id,
                    !holdingsOnly && zeroOut ? "adjustment" : "preserve",
                );
                return { movedCount };
            } catch (error) {
                throw Object.assign(
                    error instanceof Error ? error : new Error(String(error)),
                    { movedCount },
                );
            }
        },
        onSuccess: ({ movedCount }) => {
            // Closing archives the account, so the same account/transaction/planned/
            // portfolio trees restate as in a merge. Invalidate exactly those instead
            // of the whole cache — see invalidateAccountRepoint.
            invalidateAccountRepoint(queryClient);
            idempotencyRef.current = undefined;
            toast.success(
                t("accounts.close.done", {
                    name: account.display_name || account.name,
                }),
                movedCount > 0
                    ? {
                          description: t("accounts.close.portfolioMoved", {
                              count: String(movedCount),
                          }),
                      }
                    : undefined,
            );
            onOpenChange(false);
        },
        onError: (e: Error & { movedCount?: number }) => {
            if ((e.movedCount ?? 0) > 0) {
                invalidateAccountRepoint(queryClient);
                toast.error(t("accounts.close.portfolioPartial"), {
                    description: t("accounts.close.portfolioPartialHint", {
                        count: String(e.movedCount),
                    }),
                });
                return;
            }
            toast.error(t("accounts.close.failed"), {
                description: apiErrorToMessage(e, t),
            });
        },
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {t("accounts.close.title", {
                            name: account.display_name || account.name,
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("accounts.close.description")}
                    </DialogDescription>
                </DialogHeader>

                {portfolioAccount && portfolioPreview.isLoading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("accounts.close.portfolioLoading")}
                    </div>
                )}
                {portfolioAccount && portfolioPreview.isError && (
                    <p className="text-xs text-warning" role="alert">
                        {t("accounts.close.portfolioUnavailable")}
                    </p>
                )}
                {portfolioAccount &&
                    portfolioPreview.data &&
                    portfolioPreview.data.eligible_count > 0 && (
                        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3">
                            <PortfolioLotRetagChoice
                                sourceAccountId={account.id}
                                accounts={brokerAccounts}
                                eligibleCount={
                                    portfolioPreview.data.eligible_count
                                }
                                value={portfolioChoice}
                                onValueChange={setPortfolioChoice}
                                allowKeep
                            />
                            {portfolioPreview.data.eligible_count >
                                portfolioPreview.data.limit && (
                                <p className="mt-2 text-xs text-warning">
                                    {t("accounts.close.portfolioOverLimit", {
                                        limit: String(
                                            portfolioPreview.data.limit,
                                        ),
                                    })}
                                </p>
                            )}
                        </div>
                    )}

                {hasResidual && (
                    <div className="space-y-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-3 text-xs">
                        <div className="flex items-start gap-2 text-warning">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>
                                {t("accounts.close.residual", {
                                    balance: residualLabel,
                                })}
                            </span>
                        </div>
                        <label className="flex cursor-pointer items-start gap-2 text-foreground">
                            <Checkbox
                                checked={zeroOut}
                                onCheckedChange={(checked) =>
                                    setZeroOut(checked === true)
                                }
                                aria-label={t("accounts.close.zeroOut")}
                            />
                            <span>
                                <span className="font-medium">
                                    {t("accounts.close.zeroOut")}
                                </span>
                                <span className="mt-0.5 block text-muted-foreground">
                                    {t("accounts.close.zeroOutHint")}
                                </span>
                            </span>
                        </label>
                    </div>
                )}

                <DialogFooter className="pt-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button
                        disabled={close.isPending || retagUnavailable}
                        onClick={() => close.mutate()}
                    >
                        {close.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-1" />
                        ) : (
                            <DoorClosed className="h-4 w-4 mr-1" />
                        )}
                        {t("accounts.close.confirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
