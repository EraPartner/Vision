import { useState } from "react";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { requestBlob } from "@/lib/api/helpers";
import { downloadBlob } from "@/lib/downloadBlob";
import { todayYmd } from "@/lib/timezone";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

type ExportFormat = 'csv' | 'json';

interface TransactionsExportButtonsProps {
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
    /** Preferred account filter (exact FK match, ADR-088). */
    accountIdFilter?: number;
    bankAccountFilter?: string;
}

function buildQueryString(props: TransactionsExportButtonsProps): string {
    const params = new URLSearchParams();
    if (props.transactionIdFilter != null) params.append('transaction_id', String(props.transactionIdFilter));
    if (props.recipientIdFilter != null) params.append('recipient_id', String(props.recipientIdFilter));
    if (props.categoryIdFilter != null) params.append('category_id', String(props.categoryIdFilter));
    if (props.categoryIdsFilter && props.categoryIdsFilter.length > 0) {
        params.append('category_ids', props.categoryIdsFilter.join(','));
    }
    if (props.startDateFilter) params.append('start_date', props.startDateFilter);
    if (props.endDateFilter) params.append('end_date', props.endDateFilter);
    if (props.transactionTypeFilter) params.append('transaction_type', props.transactionTypeFilter);
    if (props.amountMinFilter != null) params.append('amount_min', String(props.amountMinFilter));
    if (props.amountMaxFilter != null) params.append('amount_max', String(props.amountMaxFilter));
    if (props.amountSignedFilter) params.append('amount_signed', 'true');
    if (props.searchFilter) params.append('search', props.searchFilter);
    if (props.accountIdFilter != null) params.append('account_id', String(props.accountIdFilter));
    if (props.bankAccountFilter) params.append('bank_account', props.bankAccountFilter);
    return params.toString();
}

function slugify(label: string): string {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

function buildFilename(format: ExportFormat, filterLabel?: string): string {
    const ext = format === 'json' ? 'ndjson' : 'csv';
    const date = todayYmd();
    const slug = filterLabel ? slugify(filterLabel) : '';
    const middle = slug || 'filtered';
    return `transactions_${middle}_${date}.${ext}`;
}

export function TransactionsExportButtons(props: TransactionsExportButtonsProps) {
    const { t } = useLanguage();
    const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);

    const handleExport = async (format: ExportFormat) => {
        if (exportingFormat !== null) return;
        setExportingFormat(format);
        try {
            const qs = buildQueryString(props);
            const blob = await requestBlob(`/api/transactions/export/${format}${qs ? `?${qs}` : ''}`);
            downloadBlob(blob, buildFilename(format, props.filterLabel));
            toast.success(t('txPage.toast.exportSuccess'));
        } catch (error) {
            toast.error(t('txPage.toast.exportFailed'), { description: apiErrorToMessage(error, t) });
        } finally {
            setExportingFormat(null);
        }
    };

    const renderButton = (format: ExportFormat, labelKey: string) => {
        const isThisLoading = exportingFormat === format;
        return (
            <Button
                variant="outline"
                size="sm"
                disabled={exportingFormat !== null}
                onClick={() => handleExport(format)}
            >
                {isThisLoading ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                    <Download className="h-4 w-4 mr-1" />
                )}
                {isThisLoading ? t('txPage.export.downloading') : t(labelKey)}
            </Button>
        );
    };

    return (
        <div className="flex gap-2">
            {renderButton('csv', 'txPage.export.csv')}
            {renderButton('json', 'txPage.export.json')}
        </div>
    );
}
