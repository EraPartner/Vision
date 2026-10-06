import { Link } from "react-router";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useUpcomingPlannedPayments } from "@/hooks/useUpcomingPlannedPayments";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { todayYmd } from "@/lib/timezone";
import { amountClass } from "@/features/transactions/amountClass";
import { cn } from "@/lib/utils";

const MAX_ROWS = 5;

/** Home "Next 7 days" (ADR-181): the planned payments due soon, from the shared reminder source. */
export function UpcomingPaymentsList() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const { visibleUpcoming } = useUpcomingPlannedPayments();
    const today = todayYmd();
    const rows = visibleUpcoming.slice(0, MAX_ROWS);

    const dayLabel = (ymd: string) => {
        const date = ymd.slice(0, 10);
        if (date === today) return t("home.upcoming.today");
        const tomorrow = new Date(`${today}T00:00:00`);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowYmd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
        if (date === tomorrowYmd) return t("home.upcoming.tomorrow");
        return formatDateStringWithAppSettings(date, appSettings.dateFormat);
    };

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
                <CardTitle variant="sm">{t("home.upcoming.title")}</CardTitle>
                <Button asChild variant="link" size="sm" className="h-auto p-0">
                    <Link to="/planned">{t("home.upcoming.all")}</Link>
                </Button>
            </CardHeader>
            <CardContent>
                <List>
                    {rows.length === 0 ? (
                        <ListRow leading={<CalendarClock />} title={t("home.upcoming.none")} />
                    ) : (
                        rows.map((pt) => (
                            <ListRow
                                key={`${pt.id}:${pt.planned_date}`}
                                asChild
                                title={pt.recipient_name || pt.bank_account}
                                subtitle={dayLabel(pt.planned_date)}
                                trailing={
                                    <span className={cn("font-medium", amountClass(pt.amount))}>
                                        <Money amount={pt.amount} currency={pt.currency ?? undefined} signed />
                                    </span>
                                }
                            >
                                <Link to="/planned" />
                            </ListRow>
                        ))
                    )}
                </List>
            </CardContent>
        </Card>
    );
}
