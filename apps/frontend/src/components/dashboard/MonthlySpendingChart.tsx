import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,} from "recharts";

const monthlyData = [
    {month: "Sep", spending: 2890, income: 4200},
    {month: "Oct", spending: 3120, income: 4200},
    {month: "Nov", spending: 2780, income: 4650},
    {month: "Dec", spending: 3540, income: 5050},
    {month: "Jan", spending: 3010, income: 4200},
    {month: "Feb", spending: 1245, income: 4200},
];

export function MonthlySpendingChart() {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-lg font-semibold">Monthly Spending vs Income</CardTitle>
                <p className="text-sm text-muted-foreground">Last 6 months overview</p>
            </CardHeader>
            <CardContent>
                <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyData} barGap={4}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border"/>
                            <XAxis
                                dataKey="month"
                                tick={{fontSize: 12}}
                                className="fill-muted-foreground"
                                axisLine={false}
                                tickLine={false}
                            />
                            <YAxis
                                tick={{fontSize: 12}}
                                className="fill-muted-foreground"
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(v) => `€${v}`}
                            />
                            <Tooltip
                                contentStyle={{
                                    borderRadius: "var(--radius)",
                                    border: "1px solid hsl(var(--border))",
                                    background: "hsl(var(--card))",
                                    color: "hsl(var(--card-foreground))",
                                }}
                                formatter={(value: number, name: string) => [
                                    `€${value.toLocaleString()}`,
                                    name === "spending" ? "Spending" : "Income",
                                ]}
                            />
                            <Legend
                                formatter={(value) => (value === "spending" ? "Spending" : "Income")}
                            />
                            <Bar
                                dataKey="spending"
                                fill="hsl(var(--destructive))"
                                radius={[4, 4, 0, 0]}
                                maxBarSize={40}
                            />
                            <Bar
                                dataKey="income"
                                fill="hsl(var(--accent))"
                                radius={[4, 4, 0, 0]}
                                maxBarSize={40}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
