import { Fragment, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort, isExpandableGroup, computeMasterToggleState, type PivotValueMode } from "./statisticsUtils";
import type { StatisticsData } from "@/hooks/useStatistics";

interface CategoryPivotTableProps {
  data: StatisticsData;
  graphKey: string;
  isFiltered: boolean;
  onToggle: (key: string) => void;
  exclusionsApply: boolean;
}

function lastDayOfMonth(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const day = new Date(year, month, 0).getDate();
  return `${period}-${String(day).padStart(2, '0')}`;
}

/**
 * Pure period-value accessor — hoisted out of the component so it isn't
 * redefined each render and the useMemos below can list it as a real (stable)
 * dependency instead of suppressing exhaustive-deps.
 */
function getPeriodValue(
  cat: StatisticsData["categoryPivot"][number],
  period: string,
  valueMode: PivotValueMode,
): number {
  if (valueMode === "net") return cat.netMonths[period] || 0;
  if (valueMode === "income") return cat.incomeMonths[period] || 0;
  if (valueMode === "expense") return cat.expenseMonths[period] || 0;
  return cat.months[period] || 0;
}

function buildDrillUrl(params: {
  categoryId?: number;
  categoryIds?: number[];
  period?: string;
  valueMode: PivotValueMode;
  label: string;
}): string {
  const { categoryId, categoryIds, period, valueMode, label } = params;
  const sp = new URLSearchParams();

  if (categoryId != null) sp.set('category_id', String(categoryId));
  else if (categoryIds && categoryIds.length > 0) sp.set('category_ids', categoryIds.join(','));

  if (period) {
    sp.set('start_date', `${period}-01`);
    sp.set('end_date', lastDayOfMonth(period));
  }

  if (valueMode === 'income') sp.set('transaction_type', 'income');
  else if (valueMode === 'expense') sp.set('transaction_type', 'expense');

  sp.set('filter_label', label);
  return `/transactions?${sp.toString()}`;
}

