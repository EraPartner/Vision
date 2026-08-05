import { Landmark, TrendingUp, TrendingDown, PiggyBank } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { RollingNumber } from "@/components/shared/RollingNumber";
import type { BelgianTaxCalculation } from "@/lib/belgianTax";
import { TaxSummaryCard } from "@/pages/portfolio/tax/TaxSummaryCard";

interface TaxOverviewSummaryCardsProps {
  calculation: BelgianTaxCalculation;
  portfolioTaxesForYear: number;
  totalTaxIncludingPortfolio: number;
  totalTaxIncludingPropertyEstimate: number;
  viewedYear: number;
}

/** Summary stat cards of the budget-tax overview page ("summaryCards" widget). */
export function TaxOverviewSummaryCards({
  calculation,
  portfolioTaxesForYear,
  totalTaxIncludingPortfolio,
  totalTaxIncludingPropertyEstimate,
  viewedYear,
}: TaxOverviewSummaryCardsProps) {
  const { t } = useLanguage();
  // Parts formatter: same currency/locale/decimals resolution as the string
  // formatter it replaced, but the tiles keep the Money micro-typography.
  const fmtParts = useCurrencyPartsFormatter();

  const cards = [
    {
      title: t("tax.card.profileGrossIncome"),
      value: <RollingNumber parts={fmtParts(calculation.grossIncome)} />,
      icon: TrendingUp,
      desc: t("tax.card.profileGrossIncome.desc"),
      cls: "text-gain",
    },
    {
      title: t("tax.card.totalPIT"),
      value: <RollingNumber parts={fmtParts(calculation.totalPIT)} />,
      icon: Landmark,
      desc: t("tax.card.totalPIT.desc",),
      cls: "text-loss",
    },
    {
      title: t("tax.card.netTakeHome"),
      value: <RollingNumber parts={fmtParts(calculation.netTakeHome)} />,
      icon: TrendingDown,
      desc: t("tax.card.netTakeHome.desc"),
      cls: calculation.netTakeHome >= 0 ? "amount-gain" : "amount-loss",
    },
    {
      title: t("tax.card.monthlyTaxReserve"),
      value: <RollingNumber parts={fmtParts(calculation.monthlyTaxReserve)} />,
      icon: PiggyBank,
      desc: t("tax.card.monthlyTaxReserve.desc"),
      cls: "text-primary",
    },
    {
      title: t("tax.card.portfolioTaxesYear", { year: String(viewedYear) }),
      value: <RollingNumber parts={fmtParts(portfolioTaxesForYear)} />,
      icon: Landmark,
      desc: t("tax.card.portfolioTaxesYear.desc"),
      cls: "text-loss",
    },
    {
      title: t("tax.card.totalWithPortfolio"),
      value: <RollingNumber parts={fmtParts(totalTaxIncludingPortfolio)} />,
      icon: Landmark,
      desc: t("tax.card.totalWithPortfolio.desc"),
      cls: "text-primary",
    },
    {
      title: t("tax.card.totalWithPropertyEstimate", { year: String(viewedYear) }),
      value: <RollingNumber parts={fmtParts(totalTaxIncludingPropertyEstimate)} />,
      icon: Landmark,
      desc: t("tax.card.totalWithPropertyEstimate.desc"),
      cls: "text-primary",
    },
  ];

  return <TaxSummaryCard cards={cards} />;
}
