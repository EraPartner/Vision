import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";

interface CategoryBreakdownProps {
  data: Array<{
    category: string;
    amount: number;
    count: number;
  }>;
}

export function CategoryBreakdown({ data }: CategoryBreakdownProps) {
  const sortedData = [...data].sort((a, b) => b.amount - a.amount);
  const totalAmount = sortedData.reduce((sum, item) => sum + item.amount, 0);

  return (
    <Card className="border-none shadow-xl bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-800 hover:shadow-2xl transition-shadow duration-300">
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center shadow-lg shadow-orange-500/30">
            <BarChart3 className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-xl">Category Breakdown</CardTitle>
            <CardDescription className="text-base">
              Spending by category with transaction counts
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {sortedData.map((item, index) => {
            const percentage = totalAmount > 0 ? (item.amount / totalAmount) * 100 : 0;

            return (
              <div key={item.category} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize">{item.category}</span>
                    <span className="text-xs text-muted-foreground">({item.count} transactions)</span>
                  </div>
                  <span className="text-sm font-bold">${item.amount.toFixed(2)}</span>
                </div>
                <div className="relative h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="absolute top-0 left-0 h-full bg-gradient-to-r from-orange-500 to-red-600 transition-all duration-500"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
                <div className="flex justify-end">
                  <span className="text-xs text-muted-foreground">{percentage.toFixed(1)}%</span>
                </div>
              </div>
            );
          })}

          {sortedData.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No category data available
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
