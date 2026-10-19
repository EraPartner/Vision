import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { RecipientPivotConversion } from "@/lib/api/aggregations";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export function HistoricalFxFallbackWarning({
    conversion,
}: {
    conversion?: RecipientPivotConversion | undefined;
}) {
    const { t, tc } = useLanguage();
    const unconvertedCount = conversion?.unconvertedCount ?? 0;

    return (
        <>
            {conversion?.usedHistoricalFallback && (
                <Alert variant="warning" className="mb-3">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        {t("customChart.historicalFxFallback", {
                            currencies:
                                conversion.affectedCurrencies.join(", ") || "—",
                        })}
                    </AlertDescription>
                </Alert>
            )}
            {/* No stored rate at all: left out, never added 1:1 (ADR-216). */}
            {unconvertedCount > 0 && (
                <p className="mb-3 type-footnote text-warning">
                    {tc("common.fxUnavailableTransactions", unconvertedCount)}
                </p>
            )}
        </>
    );
}
