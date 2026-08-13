import { AlertTriangle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { countStalePrices } from "@/utils/priceStaleness";
import { cn } from "@/lib/utils";

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
    <Alert variant="warning" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <div className="flex items-start justify-between gap-3">
        <AlertDescription>
          {t("portfolio.stalePricesBanner", { n: String(staleCount) })}
          {!isOnline && (
            <span className="ml-1 text-muted-foreground">
              {t("portfolio.refreshPricesOffline")}
            </span>
          )}
        </AlertDescription>
        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isRefreshing || !isOnline}
            title={!isOnline ? t("portfolio.refreshPricesOffline") : undefined}
            className="h-7 shrink-0"
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isRefreshing && "animate-spin")} />
            {t("portfolio.refreshPrices")}
          </Button>
        )}
      </div>
    </Alert>
  );
}
