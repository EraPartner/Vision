import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis} from "recharts";
import {PieChart} from "lucide-react";

interface SpendingChartProps {
    data: Array<{ category: string; amount: number }>;
}

const COLORS = [
    "hsl(217 91% 60%)",
    "hsl(142 76% 36%)",
    "hsl(45 93% 47%)",
    "hsl(280 87% 65%)",
    "hsl(340 82% 52%)",
];

export function SpendingChart({data}: SpendingChartProps) {
    const totalSpending = data.reduce((sum, item) => sum + item.amount, 0);

    return (
        <Card
            className="border-none shadow-xl bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-800 hover:shadow-2xl transition-shadow duration-300">
            <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                    <div
                        className="h-12 w-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center shadow-lg shadow-purple-500/30">
                        <PieChart className="h-6 w-6 text-white"/>
                    </div>
                    <div className="flex-1">
                        <CardTitle className="text-xl">Spending Distribution</CardTitle>
                        <CardDescription className="text-base">
                            Total spending: <span
                            className="font-semibold text-slate-900 dark:text-white">${totalSpending.toFixed(2)}</span>
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={data} margin={{top: 10, right: 10, left: 10, bottom: 20}}>
                        <defs>
                            {data.map((entry, index) => (
                                <linearGradient key={`gradient-${index}`} id={`colorGradient${index}`} x1="0" y1="0"
                                                x2="0" y2="1">
                                    <stop offset="0%" stopColor={COLORS[index % COLORS.length]} stopOpacity={0.8}/>
                                    <stop offset="95%" stopColor={COLORS[index % COLORS.length]} stopOpacity={0.3}/>
                                </linearGradient>
                            ))}
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700"
                                       opacity={0.5}/>
                        <XAxis
                            dataKey="category"
                            className="text-xs"
                            tick={{fill: "hsl(var(--muted-foreground))", fontSize: 12}}
                            angle={-15}
                            textAnchor="end"
                            height={60}
                        />
                        <YAxis
                            className="text-xs"
                            tick={{fill: "hsl(var(--muted-foreground))", fontSize: 12}}
                            tickFormatter={(value) => `$${value}`}
                        />
                        <Tooltip
                            contentStyle={{
                                backgroundColor: "hsl(var(--card))",
                                border: "1px solid hsl(var(--border))",
                                borderRadius: "12px",
                                padding: "12px",
                                boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                            }}
                            formatter={(value: number) => [`$${Math.abs(value).toFixed(2)}`, "Amount"]}
                            labelStyle={{fontWeight: "600", marginBottom: "4px"}}
                        />
                        <Bar dataKey="amount" radius={[12, 12, 0, 0]} maxBarSize={60}>
                            {data.map((entry, index) => (
                                <Cell
                                    key={`cell-${index}`}
                                    fill={`url(#colorGradient${index})`}
                                    className="hover:opacity-80 transition-opacity duration-200"
                                />
                            ))}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>

                {/* Category breakdown */}
                <div className="mt-6 grid grid-cols-2 gap-3">
                    {data.slice(0, 4).map((item, index) => (
                        <div
                            key={item.category}
                            className="flex items-center gap-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700"
                        >
                            <div
                                className="w-3 h-3 rounded-full flex-shrink-0"
                                style={{backgroundColor: COLORS[index % COLORS.length]}}
                            ></div>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-slate-700 dark:text-slate-300 capitalize truncate">
                                    {item.category}
                                </p>
                                <p className="text-sm font-bold text-slate-900 dark:text-white">
                                    ${item.amount.toFixed(2)}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}