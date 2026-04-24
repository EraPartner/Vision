/**
 * SankeyTab — year-selector + SankeyChart wrapper for the Statistics Flow tab.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { useSettings } from "@/contexts/SettingsContext";
import { getSankeyFlow } from "@/lib/api/aggregations";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { SankeyChart } from "./SankeyChart";

const CURRENT_YEAR = new Date().getFullYear();

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
  const { settings } = useSettings();
  const yearOptions = availableYears?.length
    ? [...availableYears].sort((a, b) => b - a)
    : [CURRENT_YEAR];
  const [selectedYear, setSelectedYear] = useState(CURRENT_YEAR);

  const isFiltered = graphExclusions[GRAPH_KEY] ?? true;
  const applyExclusions = exclusionsApply && isFiltered;

  const excludedCategoryIds = applyExclusions ? settings.excludedCategoryIds : [];
  const excludedRecipientIds = applyExclusions ? settings.excludedRecipientIds : [];

  const { data, isLoading, isError } = useQuery({
    queryKey: [
      "aggregations",
      "sankey",
      selectedYear,
      currency,
      applyExclusions ? excludedCategoryIds : [],
      applyExclusions ? excludedRecipientIds : [],
    ],
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
    <Card>
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
