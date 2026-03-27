import { useState, useMemo, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Check, ChevronsUpDown, Plus, Settings2, X, Bookmark, Pencil, Trash2, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";
import type { StatisticsData } from "@/hooks/useStatistics";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { useCreateSavedChart, useUpdateSavedChart, useDeleteSavedChart, useSavedCharts, type SavedChart } from "@/hooks/useSavedCharts";
import { apiClient } from "@/lib/api";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { getCurrencySymbol, numberFormatToLocale } from "@/utils/currency";

const CHART_COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(142, 76%, 36%)",
  "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)",
  "hsl(340, 82%, 52%)",
  "hsl(190, 80%, 45%)",
  "hsl(30, 90%, 55%)",
  "hsl(260, 70%, 55%)",
  "hsl(170, 65%, 40%)",
  "hsl(350, 75%, 60%)",
];

const RECHARTS_TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  color: "hsl(var(--card-foreground))",
};

type ChartType = "line" | "bar" | "area";

function formatPeriodShort(period: string) {
  try {
    return format(parseISO(`${period}-01`), "MMM yy");
  } catch {
    return period;
  }
}

interface CustomCategoryChartProps {
  data: StatisticsData;
  graphKey: string;
  isFiltered: boolean;
  onToggle: (key: string) => void;
  exclusionsApply: boolean;
  /** When provided, the chart is in "saved" mode — pre-loaded from a persisted config */
  savedChart?: SavedChart;
  /** Hide save / rename / delete controls (embedding mode) */
  hideSaveControls?: boolean;
  /** Persist user selection locally (localStorage) under graphKey */
  persistSelection?: boolean;
  /** Optional tooltip text shown in the header */
  headerTooltip?: string;
}

