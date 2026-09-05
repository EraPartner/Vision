import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PortfolioBudgetCardProps {
  totalPIT: number;
  totalTaxes: number;
  portfolioTaxesPlusPIT: number;
}

/** Budget-like PIT + portfolio-tax total card of the portfolio-tax page. */
export function PortfolioBudgetCard({ totalPIT, totalTaxes, portfolioTaxesPlusPIT }: PortfolioBudgetCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.budgetTitle")}</CardTitle>
        <CardDescription>{t("tax.portfolioBudgetLikeDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.card.totalPIT")}</span>
          <span className="font-semibold tabular-nums text-loss">{fmt(totalPIT)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.totalTaxesPaid")}</span>
          <span className="font-semibold tabular-nums text-loss">{fmt(totalTaxes)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.totalWithPIT")}</span>
          <span className="font-bold tabular-nums text-primary">{fmt(portfolioTaxesPlusPIT)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
