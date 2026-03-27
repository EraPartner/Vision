import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,} from "recharts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

interface MonthlySpendingChartProps {
    data: Array<{ month: string; spending: number; income: number }>;
}

export function MonthlySpendingChart({ data }: MonthlySpendingChartProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    const formatCompactCurrency = (value: number) => new Intl.NumberFormat(locale, {
        style: "currency",
        currency: defaultCurrency,
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(value);

    if (!data || data.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg font-semibold">{t('monthlySpending.title')}</CardTitle>
                    <p className="text-sm text-muted-foreground">{t('monthlySpending.desc')}</p>
                </CardHeader>
                <CardContent>
                    <div className="h-72 flex items-center justify-center text-muted-foreground">
                        {t('monthlySpending.noData')}
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-lg font-semibold">{t('monthlySpending.title')}</CardTitle>
                <p className="text-sm text-muted-foreground">{t('monthlySpending.desc')}</p>
            </CardHeader>
            <CardContent>
                <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data} barGap={4}>
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
                                tickFormatter={(v) => formatCompactCurrency(v)}
                            />
                            <Tooltip
                                contentStyle={{
                                    borderRadius: "var(--radius)",
                                    border: "1px solid hsl(var(--border))",
                                    background: "hsl(var(--card))",
                                    color: "hsl(var(--card-foreground))",
                                }}
                                formatter={(value: number, name: string) => [
                                    formatCurrency(value, defaultCurrency, locale),
                                    name === "spending" ? t('monthlySpending.spending') : t('monthlySpending.income'),
                                ]}
                            />
                            <Legend
                                formatter={(value) => (value === "spending" ? t('monthlySpending.spending') : t('monthlySpending.income'))}
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
