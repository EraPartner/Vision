/**
 * SankeyTab — year-selector + SankeyChart wrapper for the Statistics Flow tab.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { useExcludedIds } from "@/hooks/useExcludedIds";
import { getSankeyFlow } from "@/lib/api/aggregations";
import { aggregationKeys } from "@/lib/queryKeys";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { SankeyChart } from "./SankeyChart";

interface SankeyTabProps {
  readonly graphExclusions: Record<string, boolean>;
  readonly onToggleExclusion: (key: string) => void;
  readonly exclusionsApply: boolean;
  readonly availableYears?: number[];
}

const GRAPH_KEY = "sankey";

export function SankeyTab({ graphExclusions, onToggleExclusion, exclusionsApply, availableYears }: SankeyTabProps) {
  const { t } = useLanguage();
  const { currency } = useChartCurrencyFormatter();
  // Resolved exclusion set (settings + hidden categories) — using raw
  // settings.excluded* leaked hidden-category transactions into the flow diagram
  // while every other statistics chart dropped them.
  const { excludedCategoryIds: resolvedCatIds, excludedRecipientIds: resolvedRecIds } = useExcludedIds('statistics');
  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const yearOptions = availableYears?.length
    ? [...availableYears].sort((a, b) => b - a)
    : [currentYear];
  const [selectedYear, setSelectedYear] = useState(currentYear);

  const isFiltered = graphExclusions[GRAPH_KEY] ?? true;
  const applyExclusions = exclusionsApply && isFiltered;

  const excludedCategoryIds = applyExclusions ? resolvedCatIds : [];
  const excludedRecipientIds = applyExclusions ? resolvedRecIds : [];

  const { data, isLoading, isError } = useQuery({
    queryKey: aggregationKeys.sankey(
      selectedYear,
      currency,
      applyExclusions ? excludedCategoryIds : [],
      applyExclusions ? excludedRecipientIds : [],
    ),
    queryFn: () =>
      getSankeyFlow({
        currency,
        year: selectedYear,
        excluded_category_ids: excludedCategoryIds,
        excluded_recipient_ids: excludedRecipientIds,
      }),
    staleTime: 5 * 60 * 1000,
  });

  const flowData = data?.data;

  return (
    <Card className="glass-regular">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{t("statsPage.sankey.title")}</CardTitle>
            <CardDescription>
              {t("statsPage.sankey.description", { year: selectedYear })}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ExclusionToggle
              graphKey={GRAPH_KEY}
              isFiltered={isFiltered}
              onToggle={onToggleExclusion}
              exclusionsApply={exclusionsApply}
            />
            <Select
              value={String(selectedYear)}
              onValueChange={(v) => setSelectedYear(Number(v))}
            >
              <SelectTrigger className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-[420px] w-full" />}
        {isError && (
          <div className="flex items-center justify-center h-40 text-sm text-destructive">
            {t("statsPage.sankey.noData")}
          </div>
        )}
        {flowData && !isLoading && <SankeyChart data={flowData} height={420} />}
      </CardContent>
    </Card>
  );
}
