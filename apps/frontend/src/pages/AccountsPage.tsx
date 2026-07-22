import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Landmark, MoreVertical, Pencil, Archive, ArchiveRestore, Trash2, GitMerge, DoorClosed, Receipt, Coins, ChevronRight } from "lucide-react";
import { useAccounts, useUpdateAccount, useDeleteAccount } from "@/hooks/useAccounts";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBalanceProvenance } from "@/features/accounts/balanceProvenance";
import {
    groupAccounts, sumConvertedBalances, computeNetCash, isPortfolioType,
    type AccountGroup,
} from "@/features/accounts/groupAccounts";
import { AddAccountDialog, type AccountFormValues } from "@/features/accounts/AddAccountDialog";
import { toAccountPayload, accountToFormValues } from "@/features/accounts/accountFormMapping";
import { MergeAccountDialog } from "@/features/accounts/MergeAccountDialog";
import { CloseAccountDialog } from "@/features/accounts/CloseAccountDialog";
import { OpeningBalanceDialog } from "@/features/accounts/OpeningBalanceDialog";
import { ReconcileDialog } from "@/features/accounts/ReconcileDialog";
import { AccountDetailSheet } from "@/features/accounts/AccountDetailSheet";
import { useLanguage } from "@/contexts/LanguageContext";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { toast } from "sonner";
import type { Account } from "@/types/api";

