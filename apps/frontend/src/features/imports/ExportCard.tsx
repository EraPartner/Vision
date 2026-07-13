import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { requestBlob } from "@/lib/api/helpers";
import { downloadBlob } from "@/lib/downloadBlob";
import { todayYmd } from "@/lib/timezone";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { CategoryMultiCombobox } from "@/components/shared/CategoryMultiCombobox";
import { BankAccountMultiCombobox } from "@/components/shared/BankAccountMultiCombobox";
import { toast } from "sonner";
import { CheckCircle2, Download, Loader2 } from "lucide-react";

interface ExportFilters {
  startDate: string;
  endDate: string;
  bankAccounts: string[];
  categoryIds: number[];
}

const DEFAULT_FILTERS: ExportFilters = {
  startDate: "",
  endDate: "",
  bankAccounts: [],
  categoryIds: [],
};

export function ExportCard() {
  const { t } = useLanguage();
  const [exportingFormat, setExportingFormat] = useState<'csv' | 'json' | null>(null);
  const [filters, setFilters] = useState<ExportFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  const handleExport = async (format: 'csv' | 'json') => {
    setExportingFormat(format);
    try {
      const queryParams = new URLSearchParams();
      if (filters.startDate) queryParams.append('start_date', filters.startDate);
      if (filters.endDate) queryParams.append('end_date', filters.endDate);
      if (filters.bankAccounts.length > 0) queryParams.append('bank_accounts', filters.bankAccounts.join(','));
      if (filters.categoryIds.length > 0) queryParams.append('category_ids', filters.categoryIds.join(','));

      const blob = await requestBlob(`/api/transactions/export/${format}?${queryParams.toString()}`);
      const date = todayYmd();
      const filename = format === 'json' ? `transactions_${date}.ndjson` : `transactions_${date}.csv`;
      downloadBlob(blob, filename);

      toast.success(t('importPage.toast.exportSuccess'), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('importPage.toast.exportFailed');
      toast.error(t('importPage.toast.exportFailed'), { description: message });
    } finally {
      setExportingFormat(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5 text-accent" />
          {t('importPage.csvExport')}
        </CardTitle>
        <CardDescription>{t('importPage.csvExportDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-foreground">{t('importPage.exportFilters')}</p>
          <Button variant="outline" size="sm" onClick={() => setShowFilters((prev) => !prev)} className="text-foreground">
            {showFilters ? t('importPage.hideFilters') : t('importPage.showFilters')}
          </Button>
        </div>

        {showFilters && (
          <div className="space-y-4 mb-4 p-4 border rounded-lg bg-muted/30">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('importPage.startDate')}</Label>
                <DatePicker
                  value={filters.startDate ? parseLocalDateFromYmd(filters.startDate) : undefined}
                  onChange={(date) => setFilters({ ...filters, startDate: date ? toYmd(date) : "" })}
                  placeholder={t('plannedPage.link.pickDate')}
                  allowClear
                  clearLabel={t('common.clear')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('importPage.endDate')}</Label>
                <DatePicker
                  value={filters.endDate ? parseLocalDateFromYmd(filters.endDate) : undefined}
                  onChange={(date) => setFilters({ ...filters, endDate: date ? toYmd(date) : "" })}
                  placeholder={t('plannedPage.link.pickDate')}
                  allowClear
                  clearLabel={t('common.clear')}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('importPage.bankAccounts')}</Label>
                <BankAccountMultiCombobox
                  value={filters.bankAccounts}
                  onChange={(ibans) => setFilters({ ...filters, bankAccounts: ibans })}
                  className="w-full"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('importPage.categories')}</Label>
                <CategoryMultiCombobox
                  value={filters.categoryIds}
                  onChange={(ids) => setFilters({ ...filters, categoryIds: ids })}
                  className="w-full"
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{t('importPage.exportNote')}</p>
          </div>
        )}

        <div className="flex gap-2">
          {(['csv', 'json'] as const).map((format) => (
            <Button key={format} onClick={() => handleExport(format)} disabled={exportingFormat !== null} variant="outline" className="flex-1 h-11" size="lg">
              {exportingFormat === format ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.exporting')}</>
              ) : (
                <><Download className="h-4 w-4 mr-2" /> {t(format === 'csv' ? 'importPage.exportBtn' : 'importPage.exportJsonBtn')}</>
              )}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
