import { Info } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { YearlyIncomeDatum } from "@/hooks/useTaxOverviewData";
import { BarChart, type BarSeries } from "@/components/charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { IncomeSourcesEmptyState } from "@/components/tax/IncomeSourcesEmptyState";

interface YearlyTaxChartCardProps {
  data: YearlyIncomeDatum[];
  isLoading: boolean;
  hasIncomeSources: boolean;
  viewedYear: number;
}

/** Yearly net-vs-PIT chart of the overview page ("yearlyOverview" widget). */
export function YearlyTaxChartCard({ data, isLoading, hasIncomeSources, viewedYear }: YearlyTaxChartCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card className="glass-regular">
      <CardHeader>
         <CardTitle>{t('tax.yearly.title')}</CardTitle>
         <CardDescription>{t('tax.yearly.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SectionLoader />
        ) : !hasIncomeSources ? (
          <IncomeSourcesEmptyState viewedYear={viewedYear} />
        ) : data.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-10">
            {t('tax.incomeBreakdown.noData')}
          </p>
        ) : (
          <>
            <BarChart
              data={data}
              categoryAccessor={(d) => d.year}
              height={300}
              valueTickFormat={(v) => fmt(v)}
              tooltipValueFormat={(v) => fmt(v)}
              series={[
                { key: "netAfterTax", label: t('tax.chart.netAfterTax'), accessor: (d) => d.netAfterTax, color: "hsl(var(--primary))" },
                { key: "estimatedTax", label: t('tax.chart.pit'), accessor: (d) => d.estimatedTax, color: "hsl(var(--chart-5))" },
              ] as BarSeries<YearlyIncomeDatum>[]}
            />
            {data.some((y) => y.isApproximated) && (
              <p className="text-[11px] text-muted-foreground mt-2 flex items-start gap-1.5">
                <Info className="h-3 w-3 mt-0.5 shrink-0" />
                {t('tax.yearly.approximatedNote')}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
