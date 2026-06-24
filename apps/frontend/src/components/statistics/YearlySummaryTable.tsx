import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { StatisticsData } from "@/hooks/useStatistics";

interface YearlySummaryTableProps {
  data: StatisticsData;
}

export function YearlySummaryTable({ data }: YearlySummaryTableProps) {
  const { t } = useLanguage();
  const { formatCompact, locale } = useChartCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("statsPage.yearly.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-3 font-medium text-muted-foreground">
                {t("statsPage.yearly.year")}
              </th>
              <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                {t("statsPage.yearly.income")}
              </th>
              <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                {t("statsPage.yearly.spending")}
              </th>
              <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                {t("statsPage.yearly.net")}
              </th>
              <th className="text-right py-2 px-3 font-medium text-muted-foreground">
                {t("statsPage.yearly.transactions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.yearlyComparison.map((y) => {
              const incomeR = formatCompact(y.totalIncome);
              const spendingR = formatCompact(y.totalSpending);
              const netR = formatCompact(y.net);
              return (
                <tr key={y.year} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-2 px-3 font-medium">{y.year}</td>
                  <td className="text-right py-2 px-3 text-gain tabular-nums">
                    <span title={incomeR.isCompact ? incomeR.full : undefined}>{incomeR.display}</span>
                  </td>
                  <td className="text-right py-2 px-3 text-loss tabular-nums">
                    <span title={spendingR.isCompact ? spendingR.full : undefined}>{spendingR.display}</span>
                  </td>
                  <td
                    className={`text-right py-2 px-3 font-bold tabular-nums ${
                      y.net >= 0 ? "amount-gain" : "amount-loss"
                    }`}
                  >
                    <span title={netR.isCompact ? netR.full : undefined}>{netR.display}</span>
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {new Intl.NumberFormat(locale).format(y.transactionCount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
