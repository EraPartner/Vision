import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface PortfolioOversoldBadgeProps {
    oversold?: boolean;
}

export function PortfolioOversoldBadge({
    oversold,
}: PortfolioOversoldBadgeProps) {
    const { t } = useLanguage();

    if (!oversold) return null;

    const description = t("portfolio.oversold.description");
    return (
        <Badge
            variant="warning"
            size="sm"
            className="shrink-0 gap-1"
            role="status"
            aria-label={`${t("portfolio.oversold.label")}. ${description}`}
            title={description}
        >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {t("portfolio.oversold.label")}
        </Badge>
    );
}
