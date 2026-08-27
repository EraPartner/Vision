import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import { exchangeRateKeys } from "@/lib/queryKeys";
import type { ExchangeRatesData } from "@/lib/api/info";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateTimeStringWithAppSettings } from "@/components/shared/dateUtils";

const DISMISS_KEY = "fx-status-banner-dismissed-at";
const DISMISS_TTL_MS = 60 * 60 * 1000;

function isDismissedRecently(): boolean {
    try {
        const raw = localStorage.getItem(DISMISS_KEY);
        if (!raw) return false;
        const at = Number(raw);
        return Number.isFinite(at) && Date.now() - at < DISMISS_TTL_MS;
    } catch {
        return false;
    }
}

export function FxStatusBanner() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const [dismissed, setDismissed] = useState<boolean>(() => isDismissedRecently());
    const queryClient = useQueryClient();

    const { data, isFetching } = useQuery<ExchangeRatesData>({
        queryKey: exchangeRateKeys.fxStatus,
        queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
        staleTime: 60_000,
        retry: false,
    });

    const refreshMutation = useMutation({
        mutationFn: () => apiClient.refreshExchangeRates(),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: exchangeRateKeys.all }),
                queryClient.invalidateQueries({ queryKey: exchangeRateKeys.fxStatus }),
            ]);
            toast.success(t("exchangeRates.refreshSuccess"));
        },
        onError: () => {
            toast.error(t("exchangeRates.refreshError"));
        },
    });

    const isRefreshing = refreshMutation.isPending || isFetching;

    if (dismissed) return null;
    if (!data) return null;
    if (!data.is_stale && data.source !== "fallback") return null;

    const message = data.source === "fallback"
        ? t("exchangeRates.fallbackInUse")
        : t("exchangeRates.staleWarning", {
            date: data.last_fetched_at
                ? formatDateTimeStringWithAppSettings(data.last_fetched_at, appSettings.dateFormat, locale)
                : "—",
        });

    const handleDismiss = () => {
        try {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {
            // ignore — banner just stays visible until reload
        }
        setDismissed(true);
    };

    return (
        <Alert variant="warning" className="mb-4 pr-10">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center gap-3">
                <span>{message}</span>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isRefreshing}
                    onClick={() => refreshMutation.mutate()}
                    className="gap-1.5"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                    {t("exchangeRates.refresh")}
                </Button>
            </AlertDescription>
            <button
                type="button"
                onClick={handleDismiss}
                className="absolute right-3 top-3 text-foreground/50 transition-colors hover:text-foreground"
                aria-label={t("layout.dismiss")}
            >
                <X className="h-4 w-4" />
            </button>
        </Alert>
    );
}
