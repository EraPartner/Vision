import { useState, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/lib/dateUtils";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    useCreateSavedChart,
    useUpdateSavedChart,
} from "@/hooks/useSavedCharts";
import { useRecipients } from "@/hooks/useRecipients";
import { useTags } from "@/hooks/useTags";
import type { StatisticsData } from "@/hooks/useStatistics";
import type {
    SavedChart,
    ChartType,
    ChartVariant,
    TimeBucket,
} from "@/types/apiClient";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { CustomChart } from "./CustomChart";
import { getChartColor } from "@/components/charts/palette";

type ChartCombo = { type: ChartType; variant: ChartVariant; label: string };

const CHART_COMBOS: ChartCombo[] = [
    { type: "line", variant: "default", label: "customChart.line" },
    { type: "bar", variant: "default", label: "customChart.bar" },
    { type: "bar", variant: "stacked", label: "customChart.barStacked" },
    { type: "bar", variant: "grouped", label: "customChart.barGrouped" },
    { type: "bar", variant: "ranked", label: "customChart.barRanked" },
    { type: "area", variant: "default", label: "customChart.area" },
    { type: "area", variant: "stacked", label: "customChart.areaStacked" },
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
        name: state.name || "Preview",
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
        created_at: "",
        updated_at: "",
    };
}

interface CustomChartBuilderModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    data: StatisticsData;
    editChart?: SavedChart;
    onCloseAutoFocus?: () => void;
}

