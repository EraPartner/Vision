/**
 * "Account" filter for the Transactions page (WP-B4, §3 F6's surviving
 * sub-item): a read-side combobox over the account entities that sets the
 * `account_id` query filter (exact FK match, ADR-088).
 *
 * Unlike the shared AccountCombobox (a WRITE-side picker keyed by the
 * bank_account name string, with a create-new escape hatch), this one keys by
 * account id, offers no free-text creation, and includes archived accounts so
 * their history stays reachable.
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronsUpDown, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAccounts } from "@/hooks/useAccounts";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface AccountFilterComboboxProps {
    /** The active account_id filter, if any. */
    value?: number;
    /** Called with the picked account (id + display label), or null to clear. */
    onChange: (selection: { id: number; label: string } | null) => void;
    /** Toolbar chip styling (ADR-181) instead of the plain outline button. */
    chip?: boolean;
}

export function AccountFilterCombobox({ value, onChange, chip = false }: AccountFilterComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);

    // Full population: an archived account's transactions remain filterable.
    const { data } = useAccounts({ active: "all" });
    const accounts = useMemo(() => data?.items ?? [], [data?.items]);

    const selected = accounts.find((a) => a.id === value);
    const label = selected
        ? (selected.display_name || selected.name)
        : t(chip ? "txPage.filter.allAccounts" : "txPage.filter.account");

    const pick = (selection: { id: number; label: string } | null) => {
        onChange(selection);
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant={selected && !chip ? "secondary" : "outline"}
                    size="sm"
                    role="combobox"
                    aria-expanded={open}
                    aria-label={t("txPage.filter.accountAria")}
                    className={cn(
                        "gap-1.5",
                        chip && "h-8 rounded-chip px-3 type-callout font-medium",
                        chip &&
                            selected &&
                            "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                    )}
                >
                    <Landmark className="h-4 w-4" aria-hidden="true" />
                    <span className="max-w-[10rem] truncate">{label}</span>
                    {chip ? (
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
                    ) : (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[260px] p-0" align={chip ? "start" : "end"}>
                <Command>
                    <CommandInput placeholder={t("combobox.account.search")} />
                    <CommandList>
                        <CommandEmpty>{t("combobox.account.empty")}</CommandEmpty>
                        <CommandGroup>
                            <CommandItem value="__all__" onSelect={() => pick(null)}>
                                <Check className={cn("mr-2 h-4 w-4", value == null ? "opacity-100" : "opacity-0")} />
                                {t("txPage.filter.allAccounts")}
                            </CommandItem>
                            {accounts.map((account) => (
                                <CommandItem
                                    key={account.id}
                                    value={`${account.display_name || ""} ${account.name} ${account.id}`}
                                    onSelect={() =>
                                        pick({ id: account.id, label: account.display_name || account.name })}
                                >
                                    <Check className={cn(
                                        "mr-2 h-4 w-4",
                                        value === account.id ? "opacity-100" : "opacity-0",
                                    )} />
                                    <span className="truncate">{account.display_name || account.name}</span>
                                    {!account.is_active && (
                                        <Badge variant="outline" className="ml-auto text-2xs">
                                            {t("accounts.archived")}
                                        </Badge>
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
