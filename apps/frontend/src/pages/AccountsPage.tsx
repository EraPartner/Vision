import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Landmark, MoreVertical, Pencil, Archive, ArchiveRestore, Trash2, Loader2, GitMerge, DoorClosed } from "lucide-react";
import { useAccounts, useUpdateAccount, useDeleteAccount } from "@/hooks/useAccounts";
import { AddAccountDialog, type AccountFormValues } from "@/features/accounts/AddAccountDialog";
import { MergeAccountDialog } from "@/features/accounts/MergeAccountDialog";
import { CloseAccountDialog } from "@/features/accounts/CloseAccountDialog";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useLanguage } from "@/contexts/LanguageContext";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import type { Account } from "@/types/api";

export default function AccountsPage() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [showArchived, setShowArchived] = useState(false);
    const { data, isLoading, isError, error } = useAccounts({ active: showArchived ? "all" : "true" });
    const updateMutation = useUpdateAccount();
    const deleteMutation = useDeleteAccount();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const requestDelete = async (a: Account) => {
        const ok = await confirm({
            title: t('accounts.delete.title'),
            description: t('accounts.delete.description', { name: a.display_name || a.name }),
            confirmLabel: t('common.delete'),
            variant: 'destructive',
        });
        if (ok) deleteMutation.mutate(a.id);
    };

    const [editing, setEditing] = useState<Account | undefined>(undefined);
    const [merging, setMerging] = useState<Account | undefined>(undefined);
    const [closing, setClosing] = useState<Account | undefined>(undefined);
    const { summaries } = usePortfolio();

    const accounts = useMemo(() => data?.items ?? [], [data]);

    const handleSave = (values: AccountFormValues) => {
        if (!editing) return;
        updateMutation.mutate(
            {
                id: editing.id,
                data: {
                    name: values.name,
                    display_name: values.display_name || undefined,
                    institution: values.institution || undefined,
                    currency: values.currency,
                    type: values.type,
                    owner: values.owner,
                    liquidity_class: values.liquidity_class,
                    tax_wrapper: values.tax_wrapper,
                    spendable: values.spendable,
                    in_net_worth: values.in_net_worth,
                    multi_currency_cash: values.multi_currency_cash,
                    has_cash_sleeve: values.has_cash_sleeve,
                    statement_balance: values.statementBalance ? Number(values.statementBalance) : undefined,
                    statement_balance_date: values.statementBalanceDate || undefined,
                },
            },
            { onSuccess: () => setEditing(undefined) },
        );
    };

    const toggleArchive = (a: Account) =>
        updateMutation.mutate({ id: a.id, data: { is_active: !a.is_active } });

    // The dual-write trigger (migration 0051) keeps `transactions.bank_account`
    // equal to `accounts.name`, so the account name is the transaction filter key.
    const openAccountTransactions = (a: Account) => {
        const params = new URLSearchParams({
            bank_account: a.name,
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
                <div className="flex justify-center py-16 text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" />
                </div>
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
                    {accounts.map((a) => (
                        <Card
                            key={a.id}
                            className={`glass-regular cursor-pointer transition-shadow hover:shadow-md ${a.is_active ? "" : "opacity-60"}`}
                            onDoubleClick={() => openAccountTransactions(a)}
                            title={t('accounts.openTransactions')}
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
                                            <Badge variant="destructive" className="text-xs">
                                                {t('accounts.drift')}: {a.drift.toFixed(2)}
                                            </Badge>
                                        )}
                                    </div>
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
                                        <DropdownMenuItem onClick={() => setEditing(a)}>
                                            <Pencil className="mr-2 h-4 w-4" /> {t('common.edit')}
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
                    ))}
                </div>
            )}

            {editing && (
                <AddAccountDialog
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

            <ConfirmDialog />
        </div>
    );
}
