import {StatCard} from "@/components/dashboard/StatCard";
import {MonthlyTrendsChart} from "@/components/dashboard/MonthlyTrendsChart";
import {CategoryPieChart} from "@/components/dashboard/CategoryPieChart";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {ArrowUpRight, DollarSign, Receipt, TrendingDown, Loader2} from "lucide-react";
import {useTransactions} from "@/hooks/useTransactions";
import {useDashboardStats} from "@/hooks/useDashboardStats";
import {useQuery} from "@tanstack/react-query";
import {apiClient} from "@/lib/api";

export default function DashboardPage() {
    // Fetch real-time statistics from /api/info endpoints
    const { data: statsData, isLoading: statsLoading, error: statsError } = useDashboardStats();
    
    // Fetch transactions for charts and recent transactions table
    const { data: transactionsData, isLoading: transactionsLoading, error: transactionsError } = useTransactions({ limit: 50 });
    
    // Fetch monthly summary for chart (6 months)
    const { data: monthlySummary, isLoading: monthlyLoading } = useQuery({
        queryKey: ['monthlySummary'],
        queryFn: () => apiClient.getMonthlyFinancialSummary(),
        staleTime: 30000,
    });

    const transactions = transactionsData?.items || [];
    
    // Use real-time statistics from API (last month with data)
    const totalTransactions = statsData?.totalTransactions ?? 0;
    const totalSpending = statsData?.monthlySpending ?? 0;
    const totalIncome = statsData?.monthlyIncome ?? 0;
    const netBalance = statsData?.netBalance ?? 0;

    // Use API monthly data for chart (all 6 months)
    const monthlyData = monthlySummary?.months || [];

    // Calculate category breakdown from transactions
    const categoryBreakdown = (() => {
        const categoryMap = new Map<number | string, { name: string; count: number }>();
        
        transactions.forEach(t => {
            const key = t.category_id || 'uncategorized';
            const name = t.category_id ? `Category ${t.category_id}` : 'Uncategorized';
            
            if (categoryMap.has(key)) {
                categoryMap.get(key)!.count++;
            } else {
                categoryMap.set(key, { name, count: 1 });
            }
        });
        
        return Array.from(categoryMap.values());
    })();

    // Prepare category data for pie chart
    const categoryData = categoryBreakdown.map(cat => ({
        name: cat.name,
        value: cat.count
    }));

    // Recent transactions data
    const recentTransactions = transactions.slice(0, 5).map(t => ({
        id: t.id,
        date: t.transaction_date,
        description: t.memo || 'No description',
        amount: t.amount,
        category: t.category_id ? `Category ${t.category_id}` : 'Uncategorized',
        recipient: t.recipient_id ? `Recipient ${t.recipient_id}` : 'Unknown',
        bank: t.bank_account
    }));

    const categoryColor: Record<string, string> = {
        Groceries: "bg-primary/15 text-primary border-primary/30",
        Income: "bg-accent/15 text-accent border-accent/30",
        Utilities: "bg-chart-3/15 text-chart-3 border-chart-3/30",
        Dining: "bg-chart-5/15 text-chart-5 border-chart-5/30",
        Transportation: "bg-chart-4/15 text-chart-4 border-chart-4/30",
    };

    const columns = [
        {key: "date", header: "Date"},
        {key: "description", header: "Description"},
        {
            key: "category",
            header: "Category",
            render: (row: (typeof recentTransactions)[0]) => (
                <Badge variant="outline" className={`font-medium ${categoryColor[row.category] || ""}`}>
                    {row.category}
                </Badge>
            ),
        },
        {key: "recipient", header: "Recipient"},
        {
            key: "amount",
            header: "Amount",
            className: "text-right",
            render: (row: (typeof recentTransactions)[0]) => (
                <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
            {row.amount >= 0 ? "+" : ""}${Math.abs(row.amount).toFixed(2)}
          </span>
            ),
        },
    ];

    if (statsLoading || transactionsLoading || monthlyLoading) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
                    <p className="text-muted-foreground mt-1">Loading your financial data...</p>
                </div>
                <div className="flex items-center justify-center h-96">
                    <Loader2 className="h-8 w-8 animate-spin text-primary"/>
                </div>
            </div>
        );
    }

    if (statsError || transactionsError) {
        const errorMessage = statsError?.message || transactionsError?.message || 'Unknown error';
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
                    <p className="text-destructive mt-1">Error loading data: {errorMessage}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in">
            {/* Page header */}
            <div>
                <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
                <p className="text-muted-foreground mt-1">Overview of your financial activity</p>
            </div>

            {/* Stats */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Total Transactions" value={totalTransactions.toLocaleString()} icon={Receipt}/>
                <StatCard title="Last Month Spending" value={`$${totalSpending.toFixed(2)}`} icon={TrendingDown} trend="down"
                          subtitle="Most recent month"/>
                <StatCard title="Last Month Income" value={`$${totalIncome.toFixed(2)}`} icon={ArrowUpRight} trend="up"
                          subtitle="Most recent month"/>
                <StatCard title="Last Month Net" value={`$${netBalance.toFixed(2)}`} icon={DollarSign}
                          trend={netBalance >= 0 ? "up" : "down"}
                          subtitle={netBalance >= 0 ? "Positive cash flow" : "Negative cash flow"}/>
            </div>

            {/* Charts */}
            <div className="grid gap-6 lg:grid-cols-2">
                {monthlyData.length > 0 && <MonthlyTrendsChart data={monthlyData}/>}
                <CategoryPieChart data={categoryData}/>
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