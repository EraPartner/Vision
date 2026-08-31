import { useMemo } from "react";

import { Money } from "@/components/shared/Money";
import { TextLink } from "@/components/shared/TextLink";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRecentRecipientTransactions } from "@/features/splits/owes/useRecentRecipientTransactions";
import { cn } from "@/lib/utils";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { HandCoins } from "lucide-react";

interface RecentRecipientTransactionsTableProps {
    recipientId: number;
    recipientName: string;
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

export function RecentRecipientTransactionsTable({
    recipientId,
    recipientName,
}: RecentRecipientTransactionsTableProps) {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const { items, totalItems, isLoading, isFetchingMore, hasMore, loadMore } =
        useRecentRecipientTransactions(recipientId);

    const transactions: RecentRecipientTransactionRow[] = useMemo(
        () =>
            items.map((tx) => ({
                id: tx.id,
                date: tx.transaction_date || "",
                description: tx.memo || t("owesPage.transaction"),
                category: tx.category_name || t("txPage.field.uncategorized"),
                amount: tx.amount,
                currency: tx.currency || appSettings.defaultCurrency,
                bankAccount: tx.bank_account || "—",
            })),
        [items, t, appSettings.defaultCurrency],
    );

    const columns = useMemo(
        () => [
            {
                key: "date",
                header: t("txPage.col.date"),
                defaultWidth: 120,
                minWidth: 100,
                render: (row: RecentRecipientTransactionRow) => (
                    <span className="whitespace-nowrap">
                        {row.date
                            ? formatDateStringWithAppSettings(
                                  row.date,
                                  appSettings.dateFormat,
                              )
                            : "—"}
                    </span>
                ),
            },
            {
                key: "description",
                header: t("txPage.field.description"),
                minWidth: 180,
                render: (row: RecentRecipientTransactionRow) => (
                    <TextLink
                        to={`/transactions?transaction_id=${row.id}&filter_label=${encodeURIComponent(row.description)}`}
                    >
                        {row.description}
                    </TextLink>
                ),
            },
            {
                key: "category",
                header: t("txPage.col.category"),
                minWidth: 180,
            },
            {
                key: "amount",
                header: t("txPage.col.amount"),
                defaultWidth: 120,
                minWidth: 100,
                className: "text-right",
                render: (row: RecentRecipientTransactionRow) => (
                    <span
                        className={cn(
                            "whitespace-nowrap",
                            row.amount >= 0 ? "text-gain" : "text-loss",
                        )}
                    >
                        <Money
                            signed
                            amount={row.amount}
                            currency={row.currency}
                        />
                    </span>
                ),
            },
            {
                key: "bankAccount",
                header: t("txPage.field.bankAccount"),
                minWidth: 160,
            },
        ],
        [t, appSettings.dateFormat],
    );

    if (isLoading) {
        return <Skeleton {...loadingSurfaceProps} className="h-[320px]" />;
    }

    return (
        <VirtualDataTable
            title={t("owesPage.recentTransactionsTitle")}
            subtitle={t("owesPage.recentTransactionsSubtitle", {
                name: recipientName,
            })}
            columns={columns}
            data={transactions}
            serverMode={{
                pagination: {
                    totalItems,
                    isFetchingMore,
                    onLoadMore: loadMore,
                    hasMore,
                },
            }}
            maxHeight={320}
            rowHeight={42}
            emptyIcon={HandCoins}
            emptyMessage={t("owesPage.noRecentTransactions")}
        />
    );
}
