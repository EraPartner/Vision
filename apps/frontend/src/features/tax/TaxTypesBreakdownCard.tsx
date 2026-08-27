import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { CostBreakdownEntry } from "@/hooks/usePortfolioTaxData";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/shared/Money";

interface TaxTypesBreakdownCardProps {
  taxBreakdown: CostBreakdownEntry[];
  feeBreakdown: CostBreakdownEntry[];
  totalRealizedGain: number;
  totalUnrealizedGain: number;
}

/** Per-tax-type and per-fee-type breakdown of the portfolio-tax page ("taxTypes" widget). */
export function TaxTypesBreakdownCard({
  taxBreakdown,
  feeBreakdown,
  totalRealizedGain,
  totalUnrealizedGain,
}: TaxTypesBreakdownCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.widget.taxTypes")}</CardTitle>
        <CardDescription>{t("tax.taxTypesDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {taxBreakdown.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-2">{t("tax.taxes")}</h4>
            <div className="space-y-2">
              {taxBreakdown.map(({ name, value }) => (
                <div key={name} className="flex justify-between items-center py-1.5 border-b border-border/50 last:border-0">
                  <span className="text-sm text-muted-foreground">{name}</span>
                  <span className="text-sm font-semibold tabular-nums text-loss">{fmt(value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {feeBreakdown.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-2">{t("tax.fees")}</h4>
            <div className="space-y-2">
              {feeBreakdown.map(({ name, value }) => (
                <div key={name} className="flex justify-between items-center py-1.5 border-b border-border/50 last:border-0">
                  <span className="text-sm text-muted-foreground">{name}</span>
                  <span className="text-sm font-semibold tabular-nums text-loss">{fmt(value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="pt-2 border-t border-border">
          <h4 className="text-sm font-semibold text-foreground mb-2">{t("tax.gainsContext")}</h4>
          <div className="space-y-2">
            <div className="flex justify-between items-center py-1.5">
              <span className="text-sm text-muted-foreground">{t("portfolio.realizedGains")}</span>
              <span className={cn("text-sm font-semibold tabular-nums", totalRealizedGain >= 0 ? "text-gain" : "text-loss")}>
                <Money amount={totalRealizedGain} signed />
              </span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-sm text-muted-foreground">{t("portfolio.unrealizedGains")}</span>
              <span className={cn("text-sm font-semibold tabular-nums", totalUnrealizedGain >= 0 ? "text-gain" : "text-loss")}>
                <Money amount={totalUnrealizedGain} signed />
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
