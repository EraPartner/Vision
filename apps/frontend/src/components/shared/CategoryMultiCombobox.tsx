import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCategories } from "@/hooks/useCategories";
import { useLanguage } from "@/contexts/LanguageContext";

interface CategoryMultiComboboxProps {
    value: number[];
    onChange: (ids: number[]) => void;
    disabled?: boolean;
    className?: string;
}

export function CategoryMultiCombobox({ value, onChange, disabled, className }: CategoryMultiComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const { data } = useCategories({ limit: 500, active: true });

    const categories = useMemo(() => data?.items ?? [], [data?.items]);
    const selectedSet = useMemo(() => new Set(value), [value]);

    const displayLabel = value.length === 0
        ? t('combobox.categoryMulti.allSelected')
        : t('combobox.categoryMulti.nSelected').replace('{n}', String(value.length));

    function toggle(id: number) {
        if (selectedSet.has(id)) {
            onChange(value.filter((v) => v !== id));
        } else {
            onChange([...value, id]);
        }
    }

    const sorted = useMemo(() => [
        ...categories.filter((c) => selectedSet.has(c.id)),
        ...categories.filter((c) => !selectedSet.has(c.id)),
    ], [categories, selectedSet]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    disabled={disabled}
                    className={cn("justify-between font-normal h-8 text-sm", className)}
                >
                    <span className="truncate">{displayLabel}</span>
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0 bg-popover border border-border shadow-lg z-50" align="start">
                <Command>
                    <CommandInput placeholder={t('combobox.categoryMulti.search')} />
                    <CommandList>
                        <CommandEmpty>{t('combobox.categoryMulti.empty')}</CommandEmpty>
                        <CommandGroup>
                            {sorted.map((cat) => {
                                const label = `${cat.general}: ${cat.detail}`;
                                const selected = selectedSet.has(cat.id);
                                return (
                                    <CommandItem
                                        key={cat.id}
                                        value={label}
                                        onSelect={() => toggle(cat.id)}
                                    >
                                        <Check className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
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
