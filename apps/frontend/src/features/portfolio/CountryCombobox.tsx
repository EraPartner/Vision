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
import { useLanguage } from "@/stores/hydration/LanguageHydration";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const cache = new Map<string, Array<{ code: string; name: string }>>();

/**
 * ISO 3166-1 alpha-2 regions the runtime can name in `locale`, sorted by name.
 * Built from Intl so Vision ships no country table; codes Intl cannot name
 * (unassigned or private-use) are left out.
 */
function countryOptions(locale: string) {
    const cached = cache.get(locale);
    if (cached) return cached;
    const names = new Intl.DisplayNames([locale], {
        type: "region",
        fallback: "none",
    });
    const options: Array<{ code: string; name: string }> = [];
    for (const first of LETTERS)
        for (const second of LETTERS) {
            const code = `${first}${second}`;
            // Private-use and exceptionally reserved codes are not countries.
            if (/^(AA|Q[M-Z]|X[A-Z]|ZZ|EU|EZ|UN)$/.test(code)) continue;
            const name = names.of(code);
            if (name && name !== code) options.push({ code, name });
        }
    options.sort((a, b) => a.name.localeCompare(b.name, locale));
    cache.set(locale, options);
    return options;
}

interface CountryComboboxProps {
    value: string;
    onChange: (code: string) => void;
    id?: string;
    "aria-label"?: string;
    className?: string;
}

/** Searchable issuer-country picker storing the ISO alpha-2 code; empty = none. */
export function CountryCombobox({
    value,
    onChange,
    id,
    "aria-label": ariaLabel,
    className,
}: CountryComboboxProps) {
    const { t, language } = useLanguage();
    const [open, setOpen] = useState(false);
    const options = useMemo(() => countryOptions(language), [language]);
    const selected = options.find((option) => option.code === value);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    id={id}
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    aria-label={ariaLabel}
                    className={cn(
                        "h-9 w-full justify-between font-normal",
                        !selected && "text-label-tertiary",
                        className,
                    )}
                >
                    <span className="truncate">
                        {selected
                            ? selected.name
                            : value ||
                              t("portfolio.classify.countryPlaceholder")}
                    </span>
                    <ChevronsUpDown
                        aria-hidden="true"
                        className="ml-1 h-3 w-3 shrink-0 opacity-50"
                    />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="z-[200] w-[260px] p-0" align="start">
                <Command>
                    <CommandInput
                        placeholder={t("portfolio.classify.countrySearch")}
                    />
                    <CommandList>
                        <CommandEmpty>
                            {t("portfolio.classify.countryEmpty")}
                        </CommandEmpty>
                        <CommandGroup>
                            {value && (
                                <CommandItem
                                    value="__none__"
                                    onSelect={() => {
                                        onChange("");
                                        setOpen(false);
                                    }}
                                >
                                    <span className="ml-6 text-label-secondary">
                                        {t("portfolio.classify.countryNone")}
                                    </span>
                                </CommandItem>
                            )}
                            {options.map((option) => (
                                <CommandItem
                                    key={option.code}
                                    value={`${option.name} ${option.code}`}
                                    onSelect={() => {
                                        onChange(option.code);
                                        setOpen(false);
                                    }}
                                >
                                    <Check
                                        aria-hidden="true"
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            value === option.code
                                                ? "opacity-100"
                                                : "opacity-0",
                                        )}
                                    />
                                    <span className="truncate">
                                        {option.name}
                                    </span>
                                    <span className="ml-auto pl-2 type-caption text-label-tertiary">
                                        {option.code}
                                    </span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
