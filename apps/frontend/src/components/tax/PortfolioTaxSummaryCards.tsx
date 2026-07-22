import { Landmark, Receipt, TrendingDown, AlertTriangle, SlidersHorizontal } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { TaxSummaryCard } from "@/pages/portfolio/tax/TaxSummaryCard";

interface PortfolioTaxSummaryCardsProps {
  totalTaxes: number;
  totalFees: number;
  totalTaxesAndFees: number;
  effectiveTaxRate: number;
  portfolioTaxesPlusPIT: number;
  totalManualTaxes: number;
  totalManualFees: number;
  txYear: number;
}

/** Summary stat cards of the portfolio-tax page ("summaryCards" widget). */
export function PortfolioTaxSummaryCards({
  totalTaxes,
  totalFees,
  totalTaxesAndFees,
  effectiveTaxRate,
  portfolioTaxesPlusPIT,
  totalManualTaxes,
  totalManualFees,
  txYear,
}: PortfolioTaxSummaryCardsProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  const cards = [
    {
      title: t("tax.totalTaxesPaid"),
      value: fmt(totalTaxes),
      icon: Landmark,
      desc: t("tax.acrossAllInvestmentsYear", { year: String(txYear) }),
      cls: "text-loss",
    },
    {
      title: t("tax.totalFeesPaid"),
      value: fmt(totalFees),
      icon: Receipt,
      desc: t("tax.brokerAndMgmtFeesYear", { year: String(txYear) }),
      cls: "text-loss",
    },
    {
      title: t("tax.totalCosts"),
      value: fmt(totalTaxesAndFees),
      icon: TrendingDown,
      desc: t("tax.combinedTaxesAndFeesYear", { year: String(txYear) }),
      cls: "text-loss",
    },
    {
      title: t("tax.effectiveTaxRate"),
      value: `${effectiveTaxRate.toFixed(1)}%`,
      icon: AlertTriangle,
      desc: t("tax.onRealizedGains"),
      cls: effectiveTaxRate > 25 ? "text-loss" : "text-muted-foreground",
    },
    {
      title: t("tax.totalWithPIT"),
      value: fmt(portfolioTaxesPlusPIT),
      icon: Landmark,
      desc: t("tax.totalWithPITDesc"),
      cls: "text-primary",
    },
    {
      title: t("tax.manualAdjustments"),
      value: fmt(totalManualTaxes + totalManualFees),
      icon: SlidersHorizontal,
      desc: t("tax.manualAdjustmentsDescShort"),
      cls: "text-muted-foreground",
    },
  ];

  return <TaxSummaryCard cards={cards} />;
}
