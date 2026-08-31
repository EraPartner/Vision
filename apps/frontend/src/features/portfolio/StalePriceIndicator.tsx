import { Clock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateTimeStringWithAppSettings } from "@/lib/dateUtils";
import { isPriceStale } from "@/utils/priceStaleness";
import { cn } from "@/lib/utils";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";

interface StalePriceIndicatorProps {
    priceProvider?: string;
    priceUpdatedAt?: string | null;
    className?: string;
}

export function StalePriceIndicator({
    priceProvider,
    priceUpdatedAt,
    className,
}: StalePriceIndicatorProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    if (
        !isPriceStale({
            price_provider: priceProvider,
            price_updated_at: priceUpdatedAt,
        })
    ) {
        return null;
    }

    const formatted = priceUpdatedAt
        ? formatDateTimeStringWithAppSettings(
              priceUpdatedAt,
              appSettings.dateFormat,
              locale,
          )
        : t("portfolio.staleNeverFetched");

    const message = t("portfolio.stalePriceTooltip", { date: formatted });

    return (
        <TouchDisclosure
            label={message}
            content={message}
            className={cn(
                "text-warning [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:justify-center",
                className,
            )}
        >
            <Clock className="h-3 w-3" aria-hidden="true" />
        </TouchDisclosure>
    );
}
