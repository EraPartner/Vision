import { useEffect, useState } from "react";
import { apiClient, type Transaction } from "@/lib/api";
import { StatCard } from "@/components/dashboard/StatCard";
import { TransactionsTable } from "@/components/dashboard/TransactionsTable";
import { CSVImport } from "@/components/dashboard/CSVImport";
import { SpendingChart } from "@/components/dashboard/SpendingChart";
import { TrendingUp, DollarSign, Calendar, ArrowUpRight, Wallet, Sparkles } from "lucide-react";
import { toast } from "sonner";

export default function Dashboard() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

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

  // Calculate statistics
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  
  const thisMonthTransactions = transactions.filter((t) => {
    const date = new Date(t.transaction_date);
    return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
  });

  const lastMonthTransactions = transactions.filter((t) => {
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

  const spendingByCategory = transactions
    .filter((t) => t.amount < 0)
    .reduce((acc: any, t) => {
      const category = t.category;
      acc[category] = (acc[category] || 0) + Math.abs(t.amount);
      return acc;
    }, {});

  const chartData = Object.entries(spendingByCategory).map(([category, amount]) => ({
    category,
    amount: amount as number,
  }));

  const totalSpending = Math.abs(transactions
    .filter((t) => t.amount < 0)
    .reduce((sum, t) => sum + t.amount, 0));

  const totalIncome = transactions
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

      <main className="container mx-auto px-6 py-10 space-y-10">
        {/* Hero Section */}
        <div className="animate-in">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-1 w-12 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-full"></div>
            <span className="text-sm font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">Overview</span>
          </div>
          <h2 className="text-4xl font-bold mb-3 bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
            Financial Dashboard
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl">
            Track your spending, manage your finances, and gain insights into your financial health
          </p>
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

        {/* Enhanced Content Grid */}
        <div className="grid gap-8 lg:grid-cols-2 animate-in">
          <CSVImport onImportComplete={fetchTransactions} />
          {chartData.length > 0 && <SpendingChart data={chartData} />}
        </div>

        {/* Enhanced Transactions Section */}
        <div className="animate-in">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-2xl font-bold mb-1">Recent Transactions</h3>
              <p className="text-sm text-muted-foreground">
                Your latest financial activity
              </p>
            </div>
          </div>
          <TransactionsTable 
            transactions={transactions.slice(0, 10)} 
            onTransactionDeleted={fetchTransactions}
          />
        </div>

        {/* Empty State */}
        {transactions.length === 0 && !loading && (
          <div className="text-center py-16 animate-in">
            <div className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/10 to-indigo-500/10 mb-6">
              <TrendingUp className="h-10 w-10 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No transactions yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              Get started by importing your first CSV file from your bank. We'll automatically categorize and analyze your spending.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}