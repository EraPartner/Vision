import { useEffect, useState } from "react";
import { apiClient, type Transaction } from "@/lib/api";
import { StatCard } from "@/components/dashboard/StatCard";
import { TransactionsTable } from "@/components/dashboard/TransactionsTable";
import { CSVImport } from "@/components/dashboard/CSVImport";
import { SpendingChart } from "@/components/dashboard/SpendingChart";
import { DateRangeFilter } from "@/components/dashboard/DateRangeFilter";
import { CategoryBreakdown } from "@/components/dashboard/CategoryBreakdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TrendingUp, DollarSign, Calendar, ArrowUpRight, Wallet, Sparkles, BarChart3 } from "lucide-react";
import { toast } from "sonner";

export default function Dashboard() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStartDate, setFilterStartDate] = useState<Date | null>(null);
  const [filterEndDate, setFilterEndDate] = useState<Date | null>(null);

  const fetchTransactions = async () => {
    try {
      const data = await apiClient.getTransactions();
      setTransactions(data);
    } catch (error: any) {
      toast.error("Failed to load transactions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTransactions();
  }, []);

  // Filter transactions by date range
  const filteredTransactions = transactions.filter((t) => {
    const date = new Date(t.transaction_date);
    if (filterStartDate && date < filterStartDate) return false;
    if (filterEndDate && date > filterEndDate) return false;
    return true;
  });

  // Calculate statistics
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  
  const thisMonthTransactions = filteredTransactions.filter((t) => {
    const date = new Date(t.transaction_date);
    return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
  });

  const lastMonthTransactions = filteredTransactions.filter((t) => {
    const date = new Date(t.transaction_date);
    const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    return date.getMonth() === lastMonth && date.getFullYear() === lastMonthYear;
  });

  const totalThisMonth = thisMonthTransactions.reduce((sum, t) => sum + t.amount, 0);
  const totalLastMonth = lastMonthTransactions.reduce((sum, t) => sum + t.amount, 0);
  const monthlyChange = totalLastMonth !== 0 
    ? ((totalThisMonth - totalLastMonth) / Math.abs(totalLastMonth)) * 100 
    : 0;

  const spendingByCategory = filteredTransactions
    .filter((t) => t.amount < 0)
    .reduce((acc: any, t) => {
      const category = t.category;
      acc[category] = (acc[category] || 0) + Math.abs(t.amount);
      return acc;
    }, {});

  const categoryBreakdown = Object.entries(spendingByCategory).map(([category, amount]) => ({
    category,
    amount: amount as number,
    count: filteredTransactions.filter((t) => t.category === category && t.amount < 0).length,
  }));

  const chartData = Object.entries(spendingByCategory).map(([category, amount]) => ({
    category,
    amount: amount as number,
  }));

  const totalSpending = Math.abs(filteredTransactions
    .filter((t) => t.amount < 0)
    .reduce((sum, t) => sum + t.amount, 0));

  const totalIncome = filteredTransactions
    .filter((t) => t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);

  const netBalance = totalIncome - totalSpending;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* Enhanced Header with gradient */}
      <header className="border-b bg-white/80 backdrop-blur-lg dark:bg-slate-900/80 sticky top-0 z-50 shadow-sm">
        <div className="container mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30 transform transition-transform hover:scale-105">
              <Wallet className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
                Vault Voyager
              </h1>
              <p className="text-xs text-muted-foreground">Your Financial Command Center</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-blue-500/10 to-indigo-500/10 border border-blue-200/50 dark:border-blue-800/50">
              <Sparkles className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                {transactions.length} Transactions Tracked
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-10 space-y-8">
        {/* Hero Section */}
        <div className="animate-in">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-1 w-12 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-full"></div>
            <span className="text-sm font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">Dashboard</span>
          </div>
          <h2 className="text-4xl font-bold mb-3 bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
            Financial Overview
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl">
            Track, analyze, and optimize your spending habits with powerful insights
          </p>
        </div>

        {/* Date Range Filter */}
        <div className="animate-in">
          <DateRangeFilter 
            onFilterChange={(start, end) => {
              setFilterStartDate(start);
              setFilterEndDate(end);
            }}
          />
        </div>

        {/* Enhanced Stats Grid */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 animate-in">
          <StatCard
            title="Total Spending"
            value={`$${totalSpending.toFixed(2)}`}
            icon={DollarSign}
            trend="expense"
          />
          <StatCard
            title="Total Income"
            value={`$${totalIncome.toFixed(2)}`}
            icon={ArrowUpRight}
            trend="income"
          />
          <StatCard
            title="Net Balance"
            value={`$${netBalance.toFixed(2)}`}
            change={`${netBalance >= 0 ? 'Positive' : 'Negative'} cash flow`}
            changeType={netBalance >= 0 ? "positive" : "negative"}
            icon={Wallet}
            trend={netBalance >= 0 ? "income" : "expense"}
          />
          <StatCard
            title="This Month"
            value={`$${Math.abs(totalThisMonth).toFixed(2)}`}
            change={`${monthlyChange > 0 ? '+' : ''}${monthlyChange.toFixed(1)}% from last month`}
            changeType={monthlyChange > 0 ? "negative" : "positive"}
            icon={Calendar}
          />
        </div>

        {/* Tabbed Content */}
        <Tabs defaultValue="overview" className="animate-in">
          <TabsList className="grid w-full grid-cols-3 mb-8">
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="analytics" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Analytics
            </TabsTrigger>
            <TabsTrigger value="transactions" className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              All Transactions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-8">
            <div className="grid gap-8 lg:grid-cols-2">
              <CSVImport onImportComplete={fetchTransactions} />
              {chartData.length > 0 && <SpendingChart data={chartData} />}
            </div>
            
            {/* Recent Transactions */}
            <div>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-2xl font-bold mb-1">Recent Transactions</h3>
                  <p className="text-sm text-muted-foreground">
                    Last 20 imported transactions
                  </p>
                </div>
              </div>
              <TransactionsTable 
                transactions={filteredTransactions.slice(0, 20)} 
                onTransactionDeleted={fetchTransactions}
              />
            </div>
          </TabsContent>

          <TabsContent value="analytics" className="space-y-8">
            <div className="grid gap-8 lg:grid-cols-2">
              {chartData.length > 0 && <SpendingChart data={chartData} />}
              {categoryBreakdown.length > 0 && <CategoryBreakdown data={categoryBreakdown} />}
            </div>
          </TabsContent>

          <TabsContent value="transactions" className="space-y-6">
            <div>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-2xl font-bold mb-1">All Transactions</h3>
                  <p className="text-sm text-muted-foreground">
                    Complete transaction history {filterStartDate || filterEndDate ? '(filtered)' : ''}
                  </p>
                </div>
              </div>
              <TransactionsTable 
                transactions={filteredTransactions} 
                onTransactionDeleted={fetchTransactions}
              />
            </div>
          </TabsContent>
        </Tabs>

        {/* Empty State */}
        {transactions.length === 0 && !loading && (
          <div className="text-center py-20 animate-in">
            <div className="inline-flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/10 to-indigo-500/10 mb-8">
              <TrendingUp className="h-12 w-12 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-2xl font-semibold mb-3">No transactions yet</h3>
            <p className="text-muted-foreground mb-8 max-w-md mx-auto text-lg">
              Get started by importing your first CSV file from your bank. We'll automatically categorize and analyze your spending.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}