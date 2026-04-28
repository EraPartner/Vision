import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, TrendingUp } from "lucide-react";
import { useSavedCharts, useDeleteSavedChart } from "@/hooks/useSavedCharts";
import type { SavedChart } from "@/lib/api/types";
import type { StatisticsData } from "@/hooks/useStatistics";
import { useLanguage } from "@/contexts/LanguageContext";
import { CustomChart } from "./CustomChart";
import { CustomChartBuilderModal } from "./CustomChartBuilderModal";

interface SavedChartsSectionProps {
  data: StatisticsData;
}

export function SavedChartsSection({ data }: SavedChartsSectionProps) {
  const { t } = useLanguage();
  const { data: savedCharts, isLoading } = useSavedCharts();
  const deleteChart = useDeleteSavedChart();

  const [builderOpen, setBuilderOpen] = useState(false);
  const [editChart, setEditChart] = useState<SavedChart | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<SavedChart | undefined>(undefined);

  const handleEdit = (chart: SavedChart) => {
    setEditChart(chart);
    setBuilderOpen(true);
  };

  const handleBuilderClose = (open: boolean) => {
    setBuilderOpen(open);
    if (!open) setEditChart(undefined);
  };

  const handleDeleteConfirm = () => {
    if (pendingDelete) {
      deleteChart.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(undefined) });
    }
  };

  const charts = (savedCharts ?? []).filter((c) => !c.name.startsWith("autochart:"));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("customChart.tab")}</h2>
          {charts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("customChart.savedCount", { n: charts.length })}
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => { setEditChart(undefined); setBuilderOpen(true); }}>
          <Plus className="h-4 w-4 mr-1" />
          {t("customChart.newChart")}
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[0, 1].map((i) => (
            <div key={i} className="h-[420px] rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : charts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border rounded-xl border-dashed">
          <TrendingUp className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h3 className="text-lg font-semibold mb-1">{t("customChart.emptyTitle")}</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">{t("customChart.emptyDesc")}</p>
          <Button onClick={() => { setEditChart(undefined); setBuilderOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            {t("customChart.createFirst")}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {charts.map((chart) => (
            <CustomChart
              key={chart.id}
              savedChart={chart}
              data={data}
              onEdit={handleEdit}
              onDelete={setPendingDelete}
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

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("customChart.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("customChart.deleteDesc", { name: pendingDelete?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteChart.isPending ? t("customChart.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
