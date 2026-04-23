import { CustomCategoryChart } from "@/components/statistics/CustomCategoryChart";
import { useSavedCharts } from "@/hooks/useSavedCharts";
import type { StatisticsData } from "@/hooks/useStatistics";

interface SavedChartsSectionProps {
  data: StatisticsData;
  getGraphData: (key: string) => StatisticsData | null;
  graphExclusions: Record<string, boolean>;
  toggleGraphExclusion: (key: string) => void;
  exclusionsApply: boolean;
}

export function SavedChartsSection({
  data,
  getGraphData,
  graphExclusions,
  toggleGraphExclusion,
  exclusionsApply,
}: SavedChartsSectionProps) {
  const { data: savedCharts, isLoading } = useSavedCharts();

  if (isLoading || !savedCharts || savedCharts.length === 0) return null;

  return (
    <>
      {savedCharts.map((chart) => {
        const graphKey = `savedChart_${chart.id}`;
        return (
          <CustomCategoryChart
            key={chart.id}
            data={getGraphData(graphKey) || data}
            graphKey={graphKey}
            isFiltered={graphExclusions[graphKey] ?? true}
            onToggle={toggleGraphExclusion}
            exclusionsApply={exclusionsApply}
            savedChart={chart}
          />
        );
      })}
    </>
  );
}
