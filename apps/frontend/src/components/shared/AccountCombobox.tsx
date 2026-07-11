/**
 * Account picker for forms that write `bank_account` (ADR-088 dual-write phase).
 *
 * Value model is the account *name* string — the write-side source of truth:
 * the 0051/0066 sync trigger resolves `account_id` from it on INSERT, so
 * selecting an existing account and free-typing a brand-new label both work.
 * Free text is the explicit-create escape hatch decided in D1 (ADR-088
 * addendum): a label that matches no account (case/whitespace-insensitively)
 * mints one on commit, and a re-cased label resolves to the existing account.
 */
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAccounts } from "@/hooks/useAccounts";
import { useLanguage } from "@/contexts/LanguageContext";

interface AccountComboboxProps {
    id?: string;
    /** The bank_account label (an accounts.name, or free text for a new account). */
    value: string;
    onChange: (name: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    portalContainer?: HTMLElement | null;
}

const normalize = (s: string) => s.trim().toLowerCase();

export function AccountCombobox({ id, value, onChange, placeholder, disabled, className, portalContainer }: AccountComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const { data } = useAccounts({ active: "true" });
    const accounts = useMemo(() => data?.items ?? [], [data?.items]);

    const trimmedSearch = search.trim();
    // Identity is lower(btrim(name)) (D1): only offer "create" when the typed
    // label wouldn't resolve to an existing account anyway.
    const matchesExisting = useMemo(
        () => accounts.some((a) =>
            normalize(a.name) === normalize(trimmedSearch) ||
            normalize(a.display_name || "") === normalize(trimmedSearch)),
        [accounts, trimmedSearch],
    );

    const selected = accounts.find((a) => normalize(a.name) === normalize(value));
    const displayLabel = selected
        ? (selected.display_name || selected.name)
        : (value || placeholder || t('combobox.account.placeholder'));

    const pick = (name: string) => {
        onChange(name);
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
                    disabled={disabled}
                    className={cn("w-full justify-between font-normal", !value && "text-muted-foreground", className)}
                >
                    <span className="truncate">{displayLabel}</span>
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent container={portalContainer} className="w-[--radix-popover-trigger-width] min-w-[240px] p-0 z-[200]" align="start">
                <Command>
                    <CommandInput
                        placeholder={t('combobox.account.search')}
                        value={search}
                        onValueChange={setSearch}
                    />
                    <CommandList>
                        <CommandEmpty>{t('combobox.account.empty')}</CommandEmpty>
                        <CommandGroup>
                            {accounts.map((account) => (
                                <CommandItem
                                    key={account.id}
                                    value={`${account.display_name || ""} ${account.name} ${account.id}`}
                                    onSelect={() => pick(account.name)}
                                >
                                    <Check className={cn(
                                        "mr-2 h-4 w-4",
                                        normalize(value) === normalize(account.name) ? "opacity-100" : "opacity-0",
                                    )} />
                                    <span className="truncate">{account.display_name || account.name}</span>
                                    {account.display_name && account.display_name !== account.name && (
                                        <span className="ml-1.5 truncate text-xs text-muted-foreground">{account.name}</span>
                                    )}
                                </CommandItem>
                            ))}
                            {trimmedSearch && !matchesExisting && (
                                <CommandItem
                                    value={`__create__ ${trimmedSearch}`}
                                    onSelect={() => pick(trimmedSearch)}
                                >
                                    <Plus className="mr-2 h-4 w-4" />
                                    {t('combobox.account.createNew', { name: trimmedSearch })}
                                </CommandItem>
                            )}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
