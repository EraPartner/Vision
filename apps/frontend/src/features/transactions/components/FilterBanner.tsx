import { Badge } from "@/components/ui/badge";
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
    tagsFilter?: string[];
    onClear: () => void;
    onClearTags?: () => void;
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
    tagsFilter,
    onClear,
    onClearTags,
}: FilterBannerProps) {
    const { t } = useLanguage();

    const hasMainFilter = transactionIdFilter || recipientIdFilter || categoryIdFilter ||
        categoryIdsFilter?.length || startDateFilter || endDateFilter || transactionTypeFilter;
    const hasTagFilter = tagsFilter && tagsFilter.length > 0;

    if (!hasMainFilter && !hasTagFilter) {
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
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20">
            {hasMainFilter && (
                <span className="text-sm text-foreground">
                    {t('txPage.filteredBy', { label })}
                </span>
            )}
            {hasTagFilter && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground">{t('filter.tags.label')}:</span>
                    {tagsFilter!.map((slug) => (
                        <Badge key={slug} variant="outline" className="text-xs py-0 px-1.5 h-5">
                            {slug}
                        </Badge>
                    ))}
                    {onClearTags && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={onClearTags}
                            aria-label={t('filter.tags.clearAll')}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                </div>
            )}
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
                {hasMainFilter && (
                    <Button variant="ghost" size="icon" className="icon-touch-target" onClick={onClear} aria-label="Clear filter">
                        <X className="h-4 w-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}
