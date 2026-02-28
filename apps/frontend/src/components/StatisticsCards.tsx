/**
 * Statistics cards component for dashboard overview
 */

import {Activity, TrendingDown, TrendingUp, Wallet} from 'lucide-react';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import type {StatisticsResponse} from '@/types/api';

interface StatisticsCardsProps {
    statistics: StatisticsResponse;
}

export function StatisticsCards({statistics}: StatisticsCardsProps) {
    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'EUR',
        }).format(amount);
    };

    const totalIncome = statistics.categories
        .filter((cat) => cat.total_amount > 0)
        .reduce((sum, cat) => sum + cat.total_amount, 0);

    const totalExpenses = Math.abs(
        statistics.categories
            .filter((cat) => cat.total_amount < 0)
            .reduce((sum, cat) => sum + cat.total_amount, 0)
    );

    return (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {/* Total Transactions Card */}
            <Card
                className="relative overflow-hidden border-none bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"/>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-blue-100">Total Transactions</CardTitle>
                    <div className="p-2 bg-white/20 rounded-lg backdrop-blur-sm">
                        <Activity className="h-5 w-5 text-white"/>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="text-3xl font-bold mb-1">
                        {statistics.total_transactions.toLocaleString()}
                    </div>
                    <p className="text-xs text-blue-100 flex items-center gap-1">
                        <span className="inline-block w-1 h-1 bg-blue-200 rounded-full"/>
                        Across {statistics.categories.length} categories
                    </p>
                </CardContent>
            </Card>

            {/* Net Balance Card */}
            <Card
                className={`relative overflow-hidden border-none shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105 ${
                    statistics.total_amount >= 0
                        ? 'bg-gradient-to-br from-emerald-500 to-emerald-600'
                        : 'bg-gradient-to-br from-rose-500 to-rose-600'
                } text-white`}>
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"/>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-white/90">Net Balance</CardTitle>
                    <div className="p-2 bg-white/20 rounded-lg backdrop-blur-sm">
                        <Wallet className="h-5 w-5 text-white"/>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="text-3xl font-bold mb-1">
                        {formatCurrency(statistics.total_amount)}
                    </div>
                    <p className="text-xs text-white/80 flex items-center gap-1">
                        <span className="inline-block w-1 h-1 bg-white/60 rounded-full"/>
                        {statistics.total_amount >= 0 ? 'Positive' : 'Negative'} cash flow
                    </p>
                </CardContent>
            </Card>

            {/* Total Income Card */}
            <Card
                className="relative overflow-hidden border-none bg-gradient-to-br from-green-500 to-green-600 text-white shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"/>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-green-100">Total Income</CardTitle>
                    <div className="p-2 bg-white/20 rounded-lg backdrop-blur-sm">
                        <TrendingUp className="h-5 w-5 text-white"/>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="text-3xl font-bold mb-1">
                        {formatCurrency(totalIncome)}
                    </div>
                    <p className="text-xs text-green-100 flex items-center gap-1">
                        <span className="inline-block w-1 h-1 bg-green-200 rounded-full"/>
                        Incoming transactions
                    </p>
                </CardContent>
            </Card>

            {/* Total Expenses Card */}
            <Card
                className="relative overflow-hidden border-none bg-gradient-to-br from-red-500 to-red-600 text-white shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16"/>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    {/* Use a slightly brighter red in dark mode for better contrast */}
                    <CardTitle className="text-sm font-medium text-red-100 dark:text-red-200">Total Expenses</CardTitle>
                    <div className="p-2 bg-white/20 rounded-lg backdrop-blur-sm">
                        <TrendingDown className="h-5 w-5 text-white"/>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="text-3xl font-bold mb-1">
                        {formatCurrency(totalExpenses)}
                    </div>
                    <p className="text-xs text-red-100 dark:text-red-200 flex items-center gap-1">
                        <span className="inline-block w-1 h-1 bg-red-200 dark:bg-red-400 rounded-full"/>
                        Outgoing transactions
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}