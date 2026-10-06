import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, TrendingUp } from "lucide-react";
import { useSavedCharts, useDeleteSavedChart } from "@/hooks/useSavedCharts";
import type { SavedChart } from "@/types/apiClient";
import type { StatisticsData } from "@/hooks/useStatistics";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { CustomChart } from "./CustomChart";
import { CustomChartBuilderModal } from "./CustomChartBuilderModal";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

interface SavedChartsSectionProps {
    data: StatisticsData;
}

export function SavedChartsSection({ data }: SavedChartsSectionProps) {
    const { t, tc } = useLanguage();
    const { data: savedCharts, isLoading } = useSavedCharts();
    const deleteChart = useDeleteSavedChart();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const [builderOpen, setBuilderOpen] = useState(false);
    const [editChart, setEditChart] = useState<SavedChart | undefined>(
        undefined,
    );

    const builderOpener = useRef<HTMLButtonElement | null>(null);
    const newChartButton = useRef<HTMLButtonElement | null>(null);
    const restoreBuilderFocus = () => {
        (builderOpener.current?.isConnected
            ? builderOpener.current
            : newChartButton.current
        )?.focus();
    };
    const handleEdit = (chart: SavedChart, opener: HTMLButtonElement) => {
        builderOpener.current = opener;
        setEditChart(chart);
        setBuilderOpen(true);
    };

    const handleBuilderClose = (open: boolean) => {
        setBuilderOpen(open);
        if (!open) setEditChart(undefined);
    };

    const handleDelete = async (
        chart: SavedChart,
        opener: HTMLButtonElement,
    ) => {
        const accepted = await confirm({
            title: t("customChart.deleteTitle"),
            description: t("customChart.deleteDesc", { name: chart.name }),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            variant: "destructive",
            onCloseAutoFocus: () =>
                (opener.isConnected ? opener : newChartButton.current)?.focus(),
        });
        if (accepted)
            deleteChart.mutate(chart.id, {
                onSuccess: () => newChartButton.current?.focus(),
            });
    };

    const charts = (savedCharts ?? []).filter(
        (c) => !c.name.startsWith("autochart:"),
    );

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="type-title-3 text-foreground">
                        {t("customChart.tab")}
                    </h2>
                    {charts.length > 0 && (
                        <p className="type-footnote text-label-secondary">
                            {tc("customChart.savedCount", charts.length)}
                        </p>
                    )}
                </div>
                <Button
                    size="sm"
                    ref={newChartButton}
                    onClick={(event) => {
                        builderOpener.current = event.currentTarget;
                        setEditChart(undefined);
                        setBuilderOpen(true);
                    }}
                >
                    <Plus className="h-4 w-4 mr-1" />
                    {t("customChart.newChart")}
                </Button>
            </div>

            {isLoading ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {[0, 1].map((i) => (
                        <Skeleton key={i} className="h-[420px] rounded-card" />
                    ))}
                </div>
            ) : charts.length === 0 ? (
                <Card>
                    <CardContent variant="state" className="py-2">
                        <EmptyState
                            headingLevel={3}
                            size="compact"
                            icon={TrendingUp}
                            title={t("customChart.emptyTitle")}
                            description={t("customChart.emptyDesc")}
                            action={
                                <Button
                                    onClick={(event) => {
                                        builderOpener.current =
                                            event.currentTarget;
                                        setEditChart(undefined);
                                        setBuilderOpen(true);
                                    }}
                                >
                                    <Plus className="mr-1 h-4 w-4" />
                                    {t("customChart.createFirst")}
                                </Button>
                            }
                        />
                    </CardContent>
                </Card>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {charts.map((chart) => (
                        <CustomChart
                            key={chart.id}
                            savedChart={chart}
                            data={data}
                            onEdit={handleEdit}
                            onDelete={(chart, opener) =>
                                void handleDelete(chart, opener)
                            }
                        />
                    ))}
                </div>
            )}

            <CustomChartBuilderModal
                open={builderOpen}
                onOpenChange={handleBuilderClose}
                data={data}
                editChart={editChart}
                onCloseAutoFocus={restoreBuilderFocus}
            />

            <ConfirmDialog />
        </div>
    );
}
