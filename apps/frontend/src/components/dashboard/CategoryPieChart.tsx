import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { useLanguage } from "@/contexts/LanguageContext";

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
    embedded?: boolean;
}

export function CategoryPieChart({ data, embedded = false }: CategoryPieChartProps) {
    const { t } = useLanguage();
    const chartContent = (
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
                            <Cell key={index} fill={COLORS[index % COLORS.length]} />
                        ))}
                    </Pie>
                    <Tooltip
                        contentStyle={{
                            borderRadius: "var(--radius)",
                            border: "1px solid hsl(var(--border))",
                            background: "hsl(var(--card))",
                            color: "hsl(var(--card-foreground))",
                        }}
                        formatter={(value: number) => [`€${value.toLocaleString()}`, t('categoryPie.amount')]}
                    />
                    <Legend
                        verticalAlign="bottom"
                        iconType="circle"
                        iconSize={8}
                        formatter={(value) => (
                            <span style={{ color: "hsl(var(--muted-foreground))", fontSize: 12 }}>
                                {value}
                            </span>
                        )}
                    />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );

    if (!data || data.length === 0) {
        const emptyContent = (
            <div className="h-72 flex items-center justify-center text-muted-foreground">
                {t('categoryPie.noData')}
            </div>
        );
        
        if (embedded) {
            return emptyContent;
        }
        
        return (
            <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
                <CardHeader>
                    <CardTitle className="text-lg font-semibold">{t('categoryPie.title')}</CardTitle>
                    <p className="text-sm text-muted-foreground">{t('categoryPie.desc')}</p>
                </CardHeader>
                <CardContent>
                    {emptyContent}
                </CardContent>
            </Card>
        );
    }

    if (embedded) {
        return chartContent;
    }

    return (
        <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
            <CardHeader>
                <CardTitle className="text-lg font-semibold">{t('categoryPie.title')}</CardTitle>
                <p className="text-sm text-muted-foreground">{t('categoryPie.desc')}</p>
            </CardHeader>
            <CardContent>
                {chartContent}
            </CardContent>
        </Card>
    );
}
