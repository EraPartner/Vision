import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreateSavedChart, useUpdateSavedChart } from "@/hooks/useSavedCharts";
import { useRecipients } from "@/hooks/useRecipients";
import { useTags } from "@/hooks/useTags";
import type { StatisticsData } from "@/hooks/useStatistics";
import type { SavedChart, ChartType, ChartVariant, TimeBucket } from "@/lib/api/types";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { CustomChart } from "./CustomChart";

const CHART_COLORS = Array.from({ length: 16 }, (_, i) => `hsl(var(--chart-${(i % 8) + 1}))`);

type ChartCombo = { type: ChartType; variant: ChartVariant; label: string };

const CHART_COMBOS: ChartCombo[] = [
  { type: 'line', variant: 'default', label: 'customChart.line' },
  { type: 'bar', variant: 'default', label: 'customChart.bar' },
  { type: 'bar', variant: 'stacked', label: 'customChart.barStacked' },
  { type: 'bar', variant: 'grouped', label: 'customChart.barGrouped' },
  { type: 'bar', variant: 'ranked', label: 'customChart.barRanked' },
  { type: 'area', variant: 'default', label: 'customChart.area' },
  { type: 'area', variant: 'stacked', label: 'customChart.areaStacked' },
];

function comboKey(type: ChartType, variant: ChartVariant) {
  return `${type}:${variant}`;
}

interface BuilderState {
  name: string;
  chartType: ChartType;
  chartVariant: ChartVariant;
  timeBucket: TimeBucket;
  categoryIds: number[];
  recipientIds: number[];
  tagIds: number[];
  allCategories: boolean;
  allRecipients: boolean;
  allTags: boolean;
  dateRangeStart: string;
  dateRangeEnd: string;
}

function stateToSavedChartPreview(state: BuilderState, id: number): SavedChart {
  return {
    id,
    name: state.name || 'Preview',
    chart_type: state.chartType,
    chart_variant: state.chartVariant,
    time_bucket: state.timeBucket,
    category_ids: state.categoryIds,
    recipient_ids: state.recipientIds,
    tag_ids: state.tagIds,
    all_categories: state.allCategories,
    all_recipients: state.allRecipients,
    all_tags: state.allTags,
    date_range_start: state.dateRangeStart || null,
    date_range_end: state.dateRangeEnd || null,
    created_at: '',
    updated_at: '',
  };
}

interface CustomChartBuilderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: StatisticsData;
  editChart?: SavedChart;
}

