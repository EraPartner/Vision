import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxYearTable } from "@/lib/belgianTax";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent } from "@/utils/currency";

interface BelgianPortfolioRulesCardProps {
  totalDividendIncome: number;
  grossDividendWht: number;
  dividendWhtReclaim: number;
  dividendWhtNetCost: number;
  dividendExemption: number;
  tobRecorded: number;
  tobAutoEstimate: number;
  tacrEstimate: number;
  cgtEstimate: number;
  reyndersEstimate: number;
  taxTable: BelgianTaxYearTable;
}

/** Belgian investment-tax rules + estimates section of the portfolio-tax page ("belgianRules" widget). */
export function BelgianPortfolioRulesCard({
  totalDividendIncome,
  grossDividendWht,
  dividendWhtReclaim,
  dividendWhtNetCost,
  dividendExemption,
  tobRecorded,
  tobAutoEstimate,
  tacrEstimate,
  cgtEstimate,
  reyndersEstimate,
  taxTable,
}: BelgianPortfolioRulesCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.widget.belgianRules")}</CardTitle>
        <CardDescription>{t("tax.belgianRulesDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendIncomeTracked")}</p>
            <p className="text-lg font-bold tabular-nums">{fmt(totalDividendIncome)}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.fromDividendTransactions")}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendWhtPaid")}</p>
            <p className="text-lg font-bold tabular-nums text-loss">{fmt(grossDividendWht)}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.witheldAtSource")}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendWhtReclaim")}</p>
            <p className="text-lg font-bold tabular-nums text-gain">{fmt(dividendWhtReclaim)}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.firstExemptBelgianDividends")} ({fmt(dividendExemption)})</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendWhtNetCost")}</p>
            <p className="text-lg font-bold tabular-nums text-loss">{fmt(dividendWhtNetCost)}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.afterReclaim")}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-foreground">{t("tax.tobRecorded")}</p>
              <Badge variant="outline">{t("tax.transactionTax")}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.tobTrackedFromBuyTaxes")}</p>
            <p className="text-base font-bold tabular-nums mt-2 text-loss">{fmt(tobRecorded)}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-foreground">{t("tax.tobAutoEstimate")}</p>
              <Badge variant="outline">{t("tax.estimated")}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.tobAutoEstimateDesc")}</p>
            <p className="text-base font-bold tabular-nums mt-2 text-loss">{fmt(tobAutoEstimate)}</p>
          </div>
        </div>

        {tacrEstimate > 0 && (
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-foreground">{t("tax.tacrEstimate")}</p>
              <Badge variant="outline">{formatPercent(taxTable.securitiesAccountTaxRate * 100, { digits: 2 })}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.tacrEstimateDesc")}</p>
            <p className="text-base font-bold tabular-nums mt-2 text-loss">{fmt(tacrEstimate)}</p>
          </div>
        )}

        {cgtEstimate > 0 && (
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-foreground">{t("tax.cgtEstimate")}</p>
              <Badge variant="outline">{formatPercent(taxTable.capitalGainsTaxRate * 100, { digits: 0 })}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.cgtEstimateDesc")}</p>
            <p className="text-base font-bold tabular-nums mt-2 text-loss">{fmt(cgtEstimate)}</p>
          </div>
        )}

        {reyndersEstimate > 0 && (
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-foreground">{t("tax.reyndersEstimate")}</p>
              <Badge variant="outline">{formatPercent(taxTable.reyndersTaxRate * 100, { digits: 0 })}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("tax.reyndersEstimateDesc")}</p>
            <p className="text-base font-bold tabular-nums mt-2 text-loss">{fmt(reyndersEstimate)}</p>
          </div>
        )}

        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">{t("tax.currentlyAutomaticLabel")}</span>{" "}
            {t("tax.currentlyAutomaticPortfolio")}
          </p>
          <p>
            <span className="font-semibold text-foreground">{t("tax.manualAdjustmentsLabel")}</span>{" "}
            {t("tax.manualAdjustmentsDesc")}
          </p>
          <p>
            <span className="font-semibold text-foreground">{t("tax.notAutomaticLabel")}</span>{" "}
            {t("tax.notAutomaticPortfolio")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
