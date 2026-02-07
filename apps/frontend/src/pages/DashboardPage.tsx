import { StatCard } from "@/components/dashboard/StatCard";
import { MonthlySpendingChart } from "@/components/dashboard/MonthlySpendingChart";
import { CategoryPieChart } from "@/components/dashboard/CategoryPieChart";
import { DataTable } from "@/components/shared/DataTable";
import { Badge } from "@/components/ui/badge";
import { Receipt, DollarSign, TrendingDown, ArrowUpRight } from "lucide-react";

// Placeholder data – will be replaced with real API calls later
const recentTransactions = [
  { id: 1, date: "2026-02-07", description: "Grocery Store", amount: -82.45, category: "Groceries", recipient: "Whole Foods" },
  { id: 2, date: "2026-02-06", description: "Monthly Salary", amount: 4200.00, category: "Income", recipient: "Employer Inc." },
  { id: 3, date: "2026-02-05", description: "Electric Bill", amount: -124.30, category: "Utilities", recipient: "City Power" },
  { id: 4, date: "2026-02-04", description: "Restaurant Dinner", amount: -67.90, category: "Dining", recipient: "Olive Garden" },
  { id: 5, date: "2026-02-03", description: "Gas Station", amount: -45.00, category: "Transportation", recipient: "Shell" },
];

const categoryColor: Record<string, string> = {
  Groceries: "bg-primary/15 text-primary border-primary/30",
  Income: "bg-accent/15 text-accent border-accent/30",
  Utilities: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  Dining: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  Transportation: "bg-chart-4/15 text-chart-4 border-chart-4/30",
};

const columns = [
  { key: "date", header: "Date" },
  { key: "description", header: "Description" },
  {
    key: "category",
    header: "Category",
    render: (row: (typeof recentTransactions)[0]) => (
      <Badge variant="outline" className={`font-medium ${categoryColor[row.category] || ""}`}>
        {row.category}
      </Badge>
    ),
  },
  { key: "recipient", header: "Recipient" },
  {
    key: "amount",
    header: "Amount",
    className: "text-right",
    render: (row: (typeof recentTransactions)[0]) => (
      <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
        {row.amount >= 0 ? "+" : ""}€{Math.abs(row.amount).toFixed(2)}
      </span>
    ),
  },
];

export default function DashboardPage() {
  const totalTransactions = 1284;
  const totalSpending = 3245.67;
  const totalIncome = 4200.00;
  const netBalance = totalIncome - totalSpending;

  return (
    <div className="space-y-8 animate-in">
      {/* Page header */}
      <div>
        <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
        <p className="text-muted-foreground mt-1">Overview of your financial activity</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Transactions" value={totalTransactions.toLocaleString()} icon={Receipt} />
        <StatCard title="Total Spending" value={`€${totalSpending.toFixed(2)}`} icon={TrendingDown} trend="down" subtitle="-12% from last month" />
        <StatCard title="Total Income" value={`€${totalIncome.toFixed(2)}`} icon={ArrowUpRight} trend="up" subtitle="+3% from last month" />
        <StatCard title="Net Balance" value={`€${netBalance.toFixed(2)}`} icon={DollarSign} trend={netBalance >= 0 ? "up" : "down"} subtitle={netBalance >= 0 ? "Positive cash flow" : "Negative cash flow"} />
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <MonthlySpendingChart />
        <CategoryPieChart />
      </div>

      {/* Recent transactions */}
      <DataTable
        title="Recent Transactions"
        subtitle="Last 5 transactions"
        columns={columns}
        data={recentTransactions}
        emptyMessage="No transactions yet. Import a CSV to get started."
      />
    </div>
  );
}
