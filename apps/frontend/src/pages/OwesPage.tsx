import { useState } from "react";
import { HandCoins, Users } from "lucide-react";

import { EmptyState } from "@/components/shared/EmptyState";
import { Money } from "@/components/shared/Money";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { RecipientOwesDetail } from "@/features/splits/owes/RecipientOwesDetail";
import { useOwedSummary } from "@/hooks/useSplits";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { onActivateKeyDown } from "@/utils/a11y";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

export default function OwesPage() {
    const { data: summary, isLoading } = useOwedSummary();
    const [selectedRecipient, setSelectedRecipient] = useState<{
        id: number;
        name: string;
    } | null>(null);
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    if (isLoading) {
        return (
            <div className="space-y-8">
                <PageHeader
                    title={t("owesPage.title")}
                    subtitle={t("owesPage.subtitle")}
                    icon={HandCoins}
                />
                <div {...loadingSurfaceProps} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {[...Array(3)].map((_, index) => <Skeleton key={index} className="h-32" />)}
                </div>
            </div>
        );
    }

    const items = summary?.items || [];
    const totalOwed = items.reduce((sum, item) => sum + item.remaining, 0);

    if (selectedRecipient) {
        return (
            <RecipientOwesDetail
                recipient={selectedRecipient}
                onBack={() => setSelectedRecipient(null)}
            />
        );
    }

    return (
        <div className="space-y-8">
            <PageHeader
                title={t("owesPage.title")}
                subtitle={t("owesPage.subtitle")}
                icon={HandCoins}
            />

            {totalOwed > 0 && (
                <Card className="bg-primary/5 !border-primary/50">
                    <CardContent className="pt-6">
                        <div className="text-center">
                            <p className="text-sm text-muted-foreground">{t("owesPage.totalOutstanding")}</p>
                            <p className="text-3xl font-bold text-primary mt-1">
                                <Money amount={totalOwed} currency={defaultCurrency} />
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                                {items.length === 1
                                    ? t("owesPage.fromPerson", { n: items.length })
                                    : t("owesPage.fromPeople", { n: items.length })}
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {items.length === 0 ? (
                <EmptyState
                    icon={Users}
                    title={t("owesPage.noDebts")}
                    description={t("owesPage.splitToTrack")}
                />
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => {
                        const progress = item.total_owed > 0
                            ? (item.total_paid / item.total_owed) * 100
                            : 0;
                        const selectRecipient = () => setSelectedRecipient({
                            id: item.recipient_id,
                            name: item.recipient_name,
                        });

                        return (
                            <Card
                                key={item.recipient_id}
                                role="button"
                                tabIndex={0}
                                aria-label={item.recipient_name}
                                variant="interactive"
                                className="cursor-pointer hover:border-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2"
                                onClick={selectRecipient}
                                onKeyDown={onActivateKeyDown(selectRecipient)}
                            >
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base flex items-center justify-between">
                                        <span>{item.recipient_name}</span>
                                        <Badge variant="secondary">
                                            {item.split_count === 1
                                                ? t("owesPage.split", { n: item.split_count })
                                                : t("owesPage.splits", { n: item.split_count })}
                                        </Badge>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">{t("owesPage.remaining")}</span>
                                        <span className="font-semibold text-primary">
                                            <Money amount={item.remaining} currency={defaultCurrency} />
                                        </span>
                                    </div>
                                    <Progress value={progress} className="h-2" />
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>
                                            {t("owesPage.paid", {
                                                amount: formatCurrency(item.total_paid, defaultCurrency, locale),
                                            })}
                                        </span>
                                        <span>
                                            {t("owesPage.totalLabel", {
                                                amount: formatCurrency(item.total_owed, defaultCurrency, locale),
                                            })}
                                        </span>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
