import { PageError } from "@/components/shared/PageError";
import { useId, useState, type FormEvent } from "react";
import {
    BanknoteCheck,
    Check,
    Download,
    HandCoins,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/EmptyState";
import { Money } from "@/components/shared/Money";
import { PageHeader } from "@/components/shared/PageHeader";
import { RowMenu } from "@/components/shared/RowMenu";
import { TextLink } from "@/components/shared/TextLink";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
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
import { formatEditableNumber } from "@/utils/currency";
import { downloadBlob } from "@/lib/downloadBlob";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { todayYmd } from "@/lib/timezone";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

interface RecipientOwesDetailProps {
    recipient: { id: number; name: string };
    onBack: () => void;
}

export function RecipientOwesDetail({
    recipient,
    onBack,
}: RecipientOwesDetailProps) {
    const {
        data,
        isLoading,
        error: loadError,
        refetch,
    } = useOwedByRecipient(recipient.id);
    const recordPayment = useRecordPayment();
    const settleSplit = useSettleSplit();
    const settleAllSplitsByRecipient = useSettleAllSplitsByRecipient();
    const deleteSplit = useDeleteSplit();
    const [payDialog, setPayDialog] = useState<{
        splitId: number;
        remaining: number;
    } | null>(null);
    const paymentId = useId();
    const [payAmount, setPayAmount] = useState("");
    const [isExportingCsv, setIsExportingCsv] = useState(false);
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const items = data?.items || [];
    const totalOutstanding = items.reduce(
        (sum, split) => sum + split.remaining,
        0,
    );

    const handlePay = (event: FormEvent) => {
        event.preventDefault();
        if (!payDialog) return;
        const amount = parseDecimal(payAmount, appSettings.numberFormat);
        if (!amount || amount <= 0) return;
        recordPayment.mutate(
            { splitId: payDialog.splitId, amount },
            {
                onSuccess: () => {
                    setPayDialog(null);
                    setPayAmount("");
                },
            },
        );
    };

    const handleSettleAll = async () => {
        if (!items.length) return;
        const shouldSettle = await confirm({
            title: t("owesPage.settleAll.confirmTitle"),
            description: t("owesPage.settleAll.confirmDescription", {
                count: items.length,
                amount: formatCurrency(
                    totalOutstanding,
                    defaultCurrency,
                    locale,
                    appSettings.showDecimalPlaces ?? 2,
                ),
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

    const handleDeleteSplit = async (splitId: number) => {
        const shouldDelete = await confirm({
            title: t("owesPage.deleteSplitConfirmTitle"),
            description: t("owesPage.deleteSplitConfirmDescription"),
            confirmLabel: t("common.delete"),
            variant: "destructive",
        });
        if (shouldDelete) deleteSplit.mutate(splitId);
    };

    return (
        <div className="space-y-6">
            <PageHeader
                back={{ label: t("common.back"), onClick: onBack }}
                title={recipient.name}
                subtitle={t("owesPage.outstandingSplits")}
                icon={HandCoins}
                actions={
                    <>
                        <RowMenu
                            variant="outline"
                            size="icon"
                            label={t("owesPage.menu")}
                        >
                            <DropdownMenuItem
                                disabled={!items.length || isExportingCsv}
                                onSelect={() => void handleExportCsv()}
                            >
                                <Download
                                    className="mr-2 h-4 w-4 text-label-secondary"
                                    aria-hidden
                                />
                                {isExportingCsv
                                    ? t("owesPage.export.loading")
                                    : t("owesPage.export.button")}
                            </DropdownMenuItem>
                        </RowMenu>
                        <Button
                            onClick={() => void handleSettleAll()}
                            disabled={
                                !items.length ||
                                settleAllSplitsByRecipient.isPending
                            }
                        >
                            {settleAllSplitsByRecipient.isPending
                                ? t("owesPage.settleAll.loading")
                                : t("owesPage.settleAll.button")}
                        </Button>
                    </>
                }
            />

            {loadError && data && (
                <PageError
                    message={t("common.loadFailedRetry")}
                    onRetry={() => void refetch()}
                />
            )}
            {loadError && !data ? (
                <PageError
                    message={t("common.loadFailedRetry")}
                    onRetry={() => void refetch()}
                />
            ) : isLoading ? (
                <div {...loadingSurfaceProps} className="space-y-2">
                    {[...Array(3)].map((_, index) => (
                        <Skeleton
                            key={index}
                            className="h-16 rounded-card corner-continuous"
                        />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <EmptyState icon={Check} title={t("owesPage.allSettled")} />
            ) : (
                <div className="space-y-6">
                    <List>
                        {items.map((split) => {
                            const progress =
                                split.amount > 0
                                    ? (split.amount_paid / split.amount) * 100
                                    : 0;
                            const splitTitle =
                                [
                                    split.transaction_recipient_name,
                                    split.transaction_memo,
                                ]
                                    .filter(Boolean)
                                    .join(" - ") || t("owesPage.transaction");
                            const splitDate = formatDateStringWithAppSettings(
                                split.transaction_date,
                                appSettings.dateFormat,
                            );
                            const splitContext = `${splitTitle}, ${splitDate}`;
                            const openPayDialog = () => {
                                setPayDialog({
                                    splitId: split.id,
                                    remaining: split.remaining,
                                });
                                setPayAmount(
                                    formatEditableNumber(
                                        split.remaining,
                                        appSettings.numberFormat,
                                    ),
                                );
                            };
                            return (
                                <ListRow
                                    key={split.id}
                                    title={
                                        <span className="inline-flex max-w-full items-baseline gap-2">
                                            <TextLink
                                                to={`/transactions?transaction_id=${split.transaction_id}&filter_label=${encodeURIComponent(splitTitle)}`}
                                                tone="inherit"
                                                className="truncate font-medium"
                                            >
                                                {splitTitle}
                                            </TextLink>
                                            <span className="shrink-0 type-footnote text-label-secondary">
                                                {splitDate}
                                            </span>
                                        </span>
                                    }
                                    subtitle={
                                        <span className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_auto] sm:items-center sm:gap-4">
                                            <span className="min-w-0">
                                                {t("owesPage.original", {
                                                    amount: formatCurrency(
                                                        Math.abs(
                                                            split.transaction_amount,
                                                        ),
                                                        split.transaction_currency ||
                                                            defaultCurrency,
                                                        locale,
                                                        appSettings.showDecimalPlaces ??
                                                            2,
                                                    ),
                                                })}
                                                {split.note &&
                                                    ` · ${split.note}`}
                                            </span>
                                            <Progress
                                                value={progress}
                                                className="hidden h-1 w-24 sm:block"
                                                aria-label={t(
                                                    "owesPage.repaymentProgress",
                                                    {
                                                        recipient:
                                                            recipient.name,
                                                    },
                                                )}
                                            />
                                            <span className="hidden shrink-0 whitespace-nowrap sm:inline">
                                                <Money
                                                    amount={split.amount_paid}
                                                    currency={defaultCurrency}
                                                />{" "}
                                                /{" "}
                                                <Money
                                                    amount={split.amount}
                                                    currency={defaultCurrency}
                                                />
                                            </span>
                                        </span>
                                    }
                                    trailing={
                                        <>
                                            <span className="w-36 text-right type-headline tabular-nums text-foreground">
                                                <Money
                                                    amount={split.remaining}
                                                    currency={defaultCurrency}
                                                />
                                            </span>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                aria-label={`${t("owesPage.recordPayment")}: ${splitContext}`}
                                                onClick={openPayDialog}
                                            >
                                                <BanknoteCheck aria-hidden="true" />
                                                {t("owesPage.recordPayment")}
                                            </Button>
                                            <RowMenu
                                                label={t("owesPage.rowMenu", {
                                                    name: splitContext,
                                                })}
                                            >
                                                <DropdownMenuItem
                                                    disabled={
                                                        settleSplit.isPending
                                                    }
                                                    onSelect={() =>
                                                        settleSplit.mutate(
                                                            split.id,
                                                        )
                                                    }
                                                >
                                                    <Check
                                                        className="mr-2 h-4 w-4 text-label-secondary"
                                                        aria-hidden
                                                    />
                                                    {t("owesPage.markSettled")}
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    variant="destructive"
                                                    disabled={
                                                        deleteSplit.isPending
                                                    }
                                                    onSelect={() =>
                                                        void handleDeleteSplit(
                                                            split.id,
                                                        )
                                                    }
                                                >
                                                    <Trash2
                                                        className="mr-2 h-4 w-4"
                                                        aria-hidden
                                                    />
                                                    {t("owesPage.deleteSplit")}
                                                </DropdownMenuItem>
                                            </RowMenu>
                                        </>
                                    }
                                />
                            );
                        })}
                    </List>
                    <RecentRecipientTransactionsTable
                        recipientId={recipient.id}
                        recipientName={recipient.name}
                    />
                </div>
            )}

            <Dialog open={!!payDialog} onOpenChange={() => setPayDialog(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>
                            {t("owesPage.recordDialog.title")}
                        </DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handlePay} className="grid gap-5">
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <Label htmlFor={paymentId}>
                                    {t("owesPage.recordDialog.amount")}
                                </Label>
                                <Input
                                    id={paymentId}
                                    aria-describedby={`${paymentId}-remaining`}
                                    type="text"
                                    inputMode="decimal"
                                    value={payAmount}
                                    onChange={(event) =>
                                        setPayAmount(event.target.value)
                                    }
                                    placeholder={t(
                                        "owesPage.recordDialog.placeholder",
                                    )}
                                />
                                {payDialog && (
                                    <p
                                        id={`${paymentId}-remaining`}
                                        className="type-footnote text-label-secondary"
                                    >
                                        {t("owesPage.recordDialog.remaining", {
                                            amount: formatCurrency(
                                                payDialog.remaining,
                                                defaultCurrency,
                                                locale,
                                                appSettings.showDecimalPlaces ??
                                                    2,
                                            ),
                                        })}
                                    </p>
                                )}
                            </div>
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setPayDialog(null)}
                            >
                                {t("owesPage.recordDialog.cancel")}
                            </Button>
                            <Button
                                type="submit"
                                disabled={recordPayment.isPending}
                            >
                                {recordPayment.isPending
                                    ? t("owesPage.recordDialog.recording")
                                    : t("owesPage.recordDialog.submit")}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            <ConfirmDialog />
        </div>
    );
}