export function CustomCategoryChart({
  data,
  graphKey,
  isFiltered,
  onToggle,
  exclusionsApply,
  savedChart,
  hideSaveControls = false,
  persistSelection = false,
  headerTooltip,
}: CustomCategoryChartProps) {
  const isSavedMode = !!savedChart;

  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>(
    savedChart ? savedChart.category_ids : []
  );
  const [chartType, setChartType] = useState<ChartType>(
    savedChart ? (savedChart.chart_type as ChartType) : "line"
  );
  const [showSettings, setShowSettings] = useState(!isSavedMode);
  const [comboboxOpen, setComboboxOpen] = useState(false);

  // Save dialog (builder mode only)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  // Rename state (saved mode)
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(savedChart?.name ?? "");

  // Delete confirm
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const createChart = useCreateSavedChart();
  const updateChart = useUpdateSavedChart();
  const deleteChart = useDeleteSavedChart();
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);

  // Auto-save config changes in saved mode (debounced)
  const pendingUpdate = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isSavedMode || !savedChart) return;
    if (pendingUpdate.current) clearTimeout(pendingUpdate.current);
    pendingUpdate.current = setTimeout(() => {
      updateChart.mutate({
        id: savedChart.id,
        chartType,
        categoryIds: selectedCategoryIds,
      });
    }, 800);
    return () => { if (pendingUpdate.current) clearTimeout(pendingUpdate.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType, selectedCategoryIds]);

  // Persist selection in DB when requested (auto-create/update a hidden saved chart)
  const savedChartsQuery = useSavedCharts();
  const autoSavedIdRef = useRef<number | null>(null);

  // On load, try to find an existing auto-saved chart for this graphKey and load it
  useEffect(() => {
    if (!persistSelection) return;
    if (!savedChartsQuery.data) return;
    const name = `autochart:${graphKey}`;
    const found = (savedChartsQuery.data || []).find((c) => c.name === name);
    if (found) {
      autoSavedIdRef.current = found.id;
      // If not provided by prop, adopt stored selection
      if (!savedChart) {
        setSelectedCategoryIds(found.category_ids || []);
        setChartType(found.chart_type ?? chartType);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedChartsQuery.data, persistSelection]);

  // When selection changes, create or update the stored chart in DB
  useEffect(() => {
    if (!persistSelection) return;
    // only persist when user has actually selected categories
    if (!selectedCategoryIds || selectedCategoryIds.length === 0) return;

    const name = `autochart:${graphKey}`;

    if (autoSavedIdRef.current) {
      // update existing
      apiClient.updateSavedChart(autoSavedIdRef.current, { chartType, categoryIds: selectedCategoryIds }).catch(() => {
        // ignore errors for now
      });
    } else {
      // create new
      apiClient.createSavedChart({ name, chartType, categoryIds: selectedCategoryIds }).then((res) => {
        if (res && res.id) autoSavedIdRef.current = res.id;
      }).catch(() => {
        // ignore
      });
    }
  }, [selectedCategoryIds, chartType, persistSelection, graphKey]);

  const availableCategories = useMemo(() => {
    return data.categoryPivot.map(c => ({
      id: c.categoryId,
      name: c.categoryName,
      total: c.total,
    }));
  }, [data.categoryPivot]);

  const selectedCategories = useMemo(() => {
    return data.categoryPivot.filter(c => selectedCategoryIds.includes(c.categoryId));
  }, [data.categoryPivot, selectedCategoryIds]);

  const chartData = useMemo(() => {
    if (selectedCategories.length === 0) return [];
    return data.allPeriods.map(period => {
      const point: Record<string, any> = { period: formatPeriodShort(period) };
      for (const cat of selectedCategories) {
        point[cat.categoryName] = Math.round(cat.months[period] || 0);
      }
      return point;
    });
  }, [data.allPeriods, selectedCategories]);

  const toggleCategory = (catId: number) => {
    setSelectedCategoryIds(prev =>
      prev.includes(catId) ? prev.filter(id => id !== catId) : [...prev, catId]
    );
  };

  const removeCategory = (catId: number) => {
    setSelectedCategoryIds(prev => prev.filter(id => id !== catId));
  };

  const handleSave = () => {
    if (!saveName.trim()) return;
    createChart.mutate({
      name: saveName.trim(),
      chartType,
      categoryIds: selectedCategoryIds,
    }, {
      onSuccess: () => {
        setSaveDialogOpen(false);
        setSaveName("");
      },
    });
  };

  const handleRename = () => {
    if (!savedChart || !renameValue.trim()) return;
    updateChart.mutate({ id: savedChart.id, name: renameValue.trim() }, {
      onSuccess: () => setIsRenaming(false),
    });
  };

  const handleDelete = () => {
    if (!savedChart) return;
    deleteChart.mutate(savedChart.id);
  };

  const title = isSavedMode
    ? (isRenaming ? "" : savedChart!.name)
    : t('customChart.comparison');

  const description = selectedCategories.length === 0
    ? t('customChart.selectDesc')
    : t('customChart.comparing', { n: selectedCategories.length, catWord: selectedCategories.length === 1 ? t('customChart.category') : t('customChart.categories') });

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-4">
          <div className="flex-1 min-w-0">
            {isSavedMode && isRenaming ? (
              <div className="flex items-center gap-2">
                <Input
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setIsRenaming(false); }}
                  className="h-8 text-base font-semibold w-48"
                  autoFocus
                />
                <Button size="sm" onClick={handleRename} disabled={updateChart.isPending}>
                  {t('common.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIsRenaming(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
              ) : (
                <div className="flex items-center gap-2">
                  <CardTitle className="truncate">{title}</CardTitle>
                  {/* Show rename only when saved mode AND save controls are allowed */}
                  {isSavedMode && !hideSaveControls && (
                    <button
                      onClick={() => { setRenameValue(savedChart!.name); setIsRenaming(true); }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title={t('customChart.rename')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            <div className="flex items-center gap-2">
              <CardDescription className="flex-1">{description}</CardDescription>
              {/* headerTooltip intentionally omitted — showing a tooltip here caused layout/behavior issues */}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Save button — builder mode only, shown when categories selected */}
            {!isSavedMode && selectedCategories.length > 0 && !hideSaveControls && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSaveDialogOpen(true)}
              >
                <Bookmark className="h-4 w-4 mr-1" />
                {t('customChart.saveChart')}
              </Button>
            )}
            {/* Delete button — saved mode */}
            {isSavedMode && !hideSaveControls && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSettings(prev => !prev)}
            >
              <Settings2 className="h-4 w-4 mr-1" />
              {t('customChart.settings')}
            </Button>
            <ExclusionToggle
              graphKey={graphKey}
              isFiltered={isFiltered}
              onToggle={onToggle}
              exclusionsApply={exclusionsApply}
            />
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {showSettings && (
            <div className="space-y-3 p-4 rounded-lg border border-border bg-muted/30">
              {/* Category selector */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('customChart.categoriesLabel')}</label>
                <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={comboboxOpen}
                      className="w-full justify-between font-normal"
                    >
                      <span className="text-muted-foreground">
                        <Plus className="h-4 w-4 inline mr-1" />
                        {t('customChart.addCategory')}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[320px] p-0 bg-popover border border-border shadow-lg z-50" align="start">
                    <Command>
                       <CommandInput placeholder={t('customChart.searchCategories')} />
                       <CommandList>
                         <CommandEmpty>{t('customChart.noCategoriesFound')}</CommandEmpty>
                        <CommandGroup>
                          {availableCategories.map(cat => (
                            <CommandItem
                              key={cat.id}
                              value={cat.name}
                              onSelect={() => toggleCategory(cat.id)}
                            >
                              <Check className={cn("mr-2 h-4 w-4", selectedCategoryIds.includes(cat.id) ? "opacity-100" : "opacity-0")} />
                              <span className="flex-1 truncate">{cat.name}</span>
                              <span className="text-xs text-muted-foreground ml-2">{formatCurrency(cat.total)}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>

                {/* Selected badges */}
                {selectedCategoryIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedCategories.map((cat, i) => (
                      <Badge
                        key={cat.categoryId}
                        variant="secondary"
                        className="gap-1 pr-1"
                        style={{ borderLeftColor: CHART_COLORS[i % CHART_COLORS.length], borderLeftWidth: 3 }}
                      >
                        <span className="truncate max-w-[150px]">{cat.categoryName}</span>
                        <button
                          onClick={() => removeCategory(cat.categoryId)}
                          className="ml-1 rounded-full hover:bg-muted p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                    {selectedCategoryIds.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground"
                        onClick={() => setSelectedCategoryIds([])}
                      >
                        {t('customChart.clearAll')}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Chart type */}
              <div className="flex gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('customChart.chartType')}</label>
                  <Select value={chartType} onValueChange={(v) => setChartType(v as ChartType)}>
                    <SelectTrigger className="w-[110px] h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="line">{t('customChart.line')}</SelectItem>
                      <SelectItem value="bar">{t('customChart.bar')}</SelectItem>
                      <SelectItem value="area">{t('customChart.area')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Chart */}
          {selectedCategories.length === 0 ? (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">
              <div className="text-center space-y-2">
                <Settings2 className="h-8 w-8 mx-auto opacity-40" />
                <p className="text-sm">{t('customChart.selectPrompt')}</p>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={350}>
              {chartType === "bar" ? (
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
                  <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  {selectedCategories.map((cat, i) => (
                    <Bar key={cat.categoryId} dataKey={cat.categoryName} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
                  ))}
                </BarChart>
              ) : chartType === "area" ? (
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
                  <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  {selectedCategories.map((cat, i) => (
                    <Area key={cat.categoryId} type="monotone" dataKey={cat.categoryName}
                      stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]}
                      fillOpacity={0.15} strokeWidth={2} />
                  ))}
                </AreaChart>
              ) : (
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
                  <RechartsTooltip contentStyle={RECHARTS_TOOLTIP_STYLE} formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  {selectedCategories.map((cat, i) => (
                    <Line key={cat.categoryId} type="monotone" dataKey={cat.categoryName}
                      stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Save dialog (builder mode) */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('customChart.saveDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('customChart.saveDialog.desc')}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t('customChart.saveNamePlaceholder')}
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
            autoFocus
          />
            <DialogFooter>
              <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleSave} disabled={!saveName.trim() || createChart.isPending}>
                {createChart.isPending ? t('customChart.saving') : t('common.save')}
              </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog (saved mode) */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('customChart.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('customChart.deleteDesc', { name: savedChart?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteChart.isPending}>
              {deleteChart.isPending ? t('customChart.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
