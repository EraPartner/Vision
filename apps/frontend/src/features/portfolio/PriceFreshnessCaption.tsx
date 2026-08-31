import { Clock3 } from "lucide-react";
import { useMemo } from "react";

import { formatDateTimeStringWithAppSettings } from "@/lib/dateUtils";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { numberFormatToLocale } from "@/utils/currency";
import {
    getAggregatePriceFreshness,
    type AggregatePriceFreshness,
} from "@/utils/priceStaleness";

interface PriceTimestampLike {
    price_provider?: string;
    price_updated_at?: string | null;
    is_active?: boolean;
}

type PriceFreshnessScope = "portfolio" | "investment";

export function usePriceFreshnessLabel(
    investments: ReadonlyArray<PriceTimestampLike>,
    scope: PriceFreshnessScope = "portfolio",
): string | null {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const freshness = useMemo<AggregatePriceFreshness>(
        () => getAggregatePriceFreshness(investments),
        [investments],
    );

    if (freshness.state === "none") return null;
    if (freshness.state === "not-fetched") {
        return t(
            scope === "investment"
                ? "networth.investmentPricesNotFetched"
                : "portfolio.livePricesNotFetched",
        );
    }

    const formatted = formatDateTimeStringWithAppSettings(
        freshness.updatedAt,
        appSettings.dateFormat,
        locale,
    );
    return t(
        scope === "investment"
            ? "networth.investmentPricesAsOf"
            : "portfolio.pricesAsOf",
        { date: formatted },
    );
}

interface PriceFreshnessCaptionProps {
    investments: ReadonlyArray<PriceTimestampLike>;
    scope?: PriceFreshnessScope;
    className?: string;
}

export function PriceFreshnessCaption({
    investments,
    scope = "portfolio",
    className,
}: PriceFreshnessCaptionProps) {
    const label = usePriceFreshnessLabel(investments, scope);
    if (!label) return null;

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 text-xs font-normal text-muted-foreground",
                className,
            )}
        >
            <Clock3 className="h-3 w-3 shrink-0" aria-hidden />
            <span>{label}</span>
        </span>
    );
}
