import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { TransactionsExportButtons } from "./TransactionsExportButtons";

interface FilterBannerProps {
    transactionIdFilter?: number;
    recipientIdFilter?: number;
    categoryIdFilter?: number;
    categoryIdsFilter?: number[];
    startDateFilter?: string;
    endDateFilter?: string;
    transactionTypeFilter?: 'income' | 'expense';
    amountMinFilter?: number;
    amountMaxFilter?: number;
    amountSignedFilter?: boolean;
    searchFilter?: string;
    filterLabel?: string;
    /** Preferred account filter (exact FK match, ADR-088); shown via filterLabel. */
    accountIdFilter?: number;
    bankAccountFilter?: string;
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
    amountMinFilter,
    amountMaxFilter,
    amountSignedFilter,
    searchFilter,
    filterLabel,
    accountIdFilter,
    bankAccountFilter,
    tagsFilter,
    onClear,
    onClearTags,
}: FilterBannerProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    const hasAmountFilter = amountMinFilter != null || amountMaxFilter != null;
    const hasMainFilter = transactionIdFilter || recipientIdFilter || categoryIdFilter ||
        categoryIdsFilter?.length || startDateFilter || endDateFilter || transactionTypeFilter ||
        accountIdFilter || bankAccountFilter || hasAmountFilter;
    const hasTagFilter = tagsFilter && tagsFilter.length > 0;

    if (!hasMainFilter && !hasTagFilter) {
        return null;
    }

    const currency = appSettings.defaultCurrency || 'EUR';
    // In signed mode the bound values carry their sign; render an explicit + for
    // positives so "+50 income" reads differently from a "50" magnitude match.
    const fmtAmt = (n: number) => (amountSignedFilter && n > 0 ? `+${n}` : String(n));
    const amountLabel = (() => {
        if (amountMinFilter != null && amountMaxFilter != null) {
            return amountMinFilter === amountMaxFilter
                ? `= ${fmtAmt(amountMinFilter)} ${currency}`
                : `${fmtAmt(amountMinFilter)}–${fmtAmt(amountMaxFilter)} ${currency}`;
        }
        if (amountMinFilter != null) return `≥ ${fmtAmt(amountMinFilter)} ${currency}`;
        if (amountMaxFilter != null) return `≤ ${fmtAmt(amountMaxFilter)} ${currency}`;
        return '';
    })();
    const fmtDate = (d?: string) => (d ? formatDateStringWithAppSettings(d, appSettings.dateFormat) : '…');

    const descriptors: string[] = [];
    const baseLabel =
        filterLabel ||
        (transactionIdFilter
            ? `transaction #${transactionIdFilter}`
            : recipientIdFilter
                ? `recipient #${recipientIdFilter}`
                : categoryIdFilter
                    ? `category #${categoryIdFilter}`
                    : accountIdFilter
                        ? `account #${accountIdFilter}`
                        : bankAccountFilter ?? '');
    if (baseLabel) descriptors.push(baseLabel);
    if (transactionTypeFilter) descriptors.push(t(transactionTypeFilter === 'income' ? 'filter.type.income' : 'filter.type.expense'));
    if (startDateFilter || endDateFilter) descriptors.push(`${fmtDate(startDateFilter)} → ${fmtDate(endDateFilter)}`);
    if (hasAmountFilter) descriptors.push(amountLabel);
    const label = descriptors.join(' · ');

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
                    amountMinFilter={amountMinFilter}
                    amountMaxFilter={amountMaxFilter}
                    amountSignedFilter={amountSignedFilter}
                    searchFilter={searchFilter}
                    filterLabel={filterLabel}
                    accountIdFilter={accountIdFilter}
                    bankAccountFilter={bankAccountFilter}
                />
                {hasMainFilter && (
                    <Button variant="ghost" size="icon" className="icon-touch-target" onClick={onClear} aria-label={t('aria.clearFilter')}>
                        <X className="h-4 w-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}
