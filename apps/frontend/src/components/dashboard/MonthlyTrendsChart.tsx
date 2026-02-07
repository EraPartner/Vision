import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { TrendingUp } from "lucide-react";

interface MonthlyTrendsChartProps {
  data: Array<{
    month: number;
    year: number;
    period_start: string;
    period_end: string;
    total_spending: number;
    total_income: number;
    net_amount: number;
    transaction_count: number;
  }>;
}

export function MonthlyTrendsChart({ data }: MonthlyTrendsChartProps) {
  console.log("📈 MonthlyTrendsChart received data:", data);
  console.log("📈 Number of months in chart:", data.length);
  
  // Transform data for the chart
  const chartData = data.map((monthData) => {
    // Format as "Sep 25" -> just month name and 2-digit year
    const date = new Date(monthData.year, monthData.month - 1, 1);
    const monthName = date.toLocaleDateString("en-US", {
      month: "short"
    });
    const year = date.toLocaleDateString("en-US", {
      year: "2-digit"
    });

    return {
      month: `${monthName} ${year}`,
      income: monthData.total_income,
      spending: Math.abs(monthData.total_spending), // Convert negative to positive for display
      transactions: monthData.transaction_count,
    };
  });
  
  console.log("📈 Chart data after transformation:", chartData);

  const totalIncome = data.reduce((sum, m) => sum + m.total_income, 0);
  const totalSpending = Math.abs(data.reduce((sum, m) => sum + m.total_spending, 0));

  return (
    <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
      <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 flex items-center justify-center shadow-sm text-blue-600 dark:text-blue-400">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-xl">6-Month Trends</CardTitle>
            <CardDescription className="text-base">
              Income vs Spending over the last 6 months
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
            <defs>
              <linearGradient id="incomeGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(142 76% 36%)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="hsl(142 76% 36%)" stopOpacity={0.3} />
              </linearGradient>
              <linearGradient id="spendingGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(0 84% 60%)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="hsl(0 84% 60%)" stopOpacity={0.3} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" opacity={0.5} />
            <XAxis
              dataKey="month"
              className="text-xs"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              angle={-15}
              textAnchor="end"
              height={60}
            />
            <YAxis
              className="text-xs"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              tickFormatter={(value) => `€${value}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "12px",
                padding: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
              }}
              formatter={(value: number, name: string) => {
                const formattedValue = `€${value.toFixed(2)}`;
                const label = name === "income" ? "Income" : name === "spending" ? "Spending" : "Transactions";
                return [formattedValue, label];
              }}
              labelStyle={{ fontWeight: "600", marginBottom: "4px" }}
            />
            <Legend
              verticalAlign="top"
              height={36}
              iconType="square"
              formatter={(value) => (value === "income" ? "Income" : "Spending")}
            />
            <Bar dataKey="income" fill="url(#incomeGradient)" radius={[8, 8, 0, 0]} maxBarSize={40} />
            <Bar dataKey="spending" fill="url(#spendingGradient)" radius={[8, 8, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>

        {/* Summary Stats */}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <div className="w-3 h-3 rounded-full flex-shrink-0 bg-green-500"></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-green-700 dark:text-green-300">Total Income</p>
              <p className="text-sm font-bold text-green-900 dark:text-green-100">€{totalIncome.toFixed(2)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="w-3 h-3 rounded-full flex-shrink-0 bg-red-500"></div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-red-700 dark:text-red-300">Total Spending</p>
              <p className="text-sm font-bold text-red-900 dark:text-red-100">€{totalSpending.toFixed(2)}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
