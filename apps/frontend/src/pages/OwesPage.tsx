import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from '@/contexts/LanguageContext';
import { useOwedSummary, useOwedByRecipient, useRecordPayment, useSettleSplit, useDeleteSplit, useSettleAllSplitsByRecipient } from "@/hooks/useSplits";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { ArrowLeft, Check, DollarSign, Trash2, Users } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import type { Transaction } from "@/types/api";
import { toast } from "sonner";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";

export default function OwesPage() {
    const { data: summary, isLoading } = useOwedSummary();
    const [selectedRecipient, setSelectedRecipient] = useState<{ id: number; name: string } | null>(null);

    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    if (isLoading) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">{t('owesPage.title')}</h2>
                    <p className="text-muted-foreground mt-1">{t('owesPage.subtitle')}</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-32" />
                    ))}
                </div>
            </div>
        );
    }

    const items = summary?.items || [];
    const totalOwed = items.reduce((s, i) => s + i.remaining, 0);

    if (selectedRecipient) {
        return <RecipientOwesDetail recipient={selectedRecipient} onBack={() => setSelectedRecipient(null)} />;
    }

    return (
        <div className="space-y-8 animate-in">
            <div>
                <h2 className="text-3xl font-bold text-foreground">{t('owesPage.title')}</h2>
                <p className="text-muted-foreground mt-1">{t('owesPage.subtitle')}</p>
            </div>

            {totalOwed > 0 && (
                <Card className="bg-primary/5 border-primary/20">
                    <CardContent className="pt-6">
                        <div className="text-center">
                            <p className="text-sm text-muted-foreground">{t('owesPage.totalOutstanding')}</p>
                            <p className="text-3xl font-bold text-primary mt-1">
                                {formatCurrency(totalOwed, defaultCurrency, locale)}
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                                {items.length === 1 ? t('owesPage.fromPerson', { n: items.length }) : t('owesPage.fromPeople', { n: items.length })}
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {items.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <Users className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground mb-1">{t('owesPage.noDebts')}</p>
                        <p className="text-xs text-muted-foreground">
                            {t('owesPage.splitToTrack')}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => {
                        const progress = item.total_owed > 0 ? (item.total_paid / item.total_owed) * 100 : 0;
                        return (
                            <Card
                                key={item.recipient_id}
                                className="cursor-pointer hover:border-primary/40 transition-colors"
                                onClick={() => setSelectedRecipient({ id: item.recipient_id, name: item.recipient_name })}
                            >
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base flex items-center justify-between">
                                        <span>{item.recipient_name}</span>
                                        <Badge variant="secondary">
                                            {item.split_count === 1 ? t('owesPage.split', { n: item.split_count }) : t('owesPage.splits', { n: item.split_count })}
                                        </Badge>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">{t('owesPage.remaining')}</span>
                                        <span className="font-semibold text-primary">
                                            {formatCurrency(item.remaining, defaultCurrency, locale)}
                                        </span>
                                    </div>
                                    <Progress value={progress} className="h-2" />
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>{t('owesPage.paid', { amount: formatCurrency(item.total_paid, defaultCurrency, locale) })}</span>
                                        <span>{t('owesPage.totalLabel', { amount: formatCurrency(item.total_owed, defaultCurrency, locale) })}</span>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function RecipientOwesDetail({ recipient, onBack }: { recipient: { id: number; name: string }; onBack: () => void }) {
    const navigate = useNavigate();
    const { data, isLoading } = useOwedByRecipient(recipient.id);
    const recordPayment = useRecordPayment();
    const settleSplit = useSettleSplit();
    const settleAllSplitsByRecipient = useSettleAllSplitsByRecipient();
    const deleteSplit = useDeleteSplit();
    const [payDialog, setPayDialog] = useState<{ splitId: number; remaining: number } | null>(null);
    const [payAmount, setPayAmount] = useState("");
    const [isExportingCsv, setIsExportingCsv] = useState(false);
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const items = data?.items || [];
    const totalOutstanding = items.reduce((sum, split) => sum + split.remaining, 0);

    const handlePay = () => {
        if (!payDialog) return;
        const amount = parseFloat(payAmount);
        if (!amount || amount <= 0) return;
        recordPayment.mutate(
            { splitId: payDialog.splitId, amount },
            { onSuccess: () => { setPayDialog(null); setPayAmount(""); } }
        );
    };

    const handleSettleAll = async () => {
        if (!items.length) return;
        const shouldSettle = await confirm({
            title: t('owesPage.settleAll.confirmTitle'),
            description: t('owesPage.settleAll.confirmDescription', {
                count: items.length,
                amount: formatCurrency(totalOutstanding, defaultCurrency, locale),
            }),
            confirmLabel: t('owesPage.settleAll.confirmAction'),
            cancelLabel: t('common.cancel'),
        });
        if (!shouldSettle) return;
        settleAllSplitsByRecipient.mutate(recipient.id);
    };

    const handleExportCsv = async () => {
        if (!items.length || isExportingCsv) return;
        setIsExportingCsv(true);
        try {
            const blob = await apiClient.exportOwedByRecipientCsv(recipient.id);
            const downloadUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = downloadUrl;
            link.download = `owed_${recipient.name.replace(/\s+/g, '_').toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`;
            link.click();
            URL.revokeObjectURL(downloadUrl);
            toast.success(t('owesPage.export.success'));
        } catch (error) {
            const message = error instanceof Error ? error.message : t('owesPage.export.failed');
            toast.error(t('owesPage.export.failed'), { description: message });
        } finally {
            setIsExportingCsv(false);
        }
    };

    return (
        <div className="space-y-6 animate-in">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={onBack}>
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div>
                        <h2 className="text-2xl font-bold text-foreground">{recipient.name}</h2>
                        <p className="text-muted-foreground text-sm">{t('owesPage.outstandingSplits')}</p>
                    </div>
                </div>
                <Button
                    variant="outline"
                    onClick={handleSettleAll}
                    disabled={!items.length || settleAllSplitsByRecipient.isPending}
                >
                    {settleAllSplitsByRecipient.isPending ? t('owesPage.settleAll.loading') : t('owesPage.settleAll.button')}
                </Button>
                <Button
                    variant="outline"
                    onClick={handleExportCsv}
                    disabled={!items.length || isExportingCsv}
                >
                    {isExportingCsv ? t('owesPage.export.loading') : t('owesPage.export.button')}
                </Button>
            </div>

            {isLoading ? (
                <div className="space-y-3">
                    {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24" />)}
                </div>
            ) : items.length === 0 ? (
                <Card>
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">{t('owesPage.allSettled')}</p>
                    </CardContent>
                </Card>
            ) : (
                <>
                    <div className="space-y-3">
                        {items.map((split) => {
                            const progress = split.amount > 0 ? (split.amount_paid / split.amount) * 100 : 0;
                            const splitTitle = [split.transaction_recipient_name, split.transaction_memo]
                                .filter(Boolean)
                                .join(' - ') || t('owesPage.transaction');
                            return (
                                <Card
                                    key={split.id}
                                    onDoubleClick={(e) => {
                                        const target = e.target as HTMLElement;
                                        if (target.closest('button')) return;
                                        navigate(`/transactions?transaction_id=${split.transaction_id}&filter_label=${encodeURIComponent(splitTitle)}`);
                                    }}
                                >
                                    <CardContent className="py-4">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex-1 space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium text-foreground">
                                                        {splitTitle}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatDateStringWithAppSettings(split.transaction_date, appSettings.dateFormat)}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-muted-foreground">
                                                    {t('owesPage.original', { amount: formatCurrency(Math.abs(split.transaction_amount), split.transaction_currency || defaultCurrency, locale) })}
                                                    {split.note && ` · ${split.note}`}
                                                </p>
                                                <div className="flex items-center gap-3 mt-2">
                                                    <Progress value={progress} className="h-1.5 flex-1" />
                                                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                                                        {formatCurrency(split.amount_paid, defaultCurrency, locale)} / {formatCurrency(split.amount, defaultCurrency, locale)}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <span className="text-sm font-semibold text-primary mr-2">
                                                    {formatCurrency(split.remaining, defaultCurrency, locale)}
                                                </span>
                                                <Button
                                                    variant="ghost" size="icon" className="h-8 w-8 text-accent hover:text-accent"
                                                    title={t('owesPage.recordPayment')}
                                                    onClick={() => { setPayDialog({ splitId: split.id, remaining: split.remaining }); setPayAmount(String(split.remaining)); }}
                                                >
                                                    <DollarSign className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-accent"
                                                    title={t('owesPage.markSettled')}
                                                    onClick={() => settleSplit.mutate(split.id)}
                                                >
                                                    <Check className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                    title={t('owesPage.deleteSplit')}
                                                    onClick={() => deleteSplit.mutate(split.id)}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                    <RecentRecipientTransactionsTable recipientId={recipient.id} recipientName={recipient.name} />
                </>
            )}

            {/* Payment dialog */}
            <Dialog open={!!payDialog} onOpenChange={() => setPayDialog(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{t('owesPage.recordDialog.title')}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div>
                            <label className="text-sm text-muted-foreground">{t('owesPage.recordDialog.amount')}</label>
                            <Input
                                type="number"
                                step="0.01"
                                value={payAmount}
                                onChange={(e) => setPayAmount(e.target.value)}
                                placeholder={t('owesPage.recordDialog.placeholder')}
                            />
                            {payDialog && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    {t('owesPage.recordDialog.remaining', { amount: formatCurrency(payDialog.remaining, defaultCurrency, locale) })}
                                </p>
                            )}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPayDialog(null)}>{t('owesPage.recordDialog.cancel')}</Button>
                        <Button onClick={handlePay} disabled={recordPayment.isPending}>
                            {recordPayment.isPending ? t('owesPage.recordDialog.recording') : t('owesPage.recordDialog.submit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <ConfirmDialog />
        </div>
    );
}

type RecentRecipientTransactionRow = {
    id: number;
    date: string;
    description: string;
    category: string;
    amount: number;
    currency: string;
    bankAccount: string;
};

function RecentRecipientTransactionsTable({ recipientId, recipientName }: { recipientId: number; recipientName: string }) {
    const navigate = useNavigate();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const [allItems, setAllItems] = useState<Transaction[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);

    const { data, isLoading } = useQuery({
        queryKey: ['transactions', 'owes-recipient', recipientId],
        queryFn: () => apiClient.getTransactions({
            recipient_id: recipientId,
            limit: 10,
            offset: 0,
            sort_by: 'transaction_date',
            sort_dir: 'desc',
        }),
        staleTime: 30_000,
    });

    useEffect(() => {
        if (!data) return;
        setAllItems(data.items);
        setTotalItems(data.total ?? data.items.length);
        offsetRef.current = data.items.length;
        hasMoreRef.current = data.items.length < (data.total ?? data.items.length);
    }, [data]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        setIsFetchingMore(true);
        try {
            const result = await apiClient.getTransactions({
                recipient_id: recipientId,
                limit: 10,
                offset: offsetRef.current,
                sort_by: 'transaction_date',
            sort_dir: 'desc',
        });

            setAllItems((prev) => {
                const existingIds = new Set(prev.map((item) => item.id));
                const newItems = result.items.filter((item) => !existingIds.has(item.id));
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [recipientId]);

    const transactions: RecentRecipientTransactionRow[] = allItems.map((tx) => ({
        id: tx.id,
        date: tx.transaction_date || tx.date || '',
        description: tx.memo || t('owesPage.transaction'),
        category: tx.category_name || t('txPage.field.uncategorized'),
        amount: tx.amount,
        currency: tx.currency || appSettings.defaultCurrency,
        bankAccount: tx.bank_account || '—',
    }));

    const columns = [
        {
            key: 'date',
            header: t('txPage.col.date'),
            defaultWidth: 120,
            minWidth: 100,
            render: (row: RecentRecipientTransactionRow) => (
                <span className="whitespace-nowrap">{row.date ? formatDateStringWithAppSettings(row.date, appSettings.dateFormat) : '—'}</span>
            ),
        },
        {
            key: 'description',
            header: t('txPage.field.description'),
            minWidth: 180,
        },
        {
            key: 'category',
            header: t('txPage.col.category'),
            minWidth: 180,
        },
        {
            key: 'amount',
            header: t('txPage.col.amount'),
            defaultWidth: 120,
            minWidth: 100,
            render: (row: RecentRecipientTransactionRow) => (
                <span className={`font-mono whitespace-nowrap ${row.amount >= 0 ? 'text-accent' : 'text-destructive'}`}>
                    {row.amount >= 0 ? '+' : '-'}{formatCurrency(Math.abs(row.amount), row.currency, locale)}
                </span>
            ),
        },
        {
            key: 'bankAccount',
            header: t('txPage.field.bankAccount'),
            minWidth: 160,
        },
    ];

    if (isLoading) {
        return <Skeleton className="h-[320px]" />;
    }

    return (
        <VirtualDataTable
            title={t('owesPage.recentTransactionsTitle')}
            subtitle={t('owesPage.recentTransactionsSubtitle', { name: recipientName })}
            columns={columns}
            data={transactions}
            totalItems={totalItems}
            isFetchingMore={isFetchingMore}
            onLoadMore={loadMore}
            hasMore={hasMoreRef.current}
            maxHeight={320}
            rowHeight={42}
            emptyMessage={t('owesPage.noRecentTransactions')}
            onRowDoubleClick={(row: RecentRecipientTransactionRow) => {
                navigate(`/transactions?transaction_id=${row.id}&filter_label=${encodeURIComponent(row.description)}`);
            }}
        />
    );
}
