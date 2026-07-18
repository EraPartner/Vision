import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
    Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sparkline } from "@/components/charts";
import { Pencil, Coins, Receipt, Scale, Lock } from "lucide-react";
import { apiClient } from "@/lib/api";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { useLanguage } from "@/contexts/LanguageContext";
import { isPerAccountHoldingsEnabled } from "@/lib/env";
import type { Account } from "@/types/api";
import { cn } from "@/lib/utils";

// The running-balance series lives on the transaction rows themselves, so the
// sparkline is drawn "from existing history" (no new endpoint) — reversed to
// chronological order and filtered to rows that actually carry a balance.
const SPARK_COLOR_POSITIVE = "hsl(var(--gain))";
const SPARK_COLOR_NEGATIVE = "hsl(var(--loss))";
const SPARK_COLOR_NEUTRAL = "hsl(217, 91%, 60%)";

interface AccountDetailSheetProps {
    account: Account | undefined;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onEdit: (a: Account) => void;
    onReconcile: (a: Account) => void;
    onOpeningBalance: (a: Account) => void;
    onViewTransactions: (a: Account) => void;
}

export function AccountDetailSheet({
    account, open, onOpenChange, onEdit, onReconcile, onOpeningBalance, onViewTransactions,
}: AccountDetailSheetProps) {
    const { t } = useLanguage();
    const fmtCur = useCurrencyFormatter();

    const canViewTransactions = account?.has_transactions !== false;

    // Recent ledger rows, newest first — powers both the transactions list and
    // the balance sparkline. Gated on the sheet being open for a ledger-backed
    // account so a closed sheet holds no live query.
    const { data: txData, isLoading: txLoading } = useQuery({
        queryKey: ["transactions", "account-detail", account?.id],
        queryFn: () => apiClient.getTransactions({
            account_id: account!.id,
            limit: 30,
            sort_by: "transaction_date",
            sort_dir: "desc",
        }),
        enabled: open && !!account && canViewTransactions,
        staleTime: 30_000,
    });

    const recentTransactions = useMemo(() => (txData?.items ?? []).slice(0, 6), [txData]);

    // Oldest → newest running balances for the trend line.
    const sparkPoints = useMemo(() => {
        const rows = txData?.items ?? [];
        return rows
            .filter((r) => typeof r.balance === "number")
            .map((r) => r.balance as number)
            .reverse();
    }, [txData]);

    const sparkColor = useMemo(() => {
        if (sparkPoints.length < 2) return SPARK_COLOR_NEUTRAL;
        const delta = sparkPoints[sparkPoints.length - 1] - sparkPoints[0];
        return delta > 0 ? SPARK_COLOR_POSITIVE : delta < 0 ? SPARK_COLOR_NEGATIVE : SPARK_COLOR_NEUTRAL;
    }, [sparkPoints]);

    if (!account) return null;
    const a = account;

    const hasDrift = a.drift != null && a.drift !== 0;

    const metadata: Array<{ label: string; value: string }> = [
        { label: t("accounts.field.type"), value: t(`accounts.type.${a.type}`) },
        { label: t("accounts.field.currency"), value: a.currency },
        { label: t("accounts.field.owner"), value: t(`accounts.owner.${a.owner}`) },
        { label: t("accounts.field.liquidityClass"), value: t(`accounts.liquidity.${a.liquidity_class}`) },
        { label: t("accounts.field.taxWrapper"), value: t(`accounts.taxWrapper.${a.tax_wrapper}`) },
        ...(a.institution ? [{ label: t("accounts.field.institution"), value: a.institution }] : []),
        { label: t("accounts.field.spendable"), value: a.spendable ? t("common.yes") : t("common.no") },
        { label: t("accounts.field.inNetWorth"), value: a.in_net_worth ? t("common.yes") : t("common.no") },
    ];

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
                <SheetHeader className="text-left">
                    <div className="flex items-center gap-2">
                        <SheetTitle className="truncate">{a.display_name || a.name}</SheetTitle>
                        {!a.is_active && (
                            <Badge variant="outline" className="text-xs">{t("accounts.archived")}</Badge>
                        )}
                    </div>
                    <SheetDescription className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="text-xs">{t(`accounts.type.${a.type}`)}</Badge>
                        <span>{a.currency}</span>
                        {a.institution && <span>· {a.institution}</span>}
                    </SheetDescription>
                </SheetHeader>

                {/* Balance + sparkline */}
                <div className="mt-6">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t("accounts.detail.balance")}
                    </div>
                    {a.computed_balance != null ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="mt-1 text-3xl font-semibold tabular-nums">
                                    {fmtCur(a.computed_balance, a.currency)}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent>{t("accounts.balanceTooltip")}</TooltipContent>
                        </Tooltip>
                    ) : (
                        <div className="mt-1 text-sm text-muted-foreground">{t("accounts.detail.noBalance")}</div>
                    )}
                    {sparkPoints.length >= 2 && (
                        <div className="mt-3">
                            <Sparkline
                                data={sparkPoints}
                                height={56}
                                color={sparkColor}
                                fillArea
                                strokeWidth={2}
                                ariaLabel={t("accounts.detail.sparklineAria")}
                            />
                        </div>
                    )}
                </div>

                {/* Drift / reconcile CTA */}
                {hasDrift && (
                    <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/[0.06] p-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-sm font-medium text-destructive">
                                    {t("accounts.drift")}: {a.drift! > 0 ? "+" : ""}{fmtCur(a.drift!, a.currency)}
                                </div>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    {t("accounts.detail.driftHint")}
                                </p>
                            </div>
                            <Button size="sm" variant="outline" className="shrink-0" onClick={() => onReconcile(a)}>
                                <Scale className="mr-2 h-4 w-4" /> {t("accounts.reconcile.open")}
                            </Button>
                        </div>
                    </div>
                )}

                <Separator className="my-6" />

                {/* Recent transactions */}
                <div>
                    <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-semibold tracking-tight">{t("accounts.detail.recentTransactions")}</h3>
                        {canViewTransactions && (
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onViewTransactions(a)}>
                                <Receipt className="mr-1.5 h-3.5 w-3.5" /> {t("accounts.detail.viewAll")}
                            </Button>
                        )}
                    </div>
                    {!canViewTransactions ? (
                        <p className="text-sm text-muted-foreground">{t("accounts.detail.noLedger")}</p>
                    ) : txLoading ? (
                        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                    ) : recentTransactions.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("accounts.detail.noTransactions")}</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {recentTransactions.map((txn) => (
                                <li key={txn.id} className="flex items-center justify-between gap-3 text-sm">
                                    <div className="min-w-0">
                                        <div className="truncate">{txn.recipient_name || txn.memo || t("accounts.detail.unlabelled")}</div>
                                        <div className="text-xs text-muted-foreground tabular-nums">{txn.transaction_date.slice(0, 10)}</div>
                                    </div>
                                    <span className={cn("shrink-0 tabular-nums", txn.amount >= 0 ? "amount-gain" : "amount-loss")}>
                                        {fmtCur(txn.amount, txn.currency || a.currency)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <Separator className="my-6" />

                {/* Holdings — dark until Phase E enables per-account holdings (ADR-103). */}
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <h3 className="text-sm font-semibold tracking-tight">{t("accounts.detail.holdings")}</h3>
                        {!isPerAccountHoldingsEnabled && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
                    </div>
                    {isPerAccountHoldingsEnabled ? (
                        <p className="text-sm text-muted-foreground">{t("accounts.detail.holdingsEmpty")}</p>
                    ) : (
                        <div className="rounded-xl border border-dashed border-border/60 p-4">
                            <p className="text-sm text-muted-foreground">{t("accounts.detail.holdingsDark")}</p>
                        </div>
                    )}
                </div>

                <Separator className="my-6" />

                {/* Metadata */}
                <div>
                    <h3 className="mb-3 text-sm font-semibold tracking-tight">{t("accounts.detail.details")}</h3>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        {metadata.map((m) => (
                            <div key={m.label} className="flex flex-col">
                                <dt className="text-xs uppercase tracking-wide text-muted-foreground">{m.label}</dt>
                                <dd className="tabular-nums">{m.value}</dd>
                            </div>
                        ))}
                    </dl>
                </div>

                {/* Actions */}
                <div className="mt-6 flex flex-wrap gap-2 pb-2">
                    <Button size="sm" variant="outline" onClick={() => onEdit(a)}>
                        <Pencil className="mr-2 h-4 w-4" /> {t("common.edit")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onOpeningBalance(a)}>
                        <Coins className="mr-2 h-4 w-4" /> {t("accounts.openingBalance.action")}
                    </Button>
                    {hasDrift && (
                        <Button size="sm" variant="outline" onClick={() => onReconcile(a)}>
                            <Scale className="mr-2 h-4 w-4" /> {t("accounts.reconcile.open")}
                        </Button>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}
