import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { TransactionsExportButtons } from "./TransactionsExportButtons";

interface FilterBannerProps {
    transactionIdFilter?: number;
    recipientIdFilter?: number;
    categoryIdFilter?: number;
    categoryIdsFilter?: number[];
    startDateFilter?: string;
    endDateFilter?: string;
    transactionTypeFilter?: 'income' | 'expense';
    searchFilter?: string;
    filterLabel?: string;
    onClear: () => void;
}

export function FilterBanner({
    transactionIdFilter,
    recipientIdFilter,
    categoryIdFilter,
    categoryIdsFilter,
    startDateFilter,
    endDateFilter,
    transactionTypeFilter,
    searchFilter,
    filterLabel,
    onClear,
}: FilterBannerProps) {
    const { t } = useLanguage();

    const hasFilter = transactionIdFilter || recipientIdFilter || categoryIdFilter ||
        categoryIdsFilter?.length || startDateFilter || endDateFilter || transactionTypeFilter;
    if (!hasFilter) {
        return null;
    }

    const label =
        filterLabel ||
        (transactionIdFilter
            ? `transaction #${transactionIdFilter}`
            : recipientIdFilter
                ? `recipient #${recipientIdFilter}`
                : `category #${categoryIdFilter}`);

    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20">
            <span className="text-sm text-foreground">
                {t('txPage.filteredBy', { label })}
            </span>
            <div className="ml-auto flex items-center gap-2">
                <TransactionsExportButtons
                    transactionIdFilter={transactionIdFilter}
                    recipientIdFilter={recipientIdFilter}
                    categoryIdFilter={categoryIdFilter}
                    categoryIdsFilter={categoryIdsFilter}
                    startDateFilter={startDateFilter}
                    endDateFilter={endDateFilter}
                    transactionTypeFilter={transactionTypeFilter}
                    searchFilter={searchFilter}
                    filterLabel={filterLabel}
                />
                <Button variant="ghost" size="icon" className="icon-touch-target" onClick={onClear}>
                    <X className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}
