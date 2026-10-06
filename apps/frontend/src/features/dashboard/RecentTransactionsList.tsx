import { Link } from "react-router";
import { Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list";
import { Money } from "@/components/shared/Money";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { getCategoryChartColor } from "@/utils/categoryColors";
import { amountClass } from "@/features/transactions/amountClass";
import { cn } from "@/lib/utils";

export interface RecentTransactionRow {
    id: number;
    date: string | null;
    description: string;
    amount: number;
    currency: string;
    category: string;
    categoryId?: number | null;
    recipient: string;
}

interface RecentTransactionsListProps {
    rows: RecentTransactionRow[];
    exclusionsApply: boolean;
    isFiltered: boolean;
    onToggleExclusions: (key: string) => void;
}

/** Home recent transactions (ADR-181): the last rows as a list; a row opens it in Transactions. */
export function RecentTransactionsList({
    rows,
    exclusionsApply,
    isFiltered,
    onToggleExclusions,
}: RecentTransactionsListProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pb-3">
                <div>
                    <CardTitle variant="sm">{t("dashboard.recentTransactions")}</CardTitle>
                    <CardDescription>
                        {t("dashboard.recentTransactionsSubtitle", { n: rows.length })}
                    </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                    <ExclusionToggle
                        graphKey="recentTransactions"
                        isFiltered={isFiltered}
                        onToggle={onToggleExclusions}
                        exclusionsApply={exclusionsApply}
                    />
                    <Button asChild variant="link" size="sm" className="h-auto p-0">
                        <Link to="/transactions">{t("home.recent.seeAll")}</Link>
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                <List>
                    {rows.length === 0 ? (
                        <ListRow leading={<Receipt />} title={t("dashboard.recentTransactions.empty")} />
                    ) : (
                        rows.map((row) => (
                            <ListRow
                                key={row.id}
                                asChild
                                chevron
                                leading={
                                    <span
                                        aria-hidden="true"
                                        className="h-2.5 w-2.5 rounded-full"
                                        style={{
                                            backgroundColor: row.categoryId
                                                ? getCategoryChartColor(row.category)
                                                : "hsl(var(--muted-foreground) / 0.4)",
                                        }}
                                    />
                                }
                                title={row.recipient}
                                subtitle={[
                                    row.date
                                        ? formatDateStringWithAppSettings(row.date, appSettings.dateFormat)
                                        : null,
                                    row.category,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                trailing={
                                    <span className={cn("font-medium", amountClass(row.amount))}>
                                        <Money signed amount={row.amount} currency={row.currency} />
                                    </span>
                                }
                            >
                                <Link to="/transactions" state={{ selectTransactionId: row.id }} />
                            </ListRow>
                        ))
                    )}
                </List>
            </CardContent>
        </Card>
    );
}
