import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Landmark, MoreVertical, Pencil, Archive, ArchiveRestore, Trash2, GitMerge, DoorClosed, Receipt, Coins } from "lucide-react";
import { useAccounts, useUpdateAccount, useDeleteAccount } from "@/hooks/useAccounts";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { AddAccountDialog, type AccountFormValues } from "@/features/accounts/AddAccountDialog";
import { MergeAccountDialog } from "@/features/accounts/MergeAccountDialog";
import { CloseAccountDialog } from "@/features/accounts/CloseAccountDialog";
import { OpeningBalanceDialog } from "@/features/accounts/OpeningBalanceDialog";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useLanguage } from "@/contexts/LanguageContext";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { toast } from "sonner";
import type { Account } from "@/types/api";

export default function AccountsPage() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [showArchived, setShowArchived] = useState(false);
    const { data, isLoading, isError, error } = useAccounts({ active: showArchived ? "all" : "true" });
    const updateMutation = useUpdateAccount();
    const deleteMutation = useDeleteAccount();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const fmtCur = useCurrencyFormatter();

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
    const { summaries } = usePortfolio();

    const accounts = useMemo(() => data?.items ?? [], [data]);

    const handleSave = (values: AccountFormValues) => {
        if (!editing) return;
        updateMutation.mutate(
            {
                id: editing.id,
                data: {
                    name: values.name,
                    // Emptied fields PATCH as explicit null so the backend clears
                    // them — `undefined` keys are dropped in JSON and would no-op.
                    display_name: values.display_name || null,
                    institution: values.institution || null,
                    currency: values.currency,
                    type: values.type,
                    owner: values.owner,
                    liquidity_class: values.liquidity_class,
                    tax_wrapper: values.tax_wrapper,
                    spendable: values.spendable,
                    in_net_worth: values.in_net_worth,
                    multi_currency_cash: values.multi_currency_cash,
                    has_cash_sleeve: values.has_cash_sleeve,
                    statement_balance: values.statementBalance ? Number(values.statementBalance) : null,
                    statement_balance_date: values.statementBalanceDate || null,
                },
            },
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

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('accounts.title')}
                description={t('accounts.subtitle')}
                icon={Landmark}
                actions={
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setShowArchived(v => !v)}>
                            {showArchived ? t('accounts.hideArchived') : t('accounts.showArchived')}
                        </Button>
                        <AddAccountDialog />
                    </div>
                }
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
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {accounts.map((a) => {
                        // Portfolio accounts (brokerage/crypto/pension) keep their activity in
                        // portfolio_transactions, not the ledger — only offer "view transactions"
                        // when there actually are ledger rows to show.
                        const canViewTransactions = a.has_transactions !== false;
                        return (
                        <Card
                            key={a.id}
                            className={`glass-regular transition-shadow ${a.is_active ? "" : "opacity-60"} ${canViewTransactions ? "cursor-pointer hover:shadow-glass-soft" : ""}`}
                            onDoubleClick={canViewTransactions ? () => openAccountTransactions(a) : undefined}
                            title={canViewTransactions ? t('accounts.openTransactions') : undefined}
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
                                        <span>{a.currency}</span>
                                        {a.institution && <span>· {a.institution}</span>}
                                        {a.drift != null && a.drift !== 0 && (
                                            <Badge
                                                variant="destructive"
                                                className="text-xs"
                                                title={t('accounts.driftTooltip')}
                                            >
                                                {t('accounts.drift')}: {a.drift > 0 ? "+" : ""}{fmtCur(a.drift, a.currency)}
                                            </Badge>
                                        )}
                                    </div>
                                    {a.computed_balance != null && (
                                        <div
                                            className="mt-2 text-lg font-semibold tabular-nums"
                                            title={t('accounts.balanceTooltip')}
                                        >
                                            {fmtCur(a.computed_balance, a.currency)}
                                        </div>
                                    )}
                                </div>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 shrink-0"
                                            onDoubleClick={(e) => e.stopPropagation()}
                                        >
                                            <MoreVertical className="h-4 w-4" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
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
                        );
                    })}
                </div>
            )}

            {editing && (
                <AddAccountDialog
                    key={editing.id}
                    mode="edit"
                    open={!!editing}
                    onOpenChange={(o) => { if (!o) setEditing(undefined); }}
                    isSaving={updateMutation.isPending}
                    initialValues={{
                        name: editing.name,
                        display_name: editing.display_name ?? "",
                        institution: editing.institution ?? "",
                        currency: editing.currency,
                        type: editing.type,
                        owner: editing.owner,
                        liquidity_class: editing.liquidity_class,
                        tax_wrapper: editing.tax_wrapper,
                        spendable: editing.spendable,
                        in_net_worth: editing.in_net_worth,
                        multi_currency_cash: editing.multi_currency_cash,
                        has_cash_sleeve: editing.has_cash_sleeve,
                        statementBalance: editing.statement_balance != null ? String(editing.statement_balance) : "",
                        // The API serialises the DATE as a full ISO timestamp; the
                        // <input type="date"> and the server both want YYYY-MM-DD.
                        statementBalanceDate: editing.statement_balance_date ? editing.statement_balance_date.slice(0, 10) : "",
                    }}
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
                    summaries={summaries}
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

            <ConfirmDialog />
        </div>
    );
}
