/**
 * Canonical account picker for transaction and planned-payment writes.
 * The label is display state only; every selection emits an existing account id.
 */
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
import { useAccounts } from "@/hooks/useAccounts";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { FieldErrorAria } from "@/hooks/useFieldErrors";

interface AccountComboboxProps extends FieldErrorAria {
    id?: string;
    /** Display label of the selected account. */
    value: string;
    onChange: (name: string) => void;
    /** Canonical identity of the selected existing account. */
    onAccountIdChange: (id: number) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    portalContainer?: HTMLElement | null;
}

const normalize = (s: string) => s.trim().toLowerCase();

export function AccountCombobox({
    id,
    value,
    onChange,
    onAccountIdChange,
    placeholder,
    disabled,
    className,
    portalContainer,
    "aria-invalid": ariaInvalid,
    "aria-describedby": ariaDescribedBy,
}: AccountComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const { data } = useAccounts({ active: "true" });
    const accounts = useMemo(() => data?.items ?? [], [data?.items]);

    const selected = accounts.find(
        (a) => normalize(a.name) === normalize(value),
    );
    const displayLabel = selected
        ? selected.display_name || selected.name
        : value || placeholder || t("combobox.account.placeholder");

    const pick = (name: string, accountId: number) => {
        onChange(name);
        onAccountIdChange(accountId);
        setSearch("");
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    id={id}
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    aria-invalid={ariaInvalid}
                    aria-describedby={ariaDescribedBy}
                    disabled={disabled}
                    className={cn(
                        "w-full justify-between font-normal",
                        !value && "text-muted-foreground",
                        className,
                    )}
                >
                    <span className="truncate">{displayLabel}</span>
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                container={portalContainer}
                className="w-[--radix-popover-trigger-width] min-w-[240px] p-0 z-[200]"
                align="start"
            >
                <Command>
                    <CommandInput
                        placeholder={t("combobox.account.search")}
                        value={search}
                        onValueChange={setSearch}
                    />
                    <CommandList>
                        <CommandEmpty>
                            {t("combobox.account.empty")}
                        </CommandEmpty>
                        <CommandGroup>
                            {accounts.map((account) => (
                                <CommandItem
                                    key={account.id}
                                    value={`${account.display_name || ""} ${account.name} ${account.id}`}
                                    onSelect={() =>
                                        pick(account.name, account.id)
                                    }
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            normalize(value) ===
                                                normalize(account.name)
                                                ? "opacity-100"
                                                : "opacity-0",
                                        )}
                                    />
                                    <span className="truncate">
                                        {account.display_name || account.name}
                                    </span>
                                    {account.display_name &&
                                        account.display_name !==
                                            account.name && (
                                            <span className="ml-1.5 truncate text-xs text-muted-foreground">
                                                {account.name}
                                            </span>
                                        )}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