export function CategoryPivotTable({
  data,
  graphKey,
  isFiltered,
  onToggle,
  exclusionsApply,
}: CategoryPivotTableProps) {
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [valueMode, setValueMode] = useState<PivotValueMode>("absolute");
  const { t } = useLanguage();
  const { formatCurrency, formatCompact } = useChartCurrencyFormatter();
  const navigate = useNavigate();

  const filteredPeriods = useMemo(() => {
    if (yearFilter === "all") return data.allPeriods;
    return data.allPeriods.filter((p) => p.startsWith(yearFilter));
  }, [yearFilter, data.allPeriods]);

  const filteredCategories = useMemo(() => {
    return data.categoryPivot
      .map((cat) => {
        const filteredTotal = filteredPeriods.reduce((s, p) => s + getPeriodValue(cat, p, valueMode), 0);
        return { ...cat, filteredTotal };
      })
      .filter((cat) => {
        if (valueMode === "net") return cat.filteredTotal !== 0;
        return cat.filteredTotal > 0;
      })
      .sort((a, b) =>
        valueMode === "net"
          ? Math.abs(b.filteredTotal) - Math.abs(a.filteredTotal)
          : b.filteredTotal - a.filteredTotal
      );
  }, [data.categoryPivot, filteredPeriods, valueMode]);

  const hierarchicalCategories = useMemo(() => {
    type PivotItem = (typeof filteredCategories)[number];
    const grouped = new Map<
      string,
      { general: string; total: number; months: Record<string, number>; children: Array<PivotItem & { detailName: string }> }
    >();

    for (const cat of filteredCategories) {
      const [rawGeneral, ...detailParts] = String(
        cat.categoryName || t("txPage.field.uncategorized")
      ).split(":");
      const general = rawGeneral?.trim() || t("txPage.field.uncategorized");
      const detailName = detailParts.length > 0 ? detailParts.join(":").replace(/^ /, "") : general;

      if (!grouped.has(general)) {
        const initialMonths: Record<string, number> = {};
        for (const period of filteredPeriods) {
          initialMonths[period] = 0;
        }
        grouped.set(general, { general, total: 0, months: initialMonths, children: [] });
      }

      const group = grouped.get(general)!;
      group.total += cat.filteredTotal;
      for (const period of filteredPeriods) {
        group.months[period] += getPeriodValue(cat, period, valueMode);
      }
      group.children.push({ ...cat, detailName });
    }

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        children: group.children.sort((a, b) =>
          valueMode === "net"
            ? Math.abs(b.filteredTotal) - Math.abs(a.filteredTotal)
            : b.filteredTotal - a.filteredTotal
        ),
      }))
      .sort((a, b) =>
        valueMode === "net"
          ? Math.abs(b.total) - Math.abs(a.total)
          : b.total - a.total
      );
  }, [filteredCategories, filteredPeriods, t, valueMode]);

  const columnTotals = useMemo(() => {
    // Single pass over categories accumulating per period, rather than a
    // reduce-over-categories *per period* (periods × categories).
    const totals: Record<string, number> = {};
    for (const period of filteredPeriods) totals[period] = 0;
    for (const cat of filteredCategories) {
      for (const period of filteredPeriods) {
        totals[period] += getPeriodValue(cat, period, valueMode);
      }
    }
    return totals;
  }, [filteredCategories, filteredPeriods, valueMode]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const expandableGroupNames = useMemo(
    () => hierarchicalCategories.filter(isExpandableGroup).map((g) => g.general),
    [hierarchicalCategories]
  );

  const { hasExpandable, allCollapsed } = useMemo(
    () => computeMasterToggleState(expandableGroupNames, collapsedGroups),
    [expandableGroupNames, collapsedGroups]
  );

  const toggleGroup = useCallback((general: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(general)) next.delete(general);
      else next.add(general);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setCollapsedGroups(allCollapsed ? new Set() : new Set(expandableGroupNames));
  }, [allCollapsed, expandableGroupNames]);

  const clickableCell = "cursor-pointer hover:bg-primary/10 transition-colors";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-4">
        <div>
          <CardTitle>{t("statsPage.pivotTitle")}</CardTitle>
          <CardDescription>{t("statsPage.pivotDesc")}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={valueMode} onValueChange={(v) => setValueMode(v as PivotValueMode)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder={t("statsPage.pivot.metric")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="absolute">{t("statsPage.pivot.metric.absolute")}</SelectItem>
              <SelectItem value="net">{t("statsPage.pivot.metric.net")}</SelectItem>
              <SelectItem value="income">{t("statsPage.pivot.metric.income")}</SelectItem>
              <SelectItem value="expense">{t("statsPage.pivot.metric.expense")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder={t("statistics.selectYear")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("statsPage.allYears")}</SelectItem>
              {data.allYears.map((y) => (
                <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasExpandable && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              {allCollapsed ? t("statsPage.pivot.expandAll") : t("statsPage.pivot.collapseAll")}
            </Button>
          )}
          <ExclusionToggle
            graphKey={graphKey}
            isFiltered={isFiltered}
            onToggle={onToggle}
            exclusionsApply={exclusionsApply}
          />
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full">
          <div className="min-w-[800px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground sticky left-0 bg-card z-10">
                    {t("statsPage.category")}
                  </th>
                  {filteredPeriods.map((p) => (
                    <th key={p} className="text-right py-2 px-3 font-medium text-muted-foreground whitespace-nowrap">
                      {formatPeriodShort(p)}
                    </th>
                  ))}
                  <th className="text-right py-2 px-3 font-bold text-foreground">
                    {t("statsPage.total")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {hierarchicalCategories.map((group) => {
                  const groupCategoryIds = group.children
                    .map((c) => c.categoryId)
                    .filter((id): id is number => id != null);
                  const expandable = isExpandableGroup(group);
                  const isCollapsed = collapsedGroups.has(group.general);

                  return (
                    <Fragment key={`group-${group.general}`}>
                      <tr className="border-b border-border/50 bg-muted/30">
                        <td className="py-2 px-3 font-semibold sticky left-0 bg-card z-10 whitespace-nowrap">
                          {expandable ? (
                            <button
                              type="button"
                              onClick={() => toggleGroup(group.general)}
                              aria-expanded={!isCollapsed}
                              aria-controls={`pivot-children-${group.general}`}
                              aria-label={
                                isCollapsed
                                  ? t("statsPage.pivot.expandGroup", { name: group.general })
                                  : t("statsPage.pivot.collapseGroup", { name: group.general })
                              }
                              className="inline-flex items-center gap-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 rounded"
                            >
                              {isCollapsed
                                ? <ChevronRight className="h-4 w-4" />
                                : <ChevronDown className="h-4 w-4" />}
                              {group.general}
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 pl-5">{group.general}</span>
                          )}
                        </td>
                        {filteredPeriods.map((p) => {
                          const val = group.months[p] || 0;
                          const canClick = val !== 0 && groupCategoryIds.length > 0;
                          return (
                            <td
                              key={p}
                              onClick={canClick ? () => navigate(buildDrillUrl({
                                categoryIds: groupCategoryIds,
                                period: p,
                                valueMode,
                                label: `${group.general} — ${formatPeriodShort(p)}`,
                              })) : undefined}
                              className={`text-right py-2 px-3 tabular-nums font-semibold ${val === 0 ? "text-muted-foreground/40" : ""} ${val < 0 ? "text-destructive" : ""} ${canClick ? clickableCell : ""}`}
                            >
                              {val === 0 ? "—" : formatCurrency(val)}
                            </td>
                          );
                        })}
                        <td
                          onClick={groupCategoryIds.length > 0 ? () => navigate(buildDrillUrl({
                            categoryIds: groupCategoryIds,
                            valueMode,
                            label: group.general,
                          })) : undefined}
                          className={`text-right py-2 px-3 font-bold tabular-nums ${group.total < 0 ? "text-destructive" : ""} ${groupCategoryIds.length > 0 ? clickableCell : ""}`}
                        >
                          {(() => { const r = formatCompact(group.total); return <span title={r.isCompact ? r.full : undefined}>{r.display}</span>; })()}
                        </td>
                      </tr>
                      {!isCollapsed && group.children.map((cat) => (
                        <tr key={cat.categoryId} id={`pivot-children-${group.general}`} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="py-2 px-3 pl-8 text-muted-foreground sticky left-0 bg-card z-10 whitespace-nowrap">
                            {cat.detailName}
                          </td>
                          {filteredPeriods.map((p) => {
                            const val = getPeriodValue(cat, p);
                            const canClick = val !== 0 && cat.categoryId != null;
                            return (
                              <td
                                key={p}
                                onClick={canClick ? () => navigate(buildDrillUrl({
                                  categoryId: cat.categoryId!,
                                  period: p,
                                  valueMode,
                                  label: `${cat.categoryName} — ${formatPeriodShort(p)}`,
                                })) : undefined}
                                className={`text-right py-2 px-3 tabular-nums ${val === 0 ? "text-muted-foreground/40" : ""} ${val < 0 ? "text-destructive" : ""} ${canClick ? clickableCell : ""}`}
                              >
                                {val === 0 ? "—" : formatCurrency(val)}
                              </td>
                            );
                          })}
                          <td
                            onClick={cat.categoryId != null ? () => navigate(buildDrillUrl({
                              categoryId: cat.categoryId!,
                              valueMode,
                              label: String(cat.categoryName || ''),
                            })) : undefined}
                            className={`text-right py-2 px-3 font-medium tabular-nums ${cat.filteredTotal < 0 ? "text-destructive" : ""} ${cat.categoryId != null ? clickableCell : ""}`}
                          >
                            {formatCurrency(cat.filteredTotal)}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-bold">
                  <td className="py-2 px-3 sticky left-0 bg-card z-10">{t("statsPage.total")}</td>
                  {filteredPeriods.map((p) => {
                    const r = formatCompact(columnTotals[p] || 0);
                    return (
                      <td
                        key={p}
                        onClick={() => navigate(buildDrillUrl({
                          period: p,
                          valueMode,
                          label: formatPeriodShort(p),
                        }))}
                        className={`text-right py-2 px-3 tabular-nums ${clickableCell}`}
                      >
                        <span title={r.isCompact ? r.full : undefined}>{r.display}</span>
                      </td>
                    );
                  })}
                  {(() => {
                    const r = formatCompact(filteredCategories.reduce((s, c) => s + c.filteredTotal, 0));
                    return (
                      <td
                        onClick={() => navigate('/transactions')}
                        className={`text-right py-2 px-3 tabular-nums ${clickableCell}`}
                      >
                        <span title={r.isCompact ? r.full : undefined}>{r.display}</span>
                      </td>
                    );
                  })()}
                </tr>
              </tfoot>
            </table>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
