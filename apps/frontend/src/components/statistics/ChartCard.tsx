import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
    <Card className="glass-regular">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <ExclusionToggle
          graphKey={graphKey}
          isFiltered={isFiltered}
          onToggle={toggleGraphExclusion}
          exclusionsApply={exclusionsApply}
        />
      </CardHeader>
      <CardContent>{children(data)}</CardContent>
    </Card>
  );
}
