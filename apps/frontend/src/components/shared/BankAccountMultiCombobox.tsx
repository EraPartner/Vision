import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useLanguage } from "@/contexts/LanguageContext";

interface BankAccountMultiComboboxProps {
    value: string[];
    onChange: (ibans: string[]) => void;
    disabled?: boolean;
    className?: string;
}

export function BankAccountMultiCombobox({ value, onChange, disabled, className }: BankAccountMultiComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const { data } = useBankAccounts();

    const accounts = data?.banks ?? [];
    const selectedSet = new Set(value);

    const displayLabel = value.length === 0
        ? t('combobox.bankAccount.allSelected')
        : t('combobox.bankAccount.nSelected').replace('{n}', String(value.length));

    function toggle(iban: string) {
        if (selectedSet.has(iban)) {
            onChange(value.filter((v) => v !== iban));
        } else {
            onChange([...value, iban]);
        }
    }

    const sorted = [
        ...accounts.filter((a) => selectedSet.has(a)),
        ...accounts.filter((a) => !selectedSet.has(a)),
    ];

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
            <PopoverContent className="w-[280px] p-0 z-50" align="start">
                <Command>
                    <CommandInput placeholder={t('combobox.bankAccount.search')} />
                    <CommandList>
                        <CommandEmpty>{t('combobox.bankAccount.empty')}</CommandEmpty>
                        <CommandGroup>
                            {sorted.map((iban) => {
                                const selected = selectedSet.has(iban);
                                return (
                                    <CommandItem
                                        key={iban}
                                        value={iban}
                                        onSelect={() => toggle(iban)}
                                    >
                                        <Check className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
                                        {iban}
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
