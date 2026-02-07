/**
 * Category breakdown chart component
 */

import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import type {CategoryStats} from '@/types/api';
import {TrendingUp} from 'lucide-react';

interface CategoryChartProps {
    categories: CategoryStats[];
    title?: string;
    description?: string;
}

const COLORS = [
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#ec4899', // pink
    '#f59e0b', // amber
    '#10b981', // emerald
    '#06b6d4', // cyan
    '#f97316', // orange
    '#6366f1', // indigo
];

export function CategoryChart({
                                  categories,
                                  title = 'Spending by Category',
                                  description = 'Top categories by transaction volume',
                              }: CategoryChartProps) {
    const sortedCategories = [...categories]
        .sort((a, b) => Math.abs(b.total_amount) - Math.abs(a.total_amount))
        .slice(0, 8)
        .map((cat) => ({
            name: cat.category_general,
            amount: Math.abs(cat.total_amount),
            transactions: cat.transaction_count,
            fullName: `${cat.category_general} - ${cat.category_detail}`,
        }));

    const formatCurrency = (value: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'EUR',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
        }).format(value);
    };

    const CustomTooltip = ({active, payload}: any) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload;
            return (
                <div className="bg-white/95 backdrop-blur-sm p-4 border-2 border-gray-100 rounded-xl shadow-2xl">
                    <p className="font-bold text-base mb-2 text-gray-900">{data.fullName}</p>
                    <div className="space-y-1">
                        <p className="text-sm text-gray-600 flex items-center justify-between gap-4">
                            <span>Amount:</span>
                            <span className="font-semibold text-blue-600">{formatCurrency(data.amount)}</span>
                        </p>
                        <p className="text-sm text-gray-600 flex items-center justify-between gap-4">
                            <span>Transactions:</span>
                            <span className="font-semibold text-purple-600">{data.transactions}</span>
                        </p>
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <Card className="col-span-2 shadow-xl border-none bg-gradient-to-br from-white to-blue-50/30">
            <CardHeader className="border-b border-gray-100 bg-white/50 backdrop-blur-sm">
                <div className="flex items-start justify-between">
                    <div>
                        <CardTitle className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <div className="p-2 bg-gradient-to-br from-blue-500 to-purple-500 rounded-lg">
                                <TrendingUp className="h-5 w-5 text-white"/>
                            </div>
                            {title}
                        </CardTitle>
                        <CardDescription className="text-base mt-2 text-gray-600">{description}</CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="pt-8">
                <div className="h-[400px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={sortedCategories}
                            margin={{top: 20, right: 30, left: 20, bottom: 80}}
                        >
                            <defs>
                                {COLORS.map((color, index) => (
                                    <linearGradient key={index} id={`colorGradient${index}`} x1="0" y1="0" x2="0"
                                                    y2="1">
                                        <stop offset="0%" stopColor={color} stopOpacity={1}/>
                                        <stop offset="100%" stopColor={color} stopOpacity={0.7}/>
                                    </linearGradient>
                                ))}
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" strokeOpacity={0.5}/>
                            <XAxis
                                dataKey="name"
                                angle={-45}
                                textAnchor="end"
                                height={80}
                                fontSize={13}
                                fontWeight={500}
                                stroke="#6b7280"
                            />
                            <YAxis
                                tickFormatter={formatCurrency}
                                fontSize={13}
                                fontWeight={500}
                                stroke="#6b7280"
                            />
                            <Tooltip content={<CustomTooltip/>} cursor={{fill: 'rgba(59, 130, 246, 0.1)'}}/>
                            <Bar dataKey="amount" radius={[12, 12, 0, 0]} maxBarSize={80}>
                                {sortedCategories.map((_, index) => (
                                    <Cell
                                        key={`cell-${index}`}
                                        fill={`url(#colorGradient${index % COLORS.length})`}
                                        className="hover:opacity-80 transition-opacity cursor-pointer"
                                    />
                                ))}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
