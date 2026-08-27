import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Check, DollarSign, HandCoins, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/EmptyState";
import { Money } from "@/components/shared/Money";
import { PageHeader } from "@/components/shared/PageHeader";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { RecentRecipientTransactionsTable } from "@/features/splits/owes/RecentRecipientTransactionsTable";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    useDeleteSplit,
    useOwedByRecipient,
    useRecordPayment,
    useSettleAllSplitsByRecipient,
    useSettleSplit,
} from "@/hooks/useSplits";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { parseDecimal } from "@/lib/decimal";
import { downloadBlob } from "@/lib/downloadBlob";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { todayYmd } from "@/lib/timezone";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

interface RecipientOwesDetailProps {
    recipient: { id: number; name: string };
    onBack: () => void;
}

export function RecipientOwesDetail({ recipient, onBack }: RecipientOwesDetailProps) {
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
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const items = data?.items || [];
    const totalOutstanding = items.reduce((sum, split) => sum + split.remaining, 0);

    const handlePay = (event: FormEvent) => {
        event.preventDefault();
        if (!payDialog) return;
        const amount = parseDecimal(payAmount);
        if (!amount || amount <= 0) return;
        recordPayment.mutate(
            { splitId: payDialog.splitId, amount },
            { onSuccess: () => { setPayDialog(null); setPayAmount(""); } },
        );
    };

    const handleSettleAll = async () => {
        if (!items.length) return;
        const shouldSettle = await confirm({
            title: t("owesPage.settleAll.confirmTitle"),
            description: t("owesPage.settleAll.confirmDescription", {
                count: items.length,
                amount: formatCurrency(totalOutstanding, defaultCurrency, locale),
            }),
            confirmLabel: t("owesPage.settleAll.confirmAction"),
            cancelLabel: t("common.cancel"),
        });
        if (!shouldSettle) return;
        settleAllSplitsByRecipient.mutate(recipient.id);
    };

    const handleExportCsv = async () => {
        if (!items.length || isExportingCsv) return;
        setIsExportingCsv(true);
        try {
            const blob = await apiClient.exportOwedByRecipientCsv(recipient.id);
            const safeName = recipient.name
                .replace(/[^a-zA-Z0-9\s-]/g, "")
                .replace(/\s+/g, "_")
                .toLowerCase()
                .slice(0, 64);
            downloadBlob(blob, `owed_${safeName}_${todayYmd()}.csv`);
            toast.success(t("owesPage.export.success"));
        } catch (error) {
            toast.error(t("owesPage.export.failed"), {
                description: apiErrorToMessage(error, t),
            });
        } finally {
            setIsExportingCsv(false);
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title={recipient.name}
                subtitle={t("owesPage.outstandingSplits")}
                icon={HandCoins}
                actions={(
                    <>
                        <Button variant="ghost" size="icon" className="icon-touch-target" onClick={onBack} title={t("common.back")}>
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                        <Button variant="outline" onClick={handleSettleAll} disabled={!items.length || settleAllSplitsByRecipient.isPending}>
                            {settleAllSplitsByRecipient.isPending ? t("owesPage.settleAll.loading") : t("owesPage.settleAll.button")}
                        </Button>
                        <Button variant="outline" onClick={handleExportCsv} disabled={!items.length || isExportingCsv}>
                            {isExportingCsv ? t("owesPage.export.loading") : t("owesPage.export.button")}
                        </Button>
                    </>
                )}
            />

            {isLoading ? (
                <div {...loadingSurfaceProps} className="space-y-3">
                    {[...Array(3)].map((_, index) => <Skeleton key={index} className="h-24" />)}
                </div>
            ) : items.length === 0 ? (
                <EmptyState icon={Check} title={t("owesPage.allSettled")} />
            ) : (
                <>
                    <div className="space-y-3">
                        {items.map((split) => {
                            const progress = split.amount > 0 ? (split.amount_paid / split.amount) * 100 : 0;
                            const splitTitle = [split.transaction_recipient_name, split.transaction_memo]
                                .filter(Boolean)
                                .join(" - ") || t("owesPage.transaction");
                            return (
                                <Card
                                    key={split.id}
                                    variant="interactive"
                                    onDoubleClick={(event) => {
                                        const target = event.target as HTMLElement;
                                        if (target.closest("button")) return;
                                        navigate(`/transactions?transaction_id=${split.transaction_id}&filter_label=${encodeURIComponent(splitTitle)}`);
                                    }}
                                >
                                    <CardContent className="py-4">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex-1 space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium text-foreground">{splitTitle}</span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatDateStringWithAppSettings(split.transaction_date, appSettings.dateFormat)}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-muted-foreground">
                                                    {t("owesPage.original", {
                                                        amount: formatCurrency(
                                                            Math.abs(split.transaction_amount),
                                                            split.transaction_currency || defaultCurrency,
                                                            locale,
                                                        ),
                                                    })}
                                                    {split.note && ` · ${split.note}`}
                                                </p>
                                                <div className="flex items-center gap-3 mt-2">
                                                    <Progress value={progress} className="h-1.5 flex-1" />
                                                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                                                        <Money amount={split.amount_paid} currency={defaultCurrency} /> / <Money amount={split.amount} currency={defaultCurrency} />
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <span className="text-sm font-semibold text-primary mr-2">
                                                    <Money amount={split.remaining} currency={defaultCurrency} />
                                                </span>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="icon-touch-target text-accent hover:text-accent"
                                                    title={t("owesPage.recordPayment")}
                                                    onClick={() => {
                                                        setPayDialog({ splitId: split.id, remaining: split.remaining });
                                                        setPayAmount(String(split.remaining));
                                                    }}
                                                >
                                                    <DollarSign className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="icon-touch-target text-muted-foreground hover:text-accent"
                                                    title={t("owesPage.markSettled")}
                                                    onClick={() => settleSplit.mutate(split.id)}
                                                >
                                                    <Check className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="icon-touch-target text-muted-foreground hover:text-destructive"
                                                    title={t("owesPage.deleteSplit")}
                                                    onClick={async () => {
                                                        const shouldDelete = await confirm({
                                                            title: t("owesPage.deleteSplitConfirmTitle"),
                                                            description: t("owesPage.deleteSplitConfirmDescription"),
                                                            confirmLabel: t("common.delete"),
                                                            variant: "destructive",
                                                        });
                                                        if (shouldDelete) deleteSplit.mutate(split.id);
                                                    }}
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

            <Dialog open={!!payDialog} onOpenChange={() => setPayDialog(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{t("owesPage.recordDialog.title")}</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handlePay} className="grid gap-5">
                        <div className="space-y-3">
                            <div>
                                <label className="text-sm text-muted-foreground">{t("owesPage.recordDialog.amount")}</label>
                                <Input
                                    type="number"
                                    step="0.01"
                                    value={payAmount}
                                    onChange={(event) => setPayAmount(event.target.value)}
                                    placeholder={t("owesPage.recordDialog.placeholder")}
                                />
                                {payDialog && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                        {t("owesPage.recordDialog.remaining", {
                                            amount: formatCurrency(payDialog.remaining, defaultCurrency, locale),
                                        })}
                                    </p>
                                )}
                            </div>
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setPayDialog(null)}>
                                {t("owesPage.recordDialog.cancel")}
                            </Button>
                            <Button type="submit" disabled={recordPayment.isPending}>
                                {recordPayment.isPending ? t("owesPage.recordDialog.recording") : t("owesPage.recordDialog.submit")}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            <ConfirmDialog />
        </div>
    );
}