export function CustomChartBuilderModal({
    open,
    onOpenChange,
    data,
    editChart,
    onCloseAutoFocus,
}: CustomChartBuilderModalProps) {
    const { t } = useLanguage();
    const fieldId = useId();
    const formatCurrencyBase = useCurrencyFormatter();
    const formatCurrency = (val: number) =>
        formatCurrencyBase(val, { decimals: 0 });

    const isEdit = !!editChart;

    const [state, setState] = useState<BuilderState>(() => ({
        name: editChart?.name ?? "",
        chartType: editChart?.chart_type ?? "line",
        chartVariant: editChart?.chart_variant ?? "default",
        timeBucket: editChart?.time_bucket ?? "monthly",
        categoryIds: editChart?.category_ids ?? [],
        recipientIds: editChart?.recipient_ids ?? [],
        tagIds: editChart?.tag_ids ?? [],
        allCategories: editChart?.all_categories ?? false,
        allRecipients: editChart?.all_recipients ?? false,
        allTags: editChart?.all_tags ?? false,
        dateRangeStart: editChart?.date_range_start ?? "",
        dateRangeEnd: editChart?.date_range_end ?? "",
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
            .map((c) => ({
                id: c.categoryId as number,
                name: c.categoryName,
                total: c.total,
            }));
    }, [data.categoryPivot]);

    const selectedCats = availableCategories.filter((c) =>
        state.categoryIds.includes(c.id),
    );
    const selectedRecs = allRecipients.filter((r) =>
        state.recipientIds.includes(r.id),
    );
    const selectedTags = allTags.filter((tg) => state.tagIds.includes(tg.id));

    const update = <K extends keyof BuilderState>(
        key: K,
        value: BuilderState[K],
    ) => {
        setState((prev) => ({ ...prev, [key]: value }));
    };

    const toggleCategory = (id: number) => {
        setState((prev) => ({
            ...prev,
            categoryIds: prev.categoryIds.includes(id)
                ? prev.categoryIds.filter((x) => x !== id)
                : [...prev.categoryIds, id],
        }));
    };

    const toggleRecipient = (id: number) => {
        setState((prev) => ({
            ...prev,
            recipientIds: prev.recipientIds.includes(id)
                ? prev.recipientIds.filter((x) => x !== id)
                : [...prev.recipientIds, id],
        }));
    };

    const toggleTag = (id: number) => {
        setState((prev) => ({
            ...prev,
            tagIds: prev.tagIds.includes(id)
                ? prev.tagIds.filter((x) => x !== id)
                : [...prev.tagIds, id],
        }));
    };

    const selectedComboKey = comboKey(state.chartType, state.chartVariant);

    const handleComboChange = (key: string) => {
        const combo = CHART_COMBOS.find(
            (c) => comboKey(c.type, c.variant) === key,
        );
        if (combo)
            setState((prev) => ({
                ...prev,
                chartType: combo.type,
                chartVariant: combo.variant,
            }));
    };

    const canSave =
        state.name.trim().length > 0 &&
        (state.categoryIds.length > 0 ||
            state.recipientIds.length > 0 ||
            state.tagIds.length > 0 ||
            state.allCategories ||
            state.allRecipients ||
            state.allTags);

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSave || createChart.isPending || updateChart.isPending) return;
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
            updateChart.mutate(
                { id: editChart.id, ...payload },
                { onSuccess: () => onOpenChange(false) },
            );
        } else {
            createChart.mutate(payload, {
                onSuccess: () => onOpenChange(false),
            });
        }
    };

    const previewChart = stateToSavedChartPreview(state, editChart?.id ?? -1);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="max-w-4xl"
                onCloseAutoFocus={(event) => {
                    if (onCloseAutoFocus) {
                        event.preventDefault();
                        onCloseAutoFocus();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>
                        {isEdit
                            ? t("customChart.builder.editTitle")
                            : t("customChart.builder.createTitle")}
                    </DialogTitle>
                    <DialogDescription>
                        {t("customChart.builder.desc")}
                    </DialogDescription>
                </DialogHeader>

                {/* Real <form> so Enter in the name field saves. grid gap-5 mirrors
            DialogContent's layout, so the wrapper is layout-neutral. */}
                <form onSubmit={handleSave} className="grid gap-5">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 py-2">
                        {/* Left: config form */}
                        <div className="space-y-4">
                            {/* Name */}
                            <div className="space-y-1">
                                <Label htmlFor={`${fieldId}-name`}>
                                    {t("customChart.builder.name")}
                                </Label>
                                <Input
                                    id={`${fieldId}-name`}
                                    value={state.name}
                                    onChange={(e) =>
                                        update("name", e.target.value)
                                    }
                                    placeholder={t(
                                        "customChart.builder.namePlaceholder",
                                    )}
                                    autoFocus={!isEdit}
                                />
                            </div>

                            {/* Chart type combo */}
                            <div className="space-y-1">
                                <Label htmlFor={`${fieldId}-type`}>
                                    {t("customChart.chartType")}
                                </Label>
                                <Select
                                    value={selectedComboKey}
                                    onValueChange={handleComboChange}
                                >
                                    <SelectTrigger
                                        id={`${fieldId}-type`}
                                        className="w-full"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {CHART_COMBOS.map((c) => (
                                            <SelectItem
                                                key={comboKey(
                                                    c.type,
                                                    c.variant,
                                                )}
                                                value={comboKey(
                                                    c.type,
                                                    c.variant,
                                                )}
                                            >
                                                {t(c.label)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Time bucket — irrelevant for ranked (totals over the whole range) */}
                            {state.chartVariant !== "ranked" && (
                                <SegmentedControl
                                    label={t("customChart.timeBucket")}
                                    wrapperClassName="space-y-1"
                                    value={state.timeBucket}
                                    onValueChange={(v) =>
                                        update("timeBucket", v as TimeBucket)
                                    }
                                    className="w-full"
                                >
                                    <SegmentedControlItem value="monthly">
                                        {t("customChart.monthly")}
                                    </SegmentedControlItem>
                                    <SegmentedControlItem value="yearly">
                                        {t("customChart.yearly")}
                                    </SegmentedControlItem>
                                </SegmentedControl>
                            )}

                            {/* Date range */}
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="space-y-1">
                                    <Label htmlFor={`${fieldId}-from`}>
                                        {t("customChart.dateFrom")}
                                    </Label>
                                    <DatePicker
                                        id={`${fieldId}-from`}
                                        value={
                                            state.dateRangeStart
                                                ? parseLocalDateFromYmd(
                                                      state.dateRangeStart,
                                                  )
                                                : undefined
                                        }
                                        onChange={(d) =>
                                            update(
                                                "dateRangeStart",
                                                d ? toYmd(d) : "",
                                            )
                                        }
                                        placeholder={t("customChart.dateFrom")}
                                        allowClear
                                        clearLabel={t("common.clear")}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label htmlFor={`${fieldId}-to`}>
                                        {t("customChart.dateTo")}
                                    </Label>
                                    <DatePicker
                                        id={`${fieldId}-to`}
                                        value={
                                            state.dateRangeEnd
                                                ? parseLocalDateFromYmd(
                                                      state.dateRangeEnd,
                                                  )
                                                : undefined
                                        }
                                        onChange={(d) =>
                                            update(
                                                "dateRangeEnd",
                                                d ? toYmd(d) : "",
                                            )
                                        }
                                        placeholder={t("customChart.dateTo")}
                                        allowClear
                                        clearLabel={t("common.clear")}
                                    />
                                </div>
                            </div>

                            {/* Category picker */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="type-body font-medium text-label-primary">
                                        {t("customChart.categoriesLabel")}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <Switch
                                            id="all-categories"
                                            checked={state.allCategories}
                                            onCheckedChange={(v) =>
                                                update("allCategories", v)
                                            }
                                        />
                                        <Label
                                            htmlFor="all-categories"
                                            className="type-footnote font-normal text-label-secondary"
                                        >
                                            {t("customChart.allCategories")}
                                        </Label>
                                    </div>
                                </div>
                                {state.allCategories ? (
                                    <p className="type-footnote text-label-secondary">
                                        {t("customChart.allHint")}
                                    </p>
                                ) : (
                                    <>
                                        <Popover
                                            open={catOpen}
                                            onOpenChange={setCatOpen}
                                        >
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    role="combobox"
                                                    aria-label={t(
                                                        "customChart.addCategory",
                                                    )}
                                                    aria-expanded={catOpen}
                                                    className="w-full justify-between font-normal"
                                                >
                                                    <span className="inline-flex items-center gap-1 text-label-secondary">
                                                        <Plus className="h-4 w-4" />
                                                        {t(
                                                            "customChart.addCategory",
                                                        )}
                                                    </span>
                                                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent
                                                className="w-[300px] p-0"
                                                align="start"
                                            >
                                                <Command>
                                                    <CommandInput
                                                        placeholder={t(
                                                            "customChart.searchCategories",
                                                        )}
                                                    />
                                                    <CommandList>
                                                        <CommandEmpty>
                                                            {t(
                                                                "customChart.noCategoriesFound",
                                                            )}
                                                        </CommandEmpty>
                                                        <CommandGroup>
                                                            {availableCategories.map(
                                                                (cat) => (
                                                                    <CommandItem
                                                                        key={
                                                                            cat.id
                                                                        }
                                                                        value={
                                                                            cat.name
                                                                        }
                                                                        onSelect={() =>
                                                                            toggleCategory(
                                                                                cat.id,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Check
                                                                            className={cn(
                                                                                "mr-2 h-4 w-4",
                                                                                state.categoryIds.includes(
                                                                                    cat.id,
                                                                                )
                                                                                    ? "opacity-100"
                                                                                    : "opacity-0",
                                                                            )}
                                                                        />
                                                                        <span className="flex-1 truncate">
                                                                            {
                                                                                cat.name
                                                                            }
                                                                        </span>
                                                                        <span className="ml-2 type-footnote text-label-secondary">
                                                                            {formatCurrency(
                                                                                cat.total,
                                                                            )}
                                                                        </span>
                                                                    </CommandItem>
                                                                ),
                                                            )}
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
                                                        style={{
                                                            borderLeftColor:
                                                                getChartColor(
                                                                    i,
                                                                ),
                                                            borderLeftWidth: 3,
                                                        }}
                                                    >
                                                        <span className="truncate max-w-[150px]">
                                                            {cat.name}
                                                        </span>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            className="ml-1 h-5 w-5 rounded-chip text-label-secondary hover:text-foreground [&_svg]:size-3"
                                                            aria-label={t(
                                                                "customChart.removeSeries",
                                                                {
                                                                    name: cat.name,
                                                                },
                                                            )}
                                                            onClick={() =>
                                                                toggleCategory(
                                                                    cat.id,
                                                                )
                                                            }
                                                        >
                                                            <X />
                                                        </Button>
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
                                    <span className="type-body font-medium text-label-primary">
                                        {t("customChart.recipientsLabel")}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <Switch
                                            id="all-recipients"
                                            checked={state.allRecipients}
                                            onCheckedChange={(v) =>
                                                update("allRecipients", v)
                                            }
                                        />
                                        <Label
                                            htmlFor="all-recipients"
                                            className="type-footnote font-normal text-label-secondary"
                                        >
                                            {t("customChart.allRecipients")}
                                        </Label>
                                    </div>
                                </div>
                                {state.allRecipients ? (
                                    <p className="type-footnote text-label-secondary">
                                        {t("customChart.allHint")}
                                    </p>
                                ) : (
                                    <>
                                        <Popover
                                            open={recOpen}
                                            onOpenChange={setRecOpen}
                                        >
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    role="combobox"
                                                    aria-label={t(
                                                        "customChart.addRecipient",
                                                    )}
                                                    aria-expanded={recOpen}
                                                    className="w-full justify-between font-normal"
                                                >
                                                    <span className="inline-flex items-center gap-1 text-label-secondary">
                                                        <Plus className="h-4 w-4" />
                                                        {t(
                                                            "customChart.addRecipient",
                                                        )}
                                                    </span>
                                                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent
                                                className="w-[300px] p-0"
                                                align="start"
                                            >
                                                <Command>
                                                    <CommandInput
                                                        placeholder={t(
                                                            "customChart.searchRecipients",
                                                        )}
                                                    />
                                                    <CommandList>
                                                        <CommandEmpty>
                                                            {t(
                                                                "customChart.noRecipientsFound",
                                                            )}
                                                        </CommandEmpty>
                                                        <CommandGroup>
                                                            {allRecipients.map(
                                                                (rec) => (
                                                                    <CommandItem
                                                                        key={
                                                                            rec.id
                                                                        }
                                                                        value={
                                                                            rec.name
                                                                        }
                                                                        onSelect={() =>
                                                                            toggleRecipient(
                                                                                rec.id,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Check
                                                                            className={cn(
                                                                                "mr-2 h-4 w-4",
                                                                                state.recipientIds.includes(
                                                                                    rec.id,
                                                                                )
                                                                                    ? "opacity-100"
                                                                                    : "opacity-0",
                                                                            )}
                                                                        />
                                                                        <span className="flex-1 truncate">
                                                                            {
                                                                                rec.name
                                                                            }
                                                                        </span>
                                                                    </CommandItem>
                                                                ),
                                                            )}
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
                                                        style={{
                                                            borderLeftColor:
                                                                getChartColor(
                                                                    selectedCats.length +
                                                                        i,
                                                                ),
                                                            borderLeftWidth: 3,
                                                        }}
                                                    >
                                                        <span className="truncate max-w-[150px]">
                                                            {rec.name}
                                                        </span>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            className="ml-1 h-5 w-5 rounded-chip text-label-secondary hover:text-foreground [&_svg]:size-3"
                                                            aria-label={t(
                                                                "customChart.removeSeries",
                                                                {
                                                                    name: rec.name,
                                                                },
                                                            )}
                                                            onClick={() =>
                                                                toggleRecipient(
                                                                    rec.id,
                                                                )
                                                            }
                                                        >
                                                            <X />
                                                        </Button>
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
                                    <span className="type-body font-medium text-label-primary">
                                        {t("customChart.tagsLabel")}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <Switch
                                            id="all-tags"
                                            checked={state.allTags}
                                            onCheckedChange={(v) =>
                                                update("allTags", v)
                                            }
                                        />
                                        <Label
                                            htmlFor="all-tags"
                                            className="type-footnote font-normal text-label-secondary"
                                        >
                                            {t("customChart.allTags")}
                                        </Label>
                                    </div>
                                </div>
                                {state.allTags ? (
                                    <p className="type-footnote text-label-secondary">
                                        {t("customChart.allHint")}
                                    </p>
                                ) : (
                                    <>
                                        <Popover
                                            open={tagOpen}
                                            onOpenChange={setTagOpen}
                                        >
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    role="combobox"
                                                    aria-label={t(
                                                        "customChart.addTag",
                                                    )}
                                                    aria-expanded={tagOpen}
                                                    className="w-full justify-between font-normal"
                                                >
                                                    <span className="inline-flex items-center gap-1 text-label-secondary">
                                                        <Plus className="h-4 w-4" />
                                                        {t(
                                                            "customChart.addTag",
                                                        )}
                                                    </span>
                                                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent
                                                className="w-[300px] p-0"
                                                align="start"
                                            >
                                                <Command>
                                                    <CommandInput
                                                        placeholder={t(
                                                            "customChart.searchTags",
                                                        )}
                                                    />
                                                    <CommandList>
                                                        <CommandEmpty>
                                                            {t(
                                                                "customChart.noTagsFound",
                                                            )}
                                                        </CommandEmpty>
                                                        <CommandGroup>
                                                            {allTags.map(
                                                                (tag) => (
                                                                    <CommandItem
                                                                        key={
                                                                            tag.id
                                                                        }
                                                                        value={
                                                                            tag.slug
                                                                        }
                                                                        onSelect={() =>
                                                                            toggleTag(
                                                                                tag.id,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Check
                                                                            className={cn(
                                                                                "mr-2 h-4 w-4",
                                                                                state.tagIds.includes(
                                                                                    tag.id,
                                                                                )
                                                                                    ? "opacity-100"
                                                                                    : "opacity-0",
                                                                            )}
                                                                        />
                                                                        <span className="flex-1 truncate">
                                                                            #
                                                                            {
                                                                                tag.slug
                                                                            }
                                                                        </span>
                                                                    </CommandItem>
                                                                ),
                                                            )}
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
                                                        style={{
                                                            borderLeftColor:
                                                                getChartColor(
                                                                    selectedCats.length +
                                                                        selectedRecs.length +
                                                                        i,
                                                                ),
                                                            borderLeftWidth: 3,
                                                        }}
                                                    >
                                                        <span className="truncate max-w-[150px]">
                                                            #{tag.slug}
                                                        </span>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            className="ml-1 h-5 w-5 rounded-chip text-label-secondary hover:text-foreground [&_svg]:size-3"
                                                            aria-label={t(
                                                                "customChart.removeSeries",
                                                                {
                                                                    name: tag.slug,
                                                                },
                                                            )}
                                                            onClick={() =>
                                                                toggleTag(
                                                                    tag.id,
                                                                )
                                                            }
                                                        >
                                                            <X />
                                                        </Button>
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
                            <p className="mb-2 type-headline text-foreground">
                                {t("customChart.builder.preview")}
                            </p>
                            <CustomChart
                                savedChart={previewChart}
                                data={data}
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                !canSave ||
                                createChart.isPending ||
                                updateChart.isPending
                            }
                        >
                            {createChart.isPending || updateChart.isPending
                                ? t("customChart.saving")
                                : t("customChart.builder.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
