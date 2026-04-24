import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { API_BASE_URL } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { toast } from "sonner";
import { CheckCircle2, Download, Loader2 } from "lucide-react";

interface ExportFilters {
  startDate: string;
  endDate: string;
  bankAccount: string;
  categoryId: string;
}

const DEFAULT_FILTERS: ExportFilters = {
  startDate: "",
  endDate: "",
  bankAccount: "",
  categoryId: "",
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
      if (filters.bankAccount) queryParams.append('bank_account', filters.bankAccount);
      if (filters.categoryId) queryParams.append('category_id', filters.categoryId);

      const url = `${API_BASE_URL}/api/transactions/export/${format}?${queryParams.toString()}`;
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) throw new Error(t('importPage.toast.exportFailed'));

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      const date = new Date().toISOString().slice(0, 10);
      link.download = format === 'json' ? `transactions_${date}.ndjson` : `transactions_${date}.csv`;
      link.click();
      URL.revokeObjectURL(downloadUrl);

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
                <Label htmlFor="start-date">{t('importPage.startDate')}</Label>
                <DatePicker
                  value={filters.startDate ? parseLocalDateFromYmd(filters.startDate) : undefined}
                  onChange={(date) => setFilters({ ...filters, startDate: date ? toYmd(date) : "" })}
                  placeholder={t('plannedPage.link.pickDate')}
                  allowClear
                  clearLabel={t('common.clear')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">{t('importPage.endDate')}</Label>
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
                <Label htmlFor="bank-account">{t('importPage.bankAccount')}</Label>
                <Input
                  id="bank-account"
                  placeholder={t('importPage.placeholderMainAccount')}
                  value={filters.bankAccount}
                  onChange={(e) => setFilters({ ...filters, bankAccount: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="category-id">{t('importPage.categoryId')}</Label>
                <Input
                  id="category-id"
                  placeholder={t('importPage.placeholderCategoryId')}
                  value={filters.categoryId}
                  onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{t('importPage.exportNote')}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={() => handleExport('csv')} disabled={exportingFormat !== null} variant="outline" className="flex-1 h-11" size="lg">
            {exportingFormat === 'csv' ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.exporting')}</>
            ) : (
              <><Download className="h-4 w-4 mr-2" /> {t('importPage.exportBtn')}</>
            )}
          </Button>
          <Button onClick={() => handleExport('json')} disabled={exportingFormat !== null} variant="outline" className="flex-1 h-11" size="lg">
            {exportingFormat === 'json' ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.exporting')}</>
            ) : (
              <><Download className="h-4 w-4 mr-2" /> {t('importPage.exportJsonBtn')}</>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
