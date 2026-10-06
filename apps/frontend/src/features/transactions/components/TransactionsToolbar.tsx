import { useMemo, useState } from "react";
import { Check, ChevronDown, SlidersHorizontal, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCategoryTree } from "@/hooks/useCategories";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { AccountFilterCombobox } from "./AccountFilterCombobox";
import type { DatePreset } from "../transactionColumns";

/** Chip-shaped toolbar button; `active` marks a filter that narrows the list. */
export function FilterChip({
    active = false,
    className,
    children,
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
                "h-8 gap-1.5 rounded-chip px-3 type-callout font-medium",
                active &&
                    "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                className,
            )}
            {...props}
        >
            {children}
        </Button>
    );
}

interface CategoryFilterChipProps {
    value?: number;
    onChange: (selection: { id: number; label: string } | null) => void;
}

function CategoryFilterChip({ value, onChange }: CategoryFilterChipProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const { data } = useCategoryTree();
    const categories = useMemo(() => data?.items ?? [], [data?.items]);
    const selected = categories.find((c) => c.id === value);
    const label = selected
        ? selected.path.join(" / ")
        : t("txPage.filter.allCategories");
    const pick = (selection: { id: number; label: string } | null) => {
        onChange(selection);
        setOpen(false);
    };
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <FilterChip
                    role="combobox"
                    aria-expanded={open}
                    aria-label={t("txPage.filter.categoryAria")}
                    active={!!selected}
                >
                    <Tag className="h-4 w-4" aria-hidden="true" />
                    <span className="max-w-[10rem] truncate">{label}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
                </FilterChip>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="start">
                <Command>
                    <CommandInput placeholder={t("combobox.category.search")} />
                    <CommandList>
                        <CommandEmpty>{t("combobox.category.empty")}</CommandEmpty>
                        <CommandGroup>
                            <CommandItem value="__all__" onSelect={() => pick(null)}>
                                <Check
                                    className={cn(
                                        "mr-2 h-4 w-4",
                                        value == null ? "opacity-100" : "opacity-0",
                                    )}
                                />
                                {t("txPage.filter.allCategories")}
                            </CommandItem>
                            {categories
                                .filter((c) => c.is_active)
                                .map((cat) => {
                                    const path = cat.path.join(" / ");
                                    return (
                                        <CommandItem
                                            key={cat.id}
                                            value={`${path} ${cat.id}`}
                                            onSelect={() =>
                                                pick({ id: cat.id, label: path })
                                            }
                                        >
                                            <Check
                                                className={cn(
                                                    "mr-2 h-4 w-4",
                                                    value === cat.id
                                                        ? "opacity-100"
                                                        : "opacity-0",
                                                )}
                                            />
                                            <span className="truncate">{path}</span>
                                        </CommandItem>
                                    );
                                })}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

export interface TransactionsToolbarProps {
    accountIdFilter?: number;
    onAccountChange: (selection: { id: number; label: string } | null) => void;
    categoryIdFilter?: number;
    onCategoryChange: (selection: { id: number; label: string } | null) => void;
    /** undefined = a custom start/end range not matching a preset. */
    datePreset: DatePreset | undefined;
    customDateLabel?: string;
    onDatePresetChange: (preset: DatePreset) => void;
    transactionTypeFilter?: "income" | "expense";
    onTypeChange: (type: "income" | "expense" | undefined) => void;
    needsCategory: boolean;
    needsCategoryCount?: number;
    onNeedsCategoryChange: (on: boolean) => void;
    showAll: boolean;
    onShowAllChange: (showAll: boolean) => void;
    columns: WidgetDefinition[];
    isColumnVisible: (id: string) => boolean;
    setColumnVisible: (id: string, visible: boolean) => void;
    onResetColumns: () => void;
}

/**
 * Filter chips above the Transactions list (ADR-181). Every chip writes the
 * same URL params the deep links and the search suggestions use, so the
 * FilterBanner and the export buttons keep describing the active set.
 */
export function TransactionsToolbar({
    accountIdFilter,
    onAccountChange,
    categoryIdFilter,
    onCategoryChange,
    datePreset,
    customDateLabel,
    onDatePresetChange,
    transactionTypeFilter,
    onTypeChange,
    needsCategory,
    needsCategoryCount,
    onNeedsCategoryChange,
    showAll,
    onShowAllChange,
    columns,
    isColumnVisible,
    setColumnVisible,
    onResetColumns,
}: TransactionsToolbarProps) {
    const { t } = useLanguage();
    const dateLabel =
        datePreset === undefined
            ? (customDateLabel ?? t("txPage.filter.date.custom"))
            : t(`txPage.filter.date.${datePreset}`);
    const typeLabel = transactionTypeFilter
        ? t(`txPage.filter.type.${transactionTypeFilter}`)
        : t("txPage.filter.type.all");

    return (
        <div
            role="toolbar"
            aria-label={t("txPage.filter.toolbar")}
            className="flex flex-wrap items-center gap-2"
        >
            <AccountFilterCombobox value={accountIdFilter} onChange={onAccountChange} chip />
            <CategoryFilterChip value={categoryIdFilter} onChange={onCategoryChange} />

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <FilterChip
                        active={datePreset !== "any"}
                        aria-label={t("txPage.filter.dateAria")}
                    >
                        <span className="max-w-[12rem] truncate">{dateLabel}</span>
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
                    </FilterChip>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                    <DropdownMenuRadioGroup
                        value={datePreset ?? "custom"}
                        onValueChange={(value) => {
                            if (value !== "custom")
                                onDatePresetChange(value as DatePreset);
                        }}
                    >
                        {(["any", "thisMonth", "lastMonth", "thisYear"] as const).map(
                            (preset) => (
                                <DropdownMenuRadioItem key={preset} value={preset}>
                                    {t(`txPage.filter.date.${preset}`)}
                                </DropdownMenuRadioItem>
                            ),
                        )}
                        {datePreset === undefined && (
                            <DropdownMenuRadioItem value="custom">
                                {t("txPage.filter.date.custom")}
                            </DropdownMenuRadioItem>
                        )}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <FilterChip
                        active={!!transactionTypeFilter}
                        aria-label={t("txPage.filter.typeAria")}
                    >
                        {typeLabel}
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
                    </FilterChip>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                    <DropdownMenuRadioGroup
                        value={transactionTypeFilter ?? "all"}
                        onValueChange={(value) =>
                            onTypeChange(
                                value === "income" || value === "expense"
                                    ? value
                                    : undefined,
                            )
                        }
                    >
                        {(["all", "income", "expense"] as const).map((type) => (
                            <DropdownMenuRadioItem key={type} value={type}>
                                {t(`txPage.filter.type.${type}`)}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>

            <FilterChip
                active={needsCategory}
                aria-pressed={needsCategory}
                onClick={() => onNeedsCategoryChange(!needsCategory)}
            >
                {t("txPage.filter.needsCategory")}
                {needsCategoryCount != null && needsCategoryCount > 0 && (
                    <span
                        className={cn(
                            "rounded-chip px-1.5 py-px type-caption tabular-nums",
                            needsCategory
                                ? "bg-primary/15 text-primary"
                                : "bg-foreground/[0.06] text-label-secondary",
                        )}
                    >
                        {needsCategoryCount}
                    </span>
                )}
            </FilterChip>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <FilterChip
                        className="ml-auto"
                        aria-label={t("txPage.view.menu")}
                        active={showAll}
                    >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                        {t("txPage.view.menu")}
                    </FilterChip>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuCheckboxItem
                        checked={showAll}
                        onCheckedChange={(checked) => onShowAllChange(checked === true)}
                    >
                        {t("common.includeInactive")}
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{t("txPage.view.columns")}</DropdownMenuLabel>
                    {columns.map((column) => (
                        <DropdownMenuCheckboxItem
                            key={column.id}
                            checked={isColumnVisible(column.id)}
                            onCheckedChange={(checked) =>
                                setColumnVisible(column.id, checked === true)
                            }
                        >
                            {column.labelKey ? t(column.labelKey) : column.label}
                        </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onResetColumns}>
                        {t("txPage.view.resetColumns")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
