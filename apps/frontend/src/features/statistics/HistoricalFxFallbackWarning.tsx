import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { RecipientPivotConversion } from "@/lib/api/aggregations";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export function HistoricalFxFallbackWarning({
    conversion,
}: {
    conversion?: RecipientPivotConversion;
}) {
    const { t } = useLanguage();

    if (!conversion?.usedHistoricalFallback) return null;

    return (
        <Alert variant="warning" className="mb-3">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
                {t("customChart.historicalFxFallback", {
                    currencies: conversion.affectedCurrencies.join(", ") || "—",
                })}
            </AlertDescription>
        </Alert>
    );
}