export function CustomChartBuilderModal({ open, onOpenChange, data, editChart }: CustomChartBuilderModalProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);

  const isEdit = !!editChart;

  const [state, setState] = useState<BuilderState>(() => ({
    name: editChart?.name ?? '',
    chartType: editChart?.chart_type ?? 'line',
    chartVariant: editChart?.chart_variant ?? 'default',
    timeBucket: editChart?.time_bucket ?? 'monthly',
    categoryIds: editChart?.category_ids ?? [],
    recipientIds: editChart?.recipient_ids ?? [],
    tagIds: editChart?.tag_ids ?? [],
    allCategories: editChart?.all_categories ?? false,
    allRecipients: editChart?.all_recipients ?? false,
    allTags: editChart?.all_tags ?? false,
    dateRangeStart: editChart?.date_range_start ?? '',
    dateRangeEnd: editChart?.date_range_end ?? '',
  }));

  const [catOpen, setCatOpen] = useState(false);
  const [recOpen, setRecOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);

  const createChart = useCreateSavedChart();
  const updateChart = useUpdateSavedChart();

  const recipientsQuery = useRecipients({ active: true, limit: 200 });
  const allRecipients = recipientsQuery.data?.items ?? [];

  const tagsQuery = useTags({ is_active: true });
  const allTags = tagsQuery.data?.items ?? [];

  const availableCategories = useMemo(() => {
    return data.categoryPivot
      .filter((c) => c.categoryId !== null)
      .map((c) => ({ id: c.categoryId as number, name: c.categoryName, total: c.total }));
  }, [data.categoryPivot]);

  const selectedCats = availableCategories.filter((c) => state.categoryIds.includes(c.id));
  const selectedRecs = allRecipients.filter((r) => state.recipientIds.includes(r.id));
  const selectedTags = allTags.filter((tg) => state.tagIds.includes(tg.id));

  const update = <K extends keyof BuilderState>(key: K, value: BuilderState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  };

  const toggleCategory = (id: number) => {
    setState((prev) => ({
      ...prev,
      categoryIds: prev.categoryIds.includes(id) ? prev.categoryIds.filter((x) => x !== id) : [...prev.categoryIds, id],
    }));
  };

  const toggleRecipient = (id: number) => {
    setState((prev) => ({
      ...prev,
      recipientIds: prev.recipientIds.includes(id) ? prev.recipientIds.filter((x) => x !== id) : [...prev.recipientIds, id],
    }));
  };

  const toggleTag = (id: number) => {
    setState((prev) => ({
      ...prev,
      tagIds: prev.tagIds.includes(id) ? prev.tagIds.filter((x) => x !== id) : [...prev.tagIds, id],
    }));
  };

  const selectedComboKey = comboKey(state.chartType, state.chartVariant);

  const handleComboChange = (key: string) => {
    const combo = CHART_COMBOS.find((c) => comboKey(c.type, c.variant) === key);
    if (combo) setState((prev) => ({ ...prev, chartType: combo.type, chartVariant: combo.variant }));
  };

  const canSave = state.name.trim().length > 0 && (
    state.categoryIds.length > 0 || state.recipientIds.length > 0 || state.tagIds.length > 0 ||
    state.allCategories || state.allRecipients || state.allTags
  );

  const handleSave = () => {
    const payload = {
      name: state.name.trim(),
      chartType: state.chartType,
      chartVariant: state.chartVariant,
      timeBucket: state.timeBucket,
      categoryIds: state.categoryIds,
      recipientIds: state.recipientIds,
      tagIds: state.tagIds,
      allCategories: state.allCategories,
      allRecipients: state.allRecipients,
      allTags: state.allTags,
      dateRangeStart: state.dateRangeStart || null,
      dateRangeEnd: state.dateRangeEnd || null,
    };

    if (isEdit && editChart) {
      updateChart.mutate({ id: editChart.id, ...payload }, { onSuccess: () => onOpenChange(false) });
    } else {
      createChart.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  const previewChart = stateToSavedChartPreview(state, editChart?.id ?? -1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('customChart.builder.editTitle') : t('customChart.builder.createTitle')}</DialogTitle>
          <DialogDescription>{t('customChart.builder.desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 py-2">
          {/* Left: config form */}
          <div className="space-y-4">
            {/* Name */}
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('customChart.builder.name')}</label>
              <Input
                value={state.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder={t('customChart.builder.namePlaceholder')}
                autoFocus={!isEdit}
              />
            </div>

            {/* Chart type combo */}
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('customChart.chartType')}</label>
              <Select value={selectedComboKey} onValueChange={handleComboChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHART_COMBOS.map((c) => (
                    <SelectItem key={comboKey(c.type, c.variant)} value={comboKey(c.type, c.variant)}>
                      {t(c.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Time bucket — irrelevant for ranked (totals over the whole range) */}
            {state.chartVariant !== 'ranked' && (
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('customChart.timeBucket')}</label>
                <Select value={state.timeBucket} onValueChange={(v) => update('timeBucket', v as TimeBucket)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">{t('customChart.monthly')}</SelectItem>
                    <SelectItem value="yearly">{t('customChart.yearly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Date range */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('customChart.dateFrom')}</label>
                <Input type="date" value={state.dateRangeStart} onChange={(e) => update('dateRangeStart', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{t('customChart.dateTo')}</label>
                <Input type="date" value={state.dateRangeEnd} onChange={(e) => update('dateRangeEnd', e.target.value)} />
              </div>
            </div>

            {/* Category picker */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t('customChart.categoriesLabel')}</label>
                <div className="flex items-center gap-2">
                  <Switch id="all-categories" checked={state.allCategories} onCheckedChange={(v) => update('allCategories', v)} />
                  <Label htmlFor="all-categories" className="text-xs font-normal text-muted-foreground">{t('customChart.allCategories')}</Label>
                </div>
              </div>
              {state.allCategories ? (
                <p className="text-xs text-muted-foreground">{t('customChart.allHint')}</p>
              ) : (
                <>
              <Popover open={catOpen} onOpenChange={setCatOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={catOpen} className="w-full justify-between font-normal">
                    <span className="text-muted-foreground">
                      <Plus className="h-4 w-4 inline mr-1" />
                      {t('customChart.addCategory')}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[300px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('customChart.searchCategories')} />
                    <CommandList>
                      <CommandEmpty>{t('customChart.noCategoriesFound')}</CommandEmpty>
                      <CommandGroup>
                        {availableCategories.map((cat) => (
                          <CommandItem key={cat.id} value={cat.name} onSelect={() => toggleCategory(cat.id)}>
                            <Check className={cn("mr-2 h-4 w-4", state.categoryIds.includes(cat.id) ? "opacity-100" : "opacity-0")} />
                            <span className="flex-1 truncate">{cat.name}</span>
                            <span className="text-xs text-muted-foreground ml-2">{formatCurrency(cat.total)}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedCats.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedCats.map((cat, i) => (
                    <Badge
                      key={cat.id}
                      variant="secondary"
                      className="gap-1 pr-1"
                      style={{ borderLeftColor: CHART_COLORS[i % CHART_COLORS.length], borderLeftWidth: 3 }}
                    >
                      <span className="truncate max-w-[150px]">{cat.name}</span>
                      <button onClick={() => toggleCategory(cat.id)} className="ml-1 rounded-full hover:bg-muted p-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
                </>
              )}
            </div>

            {/* Recipient picker */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t('customChart.recipientsLabel')}</label>
                <div className="flex items-center gap-2">
                  <Switch id="all-recipients" checked={state.allRecipients} onCheckedChange={(v) => update('allRecipients', v)} />
                  <Label htmlFor="all-recipients" className="text-xs font-normal text-muted-foreground">{t('customChart.allRecipients')}</Label>
                </div>
              </div>
              {state.allRecipients ? (
                <p className="text-xs text-muted-foreground">{t('customChart.allHint')}</p>
              ) : (
                <>
              <Popover open={recOpen} onOpenChange={setRecOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={recOpen} className="w-full justify-between font-normal">
                    <span className="text-muted-foreground">
                      <Plus className="h-4 w-4 inline mr-1" />
                      {t('customChart.addRecipient')}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[300px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('customChart.searchRecipients')} />
                    <CommandList>
                      <CommandEmpty>{t('customChart.noRecipientsFound')}</CommandEmpty>
                      <CommandGroup>
                        {allRecipients.map((rec) => (
                          <CommandItem key={rec.id} value={rec.name} onSelect={() => toggleRecipient(rec.id)}>
                            <Check className={cn("mr-2 h-4 w-4", state.recipientIds.includes(rec.id) ? "opacity-100" : "opacity-0")} />
                            <span className="flex-1 truncate">{rec.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedRecs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedRecs.map((rec, i) => (
                    <Badge
                      key={rec.id}
                      variant="secondary"
                      className="gap-1 pr-1"
                      style={{ borderLeftColor: CHART_COLORS[(selectedCats.length + i) % CHART_COLORS.length], borderLeftWidth: 3 }}
                    >
                      <span className="truncate max-w-[150px]">{rec.name}</span>
                      <button onClick={() => toggleRecipient(rec.id)} className="ml-1 rounded-full hover:bg-muted p-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
                </>
              )}
            </div>

            {/* Tag picker */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t('customChart.tagsLabel')}</label>
                <div className="flex items-center gap-2">
                  <Switch id="all-tags" checked={state.allTags} onCheckedChange={(v) => update('allTags', v)} />
                  <Label htmlFor="all-tags" className="text-xs font-normal text-muted-foreground">{t('customChart.allTags')}</Label>
                </div>
              </div>
              {state.allTags ? (
                <p className="text-xs text-muted-foreground">{t('customChart.allHint')}</p>
              ) : (
                <>
              <Popover open={tagOpen} onOpenChange={setTagOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={tagOpen} className="w-full justify-between font-normal">
                    <span className="text-muted-foreground">
                      <Plus className="h-4 w-4 inline mr-1" />
                      {t('customChart.addTag')}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[300px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('customChart.searchTags')} />
                    <CommandList>
                      <CommandEmpty>{t('customChart.noTagsFound')}</CommandEmpty>
                      <CommandGroup>
                        {allTags.map((tag) => (
                          <CommandItem key={tag.id} value={tag.slug} onSelect={() => toggleTag(tag.id)}>
                            <Check className={cn("mr-2 h-4 w-4", state.tagIds.includes(tag.id) ? "opacity-100" : "opacity-0")} />
                            <span className="flex-1 truncate">#{tag.slug}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedTags.map((tag, i) => (
                    <Badge
                      key={tag.id}
                      variant="secondary"
                      className="gap-1 pr-1"
                      style={{ borderLeftColor: CHART_COLORS[(selectedCats.length + selectedRecs.length + i) % CHART_COLORS.length], borderLeftWidth: 3 }}
                    >
                      <span className="truncate max-w-[150px]">#{tag.slug}</span>
                      <button onClick={() => toggleTag(tag.id)} className="ml-1 rounded-full hover:bg-muted p-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
                </>
              )}
            </div>
          </div>

          {/* Right: live preview */}
          <div className="min-w-0">
            <p className="text-sm font-medium mb-2 text-muted-foreground">{t('customChart.builder.preview')}</p>
            <CustomChart savedChart={previewChart} data={data} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} disabled={!canSave || createChart.isPending || updateChart.isPending}>
            {(createChart.isPending || updateChart.isPending) ? t('customChart.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
