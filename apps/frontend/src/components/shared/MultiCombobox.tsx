import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface MultiComboboxProps<T, V extends string | number> {
    value: V[];
    onChange: (values: V[]) => void;
    items: T[];
    /** Stable identity of an item; also used as the React key. */
    getValue: (item: T) => V;
    /** Text the Command palette filters on. Defaults to `String(getValue(item))`. */
    getSearchValue?: (item: T) => string;
    renderItem: (item: T) => ReactNode;
    /** Already-translated trigger label ("All" / "N selected"). */
    displayLabel: string;
    searchPlaceholder: string;
    emptyText: string;
    /** Width class for the popover panel. */
    popoverClassName?: string;
    disabled?: boolean;
    className?: string;
}

export function MultiCombobox<T, V extends string | number>({
    value,
    onChange,
    items,
    getValue,
    getSearchValue,
    renderItem,
    displayLabel,
    searchPlaceholder,
    emptyText,
    popoverClassName = "w-[280px]",
    disabled,
    className,
}: MultiComboboxProps<T, V>) {
    const [open, setOpen] = useState(false);
    const selectedSet = useMemo(() => new Set(value), [value]);

    function toggle(v: V) {
        if (selectedSet.has(v)) {
            onChange(value.filter((x) => x !== v));
        } else {
            onChange([...value, v]);
        }
    }

    const sorted = useMemo(() => [
        ...items.filter((item) => selectedSet.has(getValue(item))),
        ...items.filter((item) => !selectedSet.has(getValue(item))),
    ], [items, selectedSet, getValue]);

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
            <PopoverContent className={cn(popoverClassName, "p-0 z-50")} align="start">
                <Command>
                    <CommandInput placeholder={searchPlaceholder} />
                    <CommandList>
                        <CommandEmpty>{emptyText}</CommandEmpty>
                        <CommandGroup>
                            {sorted.map((item) => {
                                const v = getValue(item);
                                const selected = selectedSet.has(v);
                                return (
                                    <CommandItem
                                        key={v}
                                        value={getSearchValue ? getSearchValue(item) : String(v)}
                                        onSelect={() => toggle(v)}
                                    >
                                        <Check className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
                                        {renderItem(item)}
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
