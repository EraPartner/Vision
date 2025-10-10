import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/dashboard/StatCard";
import { TransactionsTable } from "@/components/dashboard/TransactionsTable";
import { CSVImport } from "@/components/dashboard/CSVImport";
import { SpendingChart } from "@/components/dashboard/SpendingChart";
import { TrendingUp, DollarSign, Calendar, ArrowUpRight, LogOut } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

export default function Dashboard() {
  const navigate = useNavigate();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTransactions = async () => {
    try {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .order("transaction_date", { ascending: false });

      if (error) throw error;
      setTransactions(data || []);
    } catch (error: any) {
      toast.error("Failed to load transactions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTransactions();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

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

  const totalThisMonth = thisMonthTransactions.reduce((sum, t) => sum + parseFloat(t.amount), 0);
  const totalLastMonth = lastMonthTransactions.reduce((sum, t) => sum + parseFloat(t.amount), 0);
  const monthlyChange = totalLastMonth !== 0 
    ? ((totalThisMonth - totalLastMonth) / Math.abs(totalLastMonth)) * 100 
    : 0;

  const spendingByCategory = transactions
    .filter((t) => parseFloat(t.amount) < 0)
    .reduce((acc: any, t) => {
      const category = t.category;
      acc[category] = (acc[category] || 0) + Math.abs(parseFloat(t.amount));
      return acc;
    }, {});

  const chartData = Object.entries(spendingByCategory).map(([category, amount]) => ({
    category,
    amount: amount as number,
  }));

  const totalSpending = Math.abs(transactions
    .filter((t) => parseFloat(t.amount) < 0)
    .reduce((sum, t) => sum + parseFloat(t.amount), 0));

  const totalIncome = transactions
    .filter((t) => parseFloat(t.amount) > 0)
    .reduce((sum, t) => sum + parseFloat(t.amount), 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center">
              <TrendingUp className="h-4 w-4 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold">Finance Tracker</h1>
          </div>
          <Button variant="ghost" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-8">
        <div>
          <h2 className="text-3xl font-bold mb-2">Dashboard</h2>
          <p className="text-muted-foreground">Track your spending and manage your finances</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Spending"
            value={`$${totalSpending.toFixed(2)}`}
            icon={DollarSign}
          />
          <StatCard
            title="Total Income"
            value={`$${totalIncome.toFixed(2)}`}
            icon={ArrowUpRight}
          />
          <StatCard
            title="This Month"
            value={`$${Math.abs(totalThisMonth).toFixed(2)}`}
            change={`${monthlyChange > 0 ? '+' : ''}${monthlyChange.toFixed(1)}% from last month`}
            changeType={monthlyChange > 0 ? "negative" : "positive"}
            icon={Calendar}
          />
          <StatCard
            title="Transactions"
            value={transactions.length.toString()}
            icon={TrendingUp}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <CSVImport onImportComplete={fetchTransactions} />
          {chartData.length > 0 && <SpendingChart data={chartData} />}
        </div>

        <div>
          <h3 className="text-xl font-bold mb-4">Recent Transactions</h3>
          <TransactionsTable transactions={transactions.slice(0, 10)} />
        </div>
      </main>
    </div>
  );
}