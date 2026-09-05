import { useState } from "react";
import { Button } from "@/components/ui/button";
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
    const { t } = useLanguage();
    const { data: savedCharts, isLoading } = useSavedCharts();
    const deleteChart = useDeleteSavedChart();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const [builderOpen, setBuilderOpen] = useState(false);
    const [editChart, setEditChart] = useState<SavedChart | undefined>(
        undefined,
    );

    const handleEdit = (chart: SavedChart) => {
        setEditChart(chart);
        setBuilderOpen(true);
    };

    const handleBuilderClose = (open: boolean) => {
        setBuilderOpen(open);
        if (!open) setEditChart(undefined);
    };

    const handleDelete = async (chart: SavedChart) => {
        const accepted = await confirm({
            title: t("customChart.deleteTitle"),
            description: t("customChart.deleteDesc", { name: chart.name }),
            confirmLabel: t("common.delete"),
            cancelLabel: t("common.cancel"),
            variant: "destructive",
        });
        if (accepted) deleteChart.mutate(chart.id);
    };

    const charts = (savedCharts ?? []).filter(
        (c) => !c.name.startsWith("autochart:"),
    );

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold">
                        {t("customChart.tab")}
                    </h2>
                    {charts.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                            {t("customChart.savedCount", { n: charts.length })}
                        </p>
                    )}
                </div>
                <Button
                    size="sm"
                    onClick={() => {
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
                        <Skeleton key={i} className="h-[420px] rounded-xl" />
                    ))}
                </div>
            ) : charts.length === 0 ? (
                <div className="rounded-xl border border-dashed">
                    <EmptyState
                        headingLevel={3}
                        size="compact"
                        icon={TrendingUp}
                        title={t("customChart.emptyTitle")}
                        description={t("customChart.emptyDesc")}
                        action={
                            <Button
                                onClick={() => {
                                    setEditChart(undefined);
                                    setBuilderOpen(true);
                                }}
                            >
                                <Plus className="h-4 w-4 mr-1" />
                                {t("customChart.createFirst")}
                            </Button>
                        }
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {charts.map((chart) => (
                        <CustomChart
                            key={chart.id}
                            savedChart={chart}
                            data={data}
                            onEdit={handleEdit}
                            onDelete={(chart) => void handleDelete(chart)}
                        />
                    ))}
                </div>
            )}

            <CustomChartBuilderModal
                open={builderOpen}
                onOpenChange={handleBuilderClose}
                data={data}
                editChart={editChart}
            />

            <ConfirmDialog />
        </div>
    );
}
