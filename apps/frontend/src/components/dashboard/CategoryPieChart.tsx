import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip,} from "recharts";

const COLORS = [
    "hsl(var(--primary))",
    "hsl(var(--chart-3))",
    "hsl(var(--chart-5))",
    "hsl(var(--chart-4))",
    "hsl(var(--accent))",
    "hsl(var(--destructive))",
    "hsl(var(--chart-2))",
];

interface CategoryPieChartProps {
    data: Array<{ name: string; value: number }>;
}

export function CategoryPieChart({ data }: CategoryPieChartProps) {
    if (!data || data.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg font-semibold">Spending by Category</CardTitle>
                    <p className="text-sm text-muted-foreground">This month's breakdown</p>
                </CardHeader>
                <CardContent>
                    <div className="h-72 flex items-center justify-center text-muted-foreground">
                        No category data available
                    </div>
                </CardContent>
            </Card>
        );
    }
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-lg font-semibold">Spending by Category</CardTitle>
                <p className="text-sm text-muted-foreground">This month's breakdown</p>
            </CardHeader>
            <CardContent>
                <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                            <Pie
                                data={data}
                                cx="50%"
                                cy="50%"
                                innerRadius={60}
                                outerRadius={100}
                                paddingAngle={3}
                                dataKey="value"
                                stroke="none"
                            >
                                {data.map((_, index) => (
                                    <Cell key={index} fill={COLORS[index % COLORS.length]}/>
                                ))}
                            </Pie>
                            <Tooltip
                                contentStyle={{
                                    borderRadius: "var(--radius)",
                                    border: "1px solid hsl(var(--border))",
                                    background: "hsl(var(--card))",
                                    color: "hsl(var(--card-foreground))",
                                }}
                                formatter={(value: number) => [`€${value.toLocaleString()}`, "Amount"]}
                            />
                            <Legend
                                verticalAlign="bottom"
                                iconType="circle"
                                iconSize={8}
                                formatter={(value) => (
                                    <span style={{color: "hsl(var(--muted-foreground))", fontSize: 12}}>
                    {value}
                  </span>
                                )}
                            />
                        </PieChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
