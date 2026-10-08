import { PageError } from "@/components/shared/PageError";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useState } from "react";
import { Users } from "lucide-react";

import { EmptyState } from "@/components/shared/EmptyState";
import { Money } from "@/components/shared/Money";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { RecipientOwesDetail } from "@/features/splits/owes/RecipientOwesDetail";
import { useOwedSummary } from "@/hooks/useSplits";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { PageShell } from "@/components/shared/PageShell";

export default function OwesPage() {
    const {
        data: summary,
        isLoading,
        error: loadError,
        refetch,
    } = useOwedSummary();
    const [selectedRecipient, setSelectedRecipient] = useState<{
        id: number;
        name: string;
    } | null>(null);
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const decimals = appSettings.showDecimalPlaces ?? 2;

    if (isLoading) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("owesPage.title")}
                    subtitle={t("owesPage.subtitle")}
                    icon={PAGE_ICONS["/owes"]}
                />
                <div {...loadingSurfaceProps} className="space-y-4">
                    <Skeleton
                        data-testid="owes-summary-skeleton"
                        className="h-28 rounded-card corner-continuous"
                    />
                    <div className="space-y-2">
                        {[...Array(3)].map((_, index) => (
                            <Skeleton
                                key={index}
                                data-testid="owes-recipient-skeleton"
                                className="h-16 rounded-card corner-continuous"
                            />
                        ))}
                    </div>
                </div>
            </PageShell>
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
        <PageShell className="">
            <PageHeader
                title={t("owesPage.title")}
                subtitle={t("owesPage.subtitle")}
                icon={PAGE_ICONS["/owes"]}
            />

            {loadError && (
                <PageError
                    message={t("common.loadFailedRetry")}
                    onRetry={() => void refetch()}
                />
            )}
            {totalOwed > 0 && (
                <Card>
                    <CardContent variant="headerless">
                        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                            <div className="space-y-1">
                                <p className="type-footnote text-label-secondary">
                                    {t("owesPage.totalOutstanding")}
                                </p>
                                <p className="type-callout text-label-secondary">
                                    {items.length === 1
                                        ? t("owesPage.fromPerson", {
                                              n: items.length,
                                          })
                                        : t("owesPage.fromPeople", {
                                              n: items.length,
                                          })}
                                </p>
                            </div>
                            <p className="type-large-title tabular-nums text-foreground">
                                <Money
                                    amount={totalOwed}
                                    currency={defaultCurrency}
                                />
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {items.length === 0 && !loadError ? (
                <EmptyState
                    icon={Users}
                    title={t("owesPage.noDebts")}
                    description={t("owesPage.splitToTrack")}
                />
            ) : (
                <List>
                    {items.map((item) => {
                        const progress =
                            item.total_owed > 0
                                ? (item.total_paid / item.total_owed) * 100
                                : 0;
                        const selectRecipient = () =>
                            setSelectedRecipient({
                                id: item.recipient_id,
                                name: item.recipient_name,
                            });
                        const countLabel =
                            item.split_count === 1
                                ? t("owesPage.split", { n: item.split_count })
                                : t("owesPage.splits", {
                                      n: item.split_count,
                                  });

                        return (
                            <ListRow
                                key={item.recipient_id}
                                onActivate={selectRecipient}
                                chevron
                                title={item.recipient_name}
                                subtitle={
                                    <span className="flex items-center gap-3">
                                        <span className="shrink-0">
                                            {countLabel}
                                            {" · "}
                                            {t("owesPage.paid", {
                                                amount: formatCurrency(
                                                    item.total_paid,
                                                    defaultCurrency,
                                                    locale,
                                                    decimals,
                                                ),
                                            })}
                                            {" · "}
                                            {t("owesPage.totalLabel", {
                                                amount: formatCurrency(
                                                    item.total_owed,
                                                    defaultCurrency,
                                                    locale,
                                                    decimals,
                                                ),
                                            })}
                                        </span>
                                        <Progress
                                            value={progress}
                                            className="hidden h-1 w-24 sm:block"
                                            aria-label={t(
                                                "owesPage.repaymentProgress",
                                                {
                                                    recipient:
                                                        item.recipient_name,
                                                },
                                            )}
                                        />
                                    </span>
                                }
                                trailing={
                                    <span className="type-headline tabular-nums text-foreground">
                                        <Money
                                            amount={item.remaining}
                                            currency={defaultCurrency}
                                        />
                                    </span>
                                }
                            />
                        );
                    })}
                </List>
            )}
        </PageShell>
    );
}
