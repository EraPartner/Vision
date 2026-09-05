import { useState } from "react";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
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
import { parseLocalDateFromYmd, toYmd } from "@/lib/dateUtils";
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
    const [exportingFormat, setExportingFormat] = useState<
        "csv" | "json" | null
    >(null);
    const [filters, setFilters] = useState<ExportFilters>(DEFAULT_FILTERS);
    const [showFilters, setShowFilters] = useState(false);

    const handleExport = async (format: "csv" | "json") => {
        setExportingFormat(format);
        try {
            const queryParams = new URLSearchParams();
            if (filters.startDate)
                queryParams.append("start_date", filters.startDate);
            if (filters.endDate)
                queryParams.append("end_date", filters.endDate);
            if (filters.bankAccounts.length > 0)
                queryParams.append(
                    "bank_accounts",
                    filters.bankAccounts.join(","),
                );
            if (filters.categoryIds.length > 0)
                queryParams.append(
                    "category_ids",
                    filters.categoryIds.join(","),
                );

            const blob = await requestBlob(
                `/api/transactions/export/${format}?${queryParams.toString()}`,
            );
            const date = todayYmd();
            const filename =
                format === "json"
                    ? `transactions_${date}.ndjson`
                    : `transactions_${date}.csv`;
            downloadBlob(blob, filename);

            toast.success(t("importPage.toast.exportSuccess"), {
                icon: <CheckCircle2 className="h-4 w-4" />,
            });
        } catch (error) {
            toast.error(t("importPage.toast.exportFailed"), {
                description: apiErrorToMessage(error, t),
            });
        } finally {
            setExportingFormat(null);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Download className="h-5 w-5 text-accent" />
                    {t("importPage.csvExport")}
                </CardTitle>
                <CardDescription>
                    {t("importPage.csvExportDesc")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-foreground">
                        {t("importPage.exportFilters")}
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowFilters((prev) => !prev)}
                        className="text-foreground"
                    >
                        {showFilters
                            ? t("importPage.hideFilters")
                            : t("importPage.showFilters")}
                    </Button>
                </div>

                {showFilters && (
                    <div className="space-y-4 mb-4 p-4 border rounded-lg bg-muted/30">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="export-start-date">
                                    {t("importPage.startDate")}
                                </Label>
                                <DatePicker
                                    id="export-start-date"
                                    value={
                                        filters.startDate
                                            ? parseLocalDateFromYmd(
                                                  filters.startDate,
                                              )
                                            : undefined
                                    }
                                    onChange={(date) =>
                                        setFilters({
                                            ...filters,
                                            startDate: date ? toYmd(date) : "",
                                        })
                                    }
                                    placeholder={t("plannedPage.link.pickDate")}
                                    allowClear
                                    clearLabel={t("common.clear")}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="export-end-date">
                                    {t("importPage.endDate")}
                                </Label>
                                <DatePicker
                                    id="export-end-date"
                                    value={
                                        filters.endDate
                                            ? parseLocalDateFromYmd(
                                                  filters.endDate,
                                              )
                                            : undefined
                                    }
                                    onChange={(date) =>
                                        setFilters({
                                            ...filters,
                                            endDate: date ? toYmd(date) : "",
                                        })
                                    }
                                    placeholder={t("plannedPage.link.pickDate")}
                                    allowClear
                                    clearLabel={t("common.clear")}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="export-bank-accounts">
                                    {t("importPage.bankAccounts")}
                                </Label>
                                <BankAccountMultiCombobox
                                    id="export-bank-accounts"
                                    value={filters.bankAccounts}
                                    onChange={(ibans) =>
                                        setFilters({
                                            ...filters,
                                            bankAccounts: ibans,
                                        })
                                    }
                                    className="w-full"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="export-categories">
                                    {t("importPage.categories")}
                                </Label>
                                <CategoryMultiCombobox
                                    id="export-categories"
                                    value={filters.categoryIds}
                                    onChange={(ids) =>
                                        setFilters({
                                            ...filters,
                                            categoryIds: ids,
                                        })
                                    }
                                    className="w-full"
                                />
                            </div>
                        </div>

                        <p className="text-xs text-muted-foreground">
                            {t("importPage.exportNote")}
                        </p>
                    </div>
                )}

                <div className="flex gap-2">
                    {(["csv", "json"] as const).map((format) => (
                        <Button
                            key={format}
                            onClick={() => handleExport(format)}
                            disabled={exportingFormat !== null}
                            variant="outline"
                            className="flex-1 h-11"
                            size="lg"
                        >
                            {exportingFormat === format ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                                    {t("importPage.exporting")}
                                </>
                            ) : (
                                <>
                                    <Download className="h-4 w-4 mr-2" />{" "}
                                    {t(
                                        format === "csv"
                                            ? "importPage.exportBtn"
                                            : "importPage.exportJsonBtn",
                                    )}
                                </>
                            )}
                        </Button>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
