import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
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
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { useCategories } from "@/hooks/useCategories";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface CategoryComboboxProps {
    /** Put on the trigger, so a <Label htmlFor> can reach it. */
    id?: string;
    /** Accessible name for uses without a visible associated label. */
    "aria-label"?: string;
    value?: number | null;
    onSelect: (categoryId: number | null, categoryName: string | null) => void;
    disabled?: boolean;
    className?: string;
    portalContainer?: HTMLElement | null;
}

export function CategoryCombobox({
    id,
    "aria-label": ariaLabel,
    value,
    onSelect,
    disabled,
    className,
    portalContainer,
}: CategoryComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    // This picker represents the complete category vocabulary. Omitting
    // pagination keeps it searchable beyond an arbitrary first-page cap; the
    // categories route deliberately returns the full active list when no
    // limit/offset is supplied.
    const { data } = useCategories({ active: true });

    const categories = useMemo(() => data?.items ?? [], [data?.items]);
    const selected = useMemo(
        () => categories.find((c) => c.id === value),
        [categories, value],
    );
    const displayLabel = selected
        ? `${selected.general}: ${selected.detail}`
        : t("combobox.category.placeholder");

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    id={id}
                    aria-label={ariaLabel}
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    disabled={disabled}
                    className={cn(
                        "justify-between font-normal h-8 text-sm",
                        className,
                    )}
                >
                    <span className="truncate">{displayLabel}</span>
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                container={portalContainer}
                className="w-[280px] p-0 z-50"
                align="start"
            >
                <Command>
                    <CommandInput placeholder={t("combobox.category.search")} />
                    <CommandList>
                        <CommandEmpty>
                            {t("combobox.category.empty")}
                        </CommandEmpty>
                        <CommandGroup>
                            <CommandItem
                                value="__none__"
                                onSelect={() => {
                                    onSelect(null, null);
                                    setOpen(false);
                                }}
                            >
                                <Check
                                    className={cn(
                                        "mr-2 h-4 w-4",
                                        !value ? "opacity-100" : "opacity-0",
                                    )}
                                />
                                <span className="text-muted-foreground italic">
                                    {t("combobox.category.none")}
                                </span>
                            </CommandItem>
                            {categories.map((cat) => {
                                const label = `${cat.general}: ${cat.detail}`;
                                return (
                                    <CommandItem
                                        key={cat.id}
                                        value={label}
                                        onSelect={() => {
                                            onSelect(cat.id, label);
                                            setOpen(false);
                                        }}
                                    >
                                        <Check
                                            className={cn(
                                                "mr-2 h-4 w-4",
                                                value === cat.id
                                                    ? "opacity-100"
                                                    : "opacity-0",
                                            )}
                                        />
                                        {label}
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
