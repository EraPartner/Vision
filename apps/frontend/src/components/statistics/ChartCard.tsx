import type { ReactNode } from "react";
import { ChartCard as BaseChartCard } from "@/components/charts";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import type { StatisticsData } from "@/hooks/useStatistics";

interface ChartCardProps {
  title: string;
  description: string;
  graphKey: string;
  getGraphData: (key: string) => StatisticsData | null;
  graphExclusions: Record<string, boolean>;
  toggleGraphExclusion: (key: string) => void;
  exclusionsApply: boolean;
  children: (data: StatisticsData) => ReactNode;
}

export function ChartCard({
  title,
  description,
  graphKey,
  getGraphData,
  graphExclusions,
  toggleGraphExclusion,
  exclusionsApply,
  children,
}: ChartCardProps) {
  const data = getGraphData(graphKey);
  if (!data) return null;
  const isFiltered = graphExclusions[graphKey] ?? true;

  return (
    <BaseChartCard
      title={title}
      description={description}
      actions={(
        <ExclusionToggle
          graphKey={graphKey}
          isFiltered={isFiltered}
          onToggle={toggleGraphExclusion}
          exclusionsApply={exclusionsApply}
        />
      )}
    >
      {children(data)}
    </BaseChartCard>
  );
}