export default function AccountsPage() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    // Archived is a (collapsed) group now, not a toggle (WP-B3) — always fetch
    // the full population.
    const { data, isLoading, isError, error } = useAccounts({ active: "all" });
    const updateMutation = useUpdateAccount();
    const deleteMutation = useDeleteAccount();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const fmtCur = useCurrencyFormatter();
    const balanceProvenance = useBalanceProvenance();
    const { appSettings } = useAppSettings();
    const displayCurrency = appSettings.defaultCurrency || "EUR";
    const { convertToTarget } = useCurrencyConverter(displayCurrency);
    const [archivedOpen, setArchivedOpen] = useState(false);

    const requestDelete = async (a: Account) => {
        const ok = await confirm({
            title: t('accounts.delete.title'),
            description: t('accounts.delete.description', { name: a.display_name || a.name }),
            confirmLabel: t('common.delete'),
            variant: 'destructive',
        });
        if (!ok) return;
        deleteMutation.mutate(a.id, {
            onError: (error) => {
                // Still referenced (409): route to the close flow instead of
                // dead-ending (lifecycle D5, ADR-088 addendum).
                if ((error as { status?: number }).status === 409) {
                    toast.info(t('accounts.delete.stillReferenced', { name: a.display_name || a.name }));
                    setClosing(a);
                }
            },
        });
    };

    const [editing, setEditing] = useState<Account | undefined>(undefined);
    const [merging, setMerging] = useState<Account | undefined>(undefined);
    const [closing, setClosing] = useState<Account | undefined>(undefined);
    const [anchoring, setAnchoring] = useState<Account | undefined>(undefined);
    const [reconciling, setReconciling] = useState<Account | undefined>(undefined);
    const [detailing, setDetailing] = useState<Account | undefined>(undefined);

    const accounts = useMemo(() => data?.items ?? [], [data]);

    // Deterministic grouped structure (WP-B3): Cash & Savings · Portfolio
    // accounts · Liabilities · Archived (collapsed), label-sorted per group.
    const groups = useMemo(() => groupAccounts(accounts), [accounts]);
    const visibleGroups = useMemo(() => groups.filter((g) => g.id !== "archived"), [groups]);
    const archivedGroup = useMemo(() => groups.find((g) => g.id === "archived"), [groups]);
    // Grand line: WP-A1's Liquid + Liabilities population (in_net_worth only,
    // active, portfolio-type ledger balances excluded until WP-C5).
    const netCash = useMemo(
        () => computeNetCash(accounts, convertToTarget),
        [accounts, convertToTarget],
    );

    // Deep link from the dashboard BankBalancesWidget (?account=<id>): open the
    // shared AccountDetailSheet for that entity, then strip the param so closing
    // + reopening works and a refresh doesn't re-trigger it. One concept, one
    // detail code path (Accounts-rewrite Phase D).
    const detailParam = searchParams.get("account");
    useEffect(() => {
        if (!detailParam) return;
        const match = accounts.find((a) => String(a.id) === detailParam);
        if (!match) return;
        setDetailing(match);
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.delete("account");
                return next;
            },
            { replace: true },
        );
    }, [detailParam, accounts, setSearchParams]);

    const handleSave = (values: AccountFormValues) => {
        if (!editing) return;
        updateMutation.mutate(
            // "update" mode PATCHes emptied fields as explicit null so the
            // backend clears them — see toAccountPayload.
            { id: editing.id, data: toAccountPayload(values, "update") },
            { onSuccess: () => setEditing(undefined) },
        );
    };

    const toggleArchive = (a: Account) =>
        updateMutation.mutate({ id: a.id, data: { is_active: !a.is_active } });

    // Filter by the account entity's id (ADR-088) — reads key on the FK, not
    // the retiring bank_account string.
    const openAccountTransactions = (a: Account) => {
        const params = new URLSearchParams({
            account_id: String(a.id),
            filter_label: a.display_name || a.name,
        });
        navigate(`/transactions?${params.toString()}`);
    };

    const renderAccountCard = (a: Account) => {
        // Portfolio accounts (brokerage/crypto/pension) keep their activity in
        // portfolio_transactions, not the ledger — only offer "view transactions"
        // when there actually are ledger rows to show.
        const canViewTransactions = a.has_transactions !== false;
        // Provenance subline (WP-B2): where the computed balance comes
        // from — stamped statement anchor + entries since, or plain sum.
        const provenanceText = balanceProvenance(a);
        // Portfolio-type cards have no real cash value until WP-C5's holdings
        // land — a "€0,00" computed ledger balance is misleading, so show a
        // placeholder instead (§3 F8).
        const portfolioPlaceholder = isPortfolioType(a.type);
        return (
        <Tooltip key={a.id}>
        <TooltipTrigger asChild>
        <Card
            role="button"
            tabIndex={0}
            aria-label={t('accounts.openDetail', { name: a.display_name || a.name })}
            className={cn("glass-regular cursor-pointer transition-shadow hover:shadow-glass-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2", !a.is_active && "opacity-60")}
            onClick={() => setDetailing(a)}
            onKeyDown={(e) => {
                // Only act on the card itself — keyboard activation of
                // inner controls (actions menu, drift badge) must not
                // also open the detail sheet.
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetailing(a);
                }
            }}
        >
            <CardContent className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="truncate font-semibold tracking-tight">
                            {a.display_name || a.name}
                        </span>
                        {!a.is_active && (
                            <Badge variant="outline" className="text-xs">{t('accounts.archived')}</Badge>
                        )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge variant="secondary" className="text-xs">{t(`accounts.type.${a.type}`)}</Badge>
                        {!a.in_net_worth && (
                            <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                                {t('accounts.notInNetWorth')}
                            </Badge>
                        )}
                        <span>{a.currency}</span>
                        {a.institution && <span>· {a.institution}</span>}
                        {a.drift != null && a.drift !== 0 && (
                            // Clicking the drift badge opens the reconcile dialog
                            // (statement vs computed + delta → accept / adjust).
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        // Kept as a template literal: badgeVariants sets text-[11px] and the
                                        // appended text-xs deliberately overrides it; cn()'s tailwind-merge
                                        // would resolve the font-size differently, so preserve the raw join.
                                        className={`${badgeVariants({ variant: "destructive" })} cursor-pointer text-xs`}
                                        aria-label={t('accounts.reconcile.open')}
                                        onClick={(e) => { e.stopPropagation(); setReconciling(a); }}
                                    >
                                        {t('accounts.drift')}: {a.drift > 0 ? "+" : ""}{fmtCur(a.drift, a.currency)}
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>{t('accounts.driftTooltip')}</TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                    {portfolioPlaceholder ? (
                        <div className="mt-2 text-sm font-medium text-muted-foreground">
                            {t('accounts.trackedInPortfolio')}
                        </div>
                    ) : (
                        <>
                            {a.computed_balance != null && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div className="mt-2 text-lg font-semibold tabular-nums">
                                            {fmtCur(a.computed_balance, a.currency)}
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent>{t('accounts.balanceTooltip')}</TooltipContent>
                                </Tooltip>
                            )}
                            {a.computed_balance != null && provenanceText && (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                    {provenanceText}
                                </div>
                            )}
                        </>
                    )}
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            aria-label={t('accounts.actionsMenu')}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        {/* Keyboard/touch-accessible equivalent of the card's
                            double-click-to-open shortcut. */}
                        {canViewTransactions && (
                            <DropdownMenuItem onClick={() => openAccountTransactions(a)}>
                                <Receipt className="mr-2 h-4 w-4" /> {t('accounts.openTransactions')}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => setEditing(a)}>
                            <Pencil className="mr-2 h-4 w-4" /> {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setAnchoring(a)}>
                            <Coins className="mr-2 h-4 w-4" /> {t('accounts.openingBalance.action')}
                        </DropdownMenuItem>
                        {accounts.length > 1 && (
                            <DropdownMenuItem onClick={() => setMerging(a)}>
                                <GitMerge className="mr-2 h-4 w-4" /> {t('accounts.merge')}
                            </DropdownMenuItem>
                        )}
                        {a.is_active && (
                            <DropdownMenuItem onClick={() => setClosing(a)}>
                                <DoorClosed className="mr-2 h-4 w-4" /> {t('accounts.close.action')}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => toggleArchive(a)}>
                            {a.is_active
                                ? <><Archive className="mr-2 h-4 w-4" /> {t('accounts.archive')}</>
                                : <><ArchiveRestore className="mr-2 h-4 w-4" /> {t('accounts.restore')}</>}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => requestDelete(a)}
                        >
                            <Trash2 className="mr-2 h-4 w-4" /> {t('common.delete')}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </CardContent>
        </Card>
        </TooltipTrigger>
        <TooltipContent>{t('accounts.openDetailHint')}</TooltipContent>
        </Tooltip>
        );
    };

    // Group header: label left, converted subtotal right — mirrors the muted
    // section-header idiom used elsewhere; cards themselves are untouched.
    const renderGroupSubtotal = (group: AccountGroup) => (
        <p className="text-xs text-muted-foreground">
            {t('accounts.group.subtotal')}{" "}
            <span className="font-semibold tabular-nums text-foreground">
                {fmtCur(sumConvertedBalances(group.accounts, convertToTarget), displayCurrency)}
            </span>
        </p>
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('accounts.title')}
                description={t('accounts.subtitle')}
                icon={Landmark}
                actions={<AddAccountDialog />}
            />

            {isLoading && (
                <SectionLoader />
            )}

            {isError && (
                <p className="text-sm text-destructive">{(error as Error)?.message}</p>
            )}

            {!isLoading && !isError && accounts.length === 0 && (
                <EmptyState
                    icon={Landmark}
                    title={t('accounts.emptyTitle')}
                    description={t('accounts.emptyDescription')}
                    action={<AddAccountDialog />}
                />
            )}

            {accounts.length > 0 && (
                <div className="space-y-6">
                    {visibleGroups.map((group) => (
                        <section key={group.id} aria-label={t(`accounts.group.${group.id}`)} className="space-y-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <h2 className="text-sm font-semibold tracking-tight">
                                    {t(`accounts.group.${group.id}`)}
                                </h2>
                                {renderGroupSubtotal(group)}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {group.accounts.map(renderAccountCard)}
                            </div>
                        </section>
                    ))}

                    {/* Grand line: Net cash = Cash & Savings + Liabilities over
                        in_net_worth accounts only — the same population WP-A1's
                        net-worth Liquid + Liabilities figures sum over. */}
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border/60 pt-4">
                        <div>
                            <h2 className="text-sm font-semibold tracking-tight">{t('accounts.netCash')}</h2>
                            <p className="text-xs text-muted-foreground">{t('accounts.netCashHint')}</p>
                        </div>
                        <span className="text-lg font-semibold tabular-nums">
                            {fmtCur(netCash, displayCurrency)}
                        </span>
                    </div>

                    {archivedGroup && (
                        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
                            <section aria-label={t('accounts.group.archived')} className="space-y-3">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                    <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted-foreground transition-colors hover:text-foreground">
                                        <ChevronRight className={cn("h-4 w-4 transition-transform", archivedOpen && "rotate-90")} />
                                        {t('accounts.group.archived')}
                                        <span className="font-normal">({archivedGroup.accounts.length})</span>
                                    </CollapsibleTrigger>
                                    {renderGroupSubtotal(archivedGroup)}
                                </div>
                                <CollapsibleContent>
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                        {archivedGroup.accounts.map(renderAccountCard)}
                                    </div>
                                </CollapsibleContent>
                            </section>
                        </Collapsible>
                    )}
                </div>
            )}

            {editing && (
                <AddAccountDialog
                    key={editing.id}
                    mode="edit"
                    open={!!editing}
                    onOpenChange={(o) => { if (!o) setEditing(undefined); }}
                    isSaving={updateMutation.isPending}
                    initialValues={accountToFormValues(editing)}
                    onSave={handleSave}
                />
            )}

            {merging && (
                <MergeAccountDialog
                    source={merging}
                    accounts={accounts}
                    open={!!merging}
                    onOpenChange={(o) => { if (!o) setMerging(undefined); }}
                />
            )}

            {closing && (
                <CloseAccountDialog
                    account={closing}
                    accounts={accounts}
                    open={!!closing}
                    onOpenChange={(o) => { if (!o) setClosing(undefined); }}
                />
            )}

            {anchoring && (
                <OpeningBalanceDialog
                    key={anchoring.id}
                    account={anchoring}
                    open={!!anchoring}
                    onOpenChange={(o) => { if (!o) setAnchoring(undefined); }}
                />
            )}

            {reconciling && (
                <ReconcileDialog
                    key={reconciling.id}
                    account={reconciling}
                    open={!!reconciling}
                    onOpenChange={(o) => { if (!o) setReconciling(undefined); }}
                />
            )}

            <AccountDetailSheet
                account={detailing}
                open={!!detailing}
                onOpenChange={(o) => { if (!o) setDetailing(undefined); }}
                onEdit={(a) => { setDetailing(undefined); setEditing(a); }}
                onReconcile={(a) => { setDetailing(undefined); setReconciling(a); }}
                onOpeningBalance={(a) => { setDetailing(undefined); setAnchoring(a); }}
                onViewTransactions={(a) => { setDetailing(undefined); openAccountTransactions(a); }}
            />

            <ConfirmDialog />
        </div>
    );
}
