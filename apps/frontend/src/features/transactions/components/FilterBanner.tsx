import {
    numberFormatToLocale,
    DEFAULT_CURRENCY,
    currencyOr,
} from "@/utils/currency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { TransactionsExportButtons } from "./TransactionsExportButtons";
import { useRecipient } from "@/hooks/useRecipients";
import type {
    AccountId,
    CategoryId,
    RecipientId,
    TransactionId,
} from "@vision/types/brands";

interface FilterBannerProps {
    transactionIdFilter?: TransactionId | undefined;
    recipientIdFilter?: RecipientId | undefined;
    categoryIdFilter?: CategoryId | undefined;
    categoryIdsFilter?: CategoryId[] | undefined;
    startDateFilter?: string | undefined;
    endDateFilter?: string | undefined;
    transactionTypeFilter?: "income" | "expense" | undefined;
    amountMinFilter?: number | undefined;
    amountMaxFilter?: number | undefined;
    amountSignedFilter?: boolean | undefined;
    searchFilter?: string | undefined;
    filterLabel?: string | undefined;
    /** Preferred account filter (exact FK match, ADR-088); shown via filterLabel. */
    accountIdFilter?: AccountId | undefined;
    bankAccountFilter?: string | undefined;
    tagsFilter?: string[] | undefined;
    onClear: () => void;
    onClearTags?: (() => void) | undefined;
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
    // URL-derived ids: absent, 0 and NaN (a malformed param) are all "no filter".
    const isIdFilter = (id: number | undefined): id is number =>
        id !== undefined && id > 0;
    const { t } = useLanguage();
    const recipientQuery = useRecipient(recipientIdFilter ?? null);
    const { appSettings } = useAppSettings();

    const hasAmountFilter = amountMinFilter != null || amountMaxFilter != null;
    const hasMainFilter =
        isIdFilter(transactionIdFilter) ||
        isIdFilter(recipientIdFilter) ||
        isIdFilter(categoryIdFilter) ||
        (categoryIdsFilter != null && categoryIdsFilter.length > 0) ||
        Boolean(startDateFilter) ||
        Boolean(endDateFilter) ||
        transactionTypeFilter !== undefined ||
        isIdFilter(accountIdFilter) ||
        Boolean(bankAccountFilter) ||
        hasAmountFilter;
    const hasTagFilter = tagsFilter && tagsFilter.length > 0;

    if (!hasMainFilter && !hasTagFilter) {
        return null;
    }

    const currency = currencyOr(appSettings.defaultCurrency, DEFAULT_CURRENCY);
    // In signed mode the bound values carry their sign; render an explicit + for
    // positives so "+50 income" reads differently from a "50" magnitude match.
    const amountFormatter = new Intl.NumberFormat(
        numberFormatToLocale(appSettings.numberFormat),
        { maximumFractionDigits: 20 },
    );
    const fmtAmt = (n: number) =>
        `${amountSignedFilter && n > 0 ? "+" : ""}${amountFormatter.format(n)}`;
    const amountLabel = (() => {
        if (amountMinFilter != null && amountMaxFilter != null) {
            return amountMinFilter === amountMaxFilter
                ? `= ${fmtAmt(amountMinFilter)} ${currency}`
                : `${fmtAmt(amountMinFilter)}–${fmtAmt(amountMaxFilter)} ${currency}`;
        }
        if (amountMinFilter != null)
            return `≥ ${fmtAmt(amountMinFilter)} ${currency}`;
        if (amountMaxFilter != null)
            return `≤ ${fmtAmt(amountMaxFilter)} ${currency}`;
        return "";
    })();
    const fmtDate = (d?: string) =>
        d ? formatDateStringWithAppSettings(d, appSettings.dateFormat) : "…";

    const descriptors: string[] = [];
    const scopeDescriptors: string[] = [];
    if (isIdFilter(transactionIdFilter))
        scopeDescriptors.push(
            t("filter.transactionId", { id: transactionIdFilter }),
        );
    if (isIdFilter(recipientIdFilter))
        scopeDescriptors.push(
            recipientQuery.data?.name ??
                (recipientQuery.isError
                    ? t("filter.recipientUnknown")
                    : t("filter.recipientId", { id: recipientIdFilter })),
        );
    if (isIdFilter(categoryIdFilter))
        scopeDescriptors.push(t("filter.categoryId", { id: categoryIdFilter }));
    if (categoryIdsFilter !== undefined && categoryIdsFilter.length > 0)
        scopeDescriptors.push(
            t("filter.categoryIds", { count: categoryIdsFilter.length }),
        );
    if (isIdFilter(accountIdFilter))
        scopeDescriptors.push(t("filter.accountId", { id: accountIdFilter }));
    if (bankAccountFilter)
        scopeDescriptors.push(
            t("filter.bankAccount", { name: bankAccountFilter }),
        );
    // A shared label identifies a single scope; with combined filters it cannot
    // reliably identify which constraint it describes, so retain all scopes.
    if (filterLabel) descriptors.push(filterLabel);
    if (!filterLabel || scopeDescriptors.length !== 1)
        descriptors.push(...scopeDescriptors);
    if (transactionTypeFilter)
        descriptors.push(
            t(
                transactionTypeFilter === "income"
                    ? "filter.type.income"
                    : "filter.type.expense",
            ),
        );
    if (startDateFilter || endDateFilter)
        descriptors.push(
            `${fmtDate(startDateFilter)} → ${fmtDate(endDateFilter)}`,
        );
    if (hasAmountFilter) descriptors.push(amountLabel);
    const label = descriptors.join(" · ");

    return (
        <div className="flex flex-wrap items-center gap-2 rounded-card corner-continuous border border-primary/20 bg-primary/10 px-3 py-2">
            {hasMainFilter && (
                <span className="type-body text-foreground">
                    {t("txPage.filteredBy", { label })}
                </span>
            )}
            {hasTagFilter && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="type-footnote text-label-secondary">
                        {t("filter.tags.label")}:
                    </span>
                    {tagsFilter.map((slug) => (
                        <Badge key={slug} variant="outline" size="sm">
                            {slug}
                        </Badge>
                    ))}
                    {onClearTags && (
                        <Button
                            variant="ghost"
                            size="icon-xs"

                            onClick={onClearTags}
                            aria-label={t("filter.tags.clearAll")}
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
                    <Button
                        variant="ghost"
                        size="icon"
                        className="icon-touch-target"
                        onClick={onClear}
                        aria-label={t("aria.clearFilter")}
                    >
                        <X className="h-4 w-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}
