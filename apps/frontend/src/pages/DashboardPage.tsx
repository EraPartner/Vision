import {StatCard} from "@/components/dashboard/StatCard";
import {MonthlyTrendsChart} from "@/components/dashboard/MonthlyTrendsChart";
import {CashFlowComparisonChart} from "@/components/dashboard/CashFlowComparisonChart";
import {CategoryPieChart} from "@/components/dashboard/CategoryPieChart";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {ArrowUpRight, DollarSign, Receipt, TrendingDown, Loader2} from "lucide-react";
import {useTransactions} from "@/hooks/useTransactions";
import {useFilteredDashboardStats} from "@/hooks/useFilteredDashboardStats";
import {useSettings} from "@/contexts/SettingsContext";
import {useQuery} from "@tanstack/react-query";
import {apiClient} from "@/lib/api";
import {getCategoryColor} from "@/utils/categoryColors";
import {formatCurrency} from "@/utils/currency";

export default function DashboardPage() {
    const { settings } = useSettings();
    
    // Fetch real-time statistics from /api/info endpoints with applied filters
    const { data: statsData, isLoading: statsLoading, error: statsError } = useFilteredDashboardStats();
    
    // Fetch transactions for charts and recent transactions table
    const { data: transactionsData, isLoading: transactionsLoading, error: transactionsError } = useTransactions({ limit: 50 });
    
    // Fetch monthly summary for chart (6 months)
    const { data: monthlySummary, isLoading: monthlyLoading } = useQuery({
        queryKey: ['monthlySummary'],
        queryFn: () => apiClient.getMonthlyFinancialSummary(),
        staleTime: 30000,
    });

    // Fetch cashflow comparison data
    const { data: cashflowData, isLoading: cashflowLoading } = useQuery({
        queryKey: ['cashflowComparison'],
        queryFn: () => apiClient.getCashflowComparison(),
        staleTime: 30000,
    });

    // Fetch categories if we need to exclude hidden ones
    const { data: categoriesData } = useQuery({
        queryKey: ['categories', 'all'],
        queryFn: () => apiClient.getCategories({ limit: 1000 }),
        staleTime: 60000,
    });

    const allTransactions = transactionsData?.items || [];
    
    // Apply settings filters to transactions
    const transactions = (() => {
        // Build hidden category IDs list if needed
        let hiddenCategoryIds: number[] = [];
        if (settings.excludeHiddenCategories && categoriesData) {
            hiddenCategoryIds = categoriesData.items
                .filter((cat) => !cat.active)
                .map((cat) => cat.id);
        }

        // Build complete exclusion list
        const excludedCategoryIds = new Set([
            ...settings.excludedCategoryIds,
            ...hiddenCategoryIds,
        ]);

        const excludedRecipientIds = new Set(settings.excludedRecipientIds);

        // Filter transactions
        return allTransactions.filter((t) => {
            // Exclude if category is in exclusion list
            if (t.category_id && excludedCategoryIds.has(t.category_id)) {
                return false;
            }
            
            // Exclude if recipient is in exclusion list
            if (t.recipient_id && excludedRecipientIds.has(t.recipient_id)) {
                return false;
            }
            
            return true;
        });
    })();
    
    // Use real-time statistics from API (last month with data)
    const totalTransactions = statsData?.totalTransactions ?? 0;
    const totalSpending = statsData?.monthlySpending ?? 0;
    const totalIncome = statsData?.monthlyIncome ?? 0;
    const netBalance = statsData?.netBalance ?? 0;

    // Use API monthly data for chart (all 6 months)
    const monthlyData = monthlySummary?.months || [];

    // Calculate category breakdown from transactions
    const categoryBreakdown = (() => {
        const categoryMap = new Map<string, { name: string; count: number }>();
        
        transactions.forEach(t => {
            const key = t.category_name || 'Uncategorized';
            const name = t.category_name || 'Uncategorized';
            
            if (categoryMap.has(key)) {
                categoryMap.get(key)!.count++;
            } else {
                categoryMap.set(key, { name, count: 1 });
            }
        });
        
        return Array.from(categoryMap.values());
    })();

    // Extract detail part from category names (after the colon) and show only top categories
    const categoryData = (() => {
        // Sort by count descending
        const sorted = [...categoryBreakdown].sort((a, b) => b.count - a.count);
        
        // Take top 5 categories
        const topCategories = sorted.slice(0, 5);
        
        // Sum up the rest as "Other"
        const otherCount = sorted.slice(7).reduce((sum, cat) => sum + cat.count, 0);
        
        // Extract detail part from category name (e.g., "FOOD:GROCERIES" -> "Groceries")
        const extractDetail = (categoryName: string): string => {
            if (categoryName === 'Uncategorized') return categoryName;
            
            const parts = categoryName.split(':');
            if (parts.length > 1) {
                // Get the detail part and format it nicely
                const detail = parts[1].trim();
                return detail.charAt(0) + detail.slice(1).toLowerCase();
            }
            // If no colon, just format the whole name nicely
            return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
        };
        
        const result = topCategories.map(cat => ({
            name: extractDetail(cat.name),
            value: cat.count
        }));
        
        // Add "Other" if there are more categories
        if (otherCount > 0) {
            result.push({
                name: 'Andere',
                value: otherCount
            });
        }
        
        return result;
    })();

    // Recent transactions data
    const recentTransactions = transactions.slice(0, 5).map(t => ({
        id: t.id,
        date: (t as any).date || t.transaction_date || '',
        description: t.memo || 'No description',
        amount: t.amount,
        currency: t.currency || 'EUR',
        category: t.category_name || 'Uncategorized',
        recipient: t.recipient_name || 'Unknown',
        bank: t.bank_account
    }));

    const columns = [
        {key: "date", header: "Date"},
        {key: "description", header: "Description"},
        {
            key: "category",
            header: "Category",
            render: (row: (typeof recentTransactions)[0]) => (
                <Badge variant="outline" className={`font-medium ${getCategoryColor(row.category)}`}>
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
                    {row.amount >= 0 ? "+" : ""}{formatCurrency(Math.abs(row.amount), row.currency)}
                </span>
            ),
        },
    ];

    if (statsLoading || transactionsLoading || monthlyLoading || cashflowLoading) {
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
                <StatCard title="Last Month Spending" value={formatCurrency(totalSpending, 'EUR')} icon={TrendingDown} trend="down"
                          subtitle="Most recent month"/>
                <StatCard title="Last Month Income" value={formatCurrency(totalIncome, 'EUR')} icon={ArrowUpRight} trend="up"
                          subtitle="Most recent month"/>
                <StatCard title="Last Month Net" value={formatCurrency(netBalance, 'EUR')} icon={DollarSign}
                          trend={netBalance >= 0 ? "up" : "down"}
                          subtitle={netBalance >= 0 ? "Positive cash flow" : "Negative cash flow"}/>
            </div>

            {/* Charts */}
            <div className="grid gap-6 lg:grid-cols-2">
                {monthlyData.length > 0 && <MonthlyTrendsChart data={monthlyData}/>}
                <CategoryPieChart data={categoryData}/>
            </div>

            {/* Cash Flow Comparison */}
            {cashflowData && (
                <CashFlowComparisonChart
                    withoutPlanned={cashflowData.without_planned}
                    withPlanned={cashflowData.with_planned}
                    currentDay={cashflowData.current_day}
                    month={cashflowData.month}
                    year={cashflowData.year}
                />
            )}

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