import { TrendingUp, TrendingDown, DollarSign, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { cn } from "@/lib/utils";
import type { StatisticsData } from "@/hooks/useStatistics";

interface SummaryCardsProps {
  data: StatisticsData;
}

export function SummaryCards({ data }: SummaryCardsProps) {
  const { t } = useLanguage();
  const { formatCurrency } = useChartCurrencyFormatter();

  const cards = [
    {
      title: t("statsPage.totalIncome"),
      value: formatCurrency(data.totalIncome),
      icon: TrendingUp,
      description: t("statsPage.avgPerMonth", { amount: formatCurrency(data.averageMonthlyIncome) }),
      className: "text-accent",
    },
    {
      title: t("statsPage.totalSpending"),
      value: formatCurrency(data.totalSpending),
      icon: TrendingDown,
      description: t("statsPage.avgPerMonth", { amount: formatCurrency(data.averageMonthlySpending) }),
      className: "text-destructive",
    },
    {
      title: t("statsPage.netBalance"),
      value: formatCurrency(data.totalIncome - data.totalSpending),
      icon: DollarSign,
      description: t("statsPage.overMonths", { n: data.monthlyData.length }),
      className: data.totalIncome - data.totalSpending >= 0 ? "text-accent" : "text-destructive",
    },
    {
      title: t("statsPage.monthsTracked"),
      value: data.monthlyData.length.toString(),
      icon: BarChart3,
      description: t("statsPage.years", { n: data.allYears.length }),
      className: "text-primary",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-stagger">
      {cards.map((card) => (
        <Card key={card.title} className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
            <span className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md ring-1",
              card.className.includes("accent")
                ? "bg-gradient-to-br from-accent/20 to-accent/5 ring-accent/15"
                : card.className.includes("destructive")
                ? "bg-gradient-to-br from-destructive/20 to-destructive/5 ring-destructive/15"
                : "bg-gradient-to-br from-primary/20 to-primary/5 ring-primary/15"
            )}>
              <card.icon className={`h-4 w-4 ${card.className}`} />
            </span>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${card.className}`}>{card.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
