import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { StatisticsData } from "@/hooks/useStatistics";
import { cn } from "@/lib/utils";
import { CompactValueDisclosure } from "@/components/shared/TouchDisclosure";

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
                                <tr
                                    key={y.year}
                                    className="border-b border-border/50 hover:bg-muted/50"
                                >
                                    <td className="py-2 px-3 font-medium">
                                        {y.year}
                                    </td>
                                    <td className="text-right py-2 px-3 text-gain tabular-nums">
                                        <CompactValueDisclosure
                                            display={incomeR.display}
                                            fullValue={
                                                incomeR.isCompact
                                                    ? incomeR.full
                                                    : undefined
                                            }
                                        />
                                    </td>
                                    <td className="text-right py-2 px-3 text-loss tabular-nums">
                                        <CompactValueDisclosure
                                            display={spendingR.display}
                                            fullValue={
                                                spendingR.isCompact
                                                    ? spendingR.full
                                                    : undefined
                                            }
                                        />
                                    </td>
                                    <td
                                        className={cn(
                                            "text-right py-2 px-3 font-bold tabular-nums",
                                            y.net >= 0
                                                ? "text-gain"
                                                : "text-loss",
                                        )}
                                    >
                                        <CompactValueDisclosure
                                            display={netR.display}
                                            fullValue={
                                                netR.isCompact
                                                    ? netR.full
                                                    : undefined
                                            }
                                        />
                                    </td>
                                    <td className="text-right py-2 px-3 tabular-nums">
                                        {new Intl.NumberFormat(locale).format(
                                            y.transactionCount,
                                        )}
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
