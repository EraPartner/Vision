import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { countStalePrices } from "@/utils/priceStaleness";

interface InvestmentLike {
  price_provider?: string;
  price_updated_at?: string;
}

interface StalePricesBannerProps {
  investments: ReadonlyArray<InvestmentLike>;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function StalePricesBanner({
  investments,
  onRefresh,
  isRefreshing,
}: StalePricesBannerProps) {
  const { t } = useLanguage();
  const isOnline = useOnlineStatus();
  const staleCount = countStalePrices(investments);

  if (staleCount === 0) return null;

  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
      <div className="flex-1 text-foreground/80">
        {t("portfolio.stalePricesBanner", { n: String(staleCount) })}
        {!isOnline && (
          <span className="ml-1 text-muted-foreground">
            {t("portfolio.refreshPricesOffline")}
          </span>
        )}
      </div>
      {onRefresh && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing || !isOnline}
          title={!isOnline ? t("portfolio.refreshPricesOffline") : undefined}
          className="h-7"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
          {t("portfolio.refreshPrices")}
        </Button>
      )}
    </div>
  );
}
