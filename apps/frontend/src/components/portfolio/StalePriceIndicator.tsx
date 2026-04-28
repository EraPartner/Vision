import { Clock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateTimeStringWithAppSettings } from "@/components/shared/dateUtils";
import { isPriceStale } from "@/utils/priceStaleness";

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

  if (!isPriceStale({ price_provider: priceProvider, price_updated_at: priceUpdatedAt })) {
    return null;
  }

  const formatted = priceUpdatedAt
    ? formatDateTimeStringWithAppSettings(priceUpdatedAt, appSettings.dateFormat, locale)
    : t("portfolio.staleNeverFetched");

  return (
    <span
      className={`inline-flex items-center gap-1 text-amber-500 ${className ?? ""}`}
      title={t("portfolio.stalePriceTooltip", { date: formatted })}
      aria-label={t("portfolio.stalePriceTooltip", { date: formatted })}
    >
      <Clock className="h-3 w-3" />
    </span>
  );
}
