import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRecipients } from "@/hooks/useRecipients";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDebounce } from "@/hooks/useDebounce";

interface RecipientComboboxProps {
    value?: number | null;
    onSelect: (recipientId: number | null, recipientName: string | null) => void;
    disabled?: boolean;
    className?: string;
    portalContainer?: HTMLElement | null;
}

export function RecipientCombobox({ value, onSelect, disabled, className, portalContainer }: RecipientComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const debouncedSearch = useDebounce(search.trim(), 300);

    const { data } = useRecipients({
        limit: 1000,
        active: false,
        search: debouncedSearch || undefined,
    });

    const recipients = useMemo(() => data?.items ?? [], [data?.items]);
    const selected = recipients.find((r) => r.id === value);
    const displayLabel = selected ? selected.name : t('combobox.recipient.placeholder');

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
            <PopoverContent container={portalContainer} className="w-[280px] p-0 bg-popover border border-border shadow-lg z-[200]" align="start">
                <Command>
                    <CommandInput
                        placeholder={t('combobox.recipient.search')}
                        value={search}
                        onValueChange={setSearch}
                    />
                    <CommandList>
                        <CommandEmpty>{t('combobox.recipient.empty')}</CommandEmpty>
                        <CommandGroup>
                            <CommandItem
                                value="__none__"
                                onSelect={() => {
                                    onSelect(null, null);
                                    setOpen(false);
                                }}
                            >
                                <Check className={cn("mr-2 h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
                                <span className="text-muted-foreground italic">{t('combobox.recipient.none')}</span>
                            </CommandItem>
                            {recipients.map((recipient) => {
                                const label = recipient.name;
                                return (
                                    <CommandItem
                                        key={recipient.id}
                                        value={`${label} ${recipient.id}`}
                                        onSelect={() => {
                                            onSelect(recipient.id, label);
                                            setOpen(false);
                                        }}
                                    >
                                        <Check className={cn("mr-2 h-4 w-4", value === recipient.id ? "opacity-100" : "opacity-0")} />
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