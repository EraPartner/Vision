import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { MonthlyCostDatum } from "@/hooks/usePortfolioTaxData";
import { BarChart, type BarSeries } from "@/components/charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface YearlyCostTrendCardProps {
  data: MonthlyCostDatum[];
  txYear: number;
}

/** Monthly tax/fee trend chart of the portfolio-tax page ("yearlyTaxFeeTrend" widget). */
export function YearlyCostTrendCard({ data, txYear }: YearlyCostTrendCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.yearlyTaxFeeTrendTitle", { year: String(txYear) })}</CardTitle>
        <CardDescription>{t("tax.yearlyTaxFeeTrendDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <BarChart
          data={data}
          categoryAccessor={(d) => d.period}
          series={[
            { key: "taxes", label: t("tax.taxes"), accessor: (d) => d.taxes, color: "hsl(var(--chart-5))" },
            { key: "fees", label: t("tax.fees"), accessor: (d) => d.fees, color: "hsl(var(--chart-4))" },
          ] as BarSeries<MonthlyCostDatum>[]}
          height={280}
          valueTickFormat={(v) => fmt(v)}
          tooltipValueFormat={(v) => fmt(v)}
        />
      </CardContent>
    </Card>
  );
}
