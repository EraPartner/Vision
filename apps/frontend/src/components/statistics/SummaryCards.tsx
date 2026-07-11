import { TrendingUp, TrendingDown, DollarSign, BarChart3 } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { StatisticsData } from "@/hooks/useStatistics";

interface SummaryCardsProps {
  data: StatisticsData;
}

export function SummaryCards({ data }: SummaryCardsProps) {
  const { t } = useLanguage();
  const { formatCompact } = useChartCurrencyFormatter();

  const net = data.totalIncome - data.totalSpending;
  const incomeCompact = formatCompact(data.totalIncome);
  const spendingCompact = formatCompact(data.totalSpending);
  const netCompact = formatCompact(net);
  const avgIncomeCompact = formatCompact(data.averageMonthlyIncome);
  const avgSpendingCompact = formatCompact(data.averageMonthlySpending);

  const cards = [
    {
      title: t("statsPage.totalIncome"),
      value: incomeCompact.display,
      fullValue: incomeCompact.isCompact ? incomeCompact.full : undefined,
      icon: TrendingUp,
      description: t("statsPage.avgPerMonth", { amount: avgIncomeCompact.display }),
      className: "text-gain",
      trend: "income" as const,
    },
    {
      title: t("statsPage.totalSpending"),
      value: spendingCompact.display,
      fullValue: spendingCompact.isCompact ? spendingCompact.full : undefined,
      icon: TrendingDown,
      description: t("statsPage.avgPerMonth", { amount: avgSpendingCompact.display }),
      className: "text-loss",
      trend: "expense" as const,
    },
    {
      title: t("statsPage.netBalance"),
      value: netCompact.display,
      fullValue: netCompact.isCompact ? netCompact.full : undefined,
      icon: DollarSign,
      description: t("statsPage.overMonths", { n: data.monthlyData.length }),
      className: net >= 0 ? "amount-gain" : "amount-loss",
      trend: net >= 0 ? ("income" as const) : ("expense" as const),
    },
    {
      title: t("statsPage.monthsTracked"),
      value: data.monthlyData.length.toString(),
      fullValue: undefined as string | undefined,
      icon: BarChart3,
      description: t("statsPage.years", { n: data.allYears.length }),
      className: "text-primary",
      trend: "neutral" as const,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-stagger">
      {cards.map((card) => (
        <StatCard
          key={card.title}
          title={card.title}
          value={card.value}
          titleValue={card.fullValue}
          icon={card.icon}
          trend={card.trend}
          valueClassName={card.className}
          subtitle={card.description}
        />
      ))}
    </div>
  );
}
