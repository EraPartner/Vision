import { forwardRef, useCallback, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRecipients } from "@/hooks/useRecipients";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDebounce, SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import type { Recipient } from "@/types/api";

/**
 * The unsearched page a closed combobox resolves its label against. Kept as one
 * frozen object so `useRecipientComboboxLabel` subscribes to *exactly* the
 * query the live control uses — same key, same cache entry, same page — and a
 * deferred combobox therefore paints the exact same string the live one would,
 * down to falling back to the placeholder when the selected recipient sits
 * past this page.
 */
const BASE_PAGE = { limit: 100, active: false, search: undefined } as const;

interface RecipientComboboxProps {
    /** Put on the trigger, so a <Label htmlFor> can reach it. */
    id?: string;
    value?: number | null;
    onSelect: (recipientId: number | null, recipientName: string | null) => void;
    disabled?: boolean;
    className?: string;
    portalContainer?: HTMLElement | null;
}

interface RecipientComboboxTriggerProps extends ComponentPropsWithoutRef<"button"> {
    /** Text painted in the closed control: selected recipient, else placeholder. */
    label: string;
}

/**
 * The combobox's closed face. Shared by every variant below so the rendered
 * button — classes, children, chevron — can never drift between them.
 */
const RecipientComboboxTrigger = forwardRef<HTMLButtonElement, RecipientComboboxTriggerProps>(
    ({ label, className, ...props }, ref) => (
        <Button
            ref={ref}
            variant="outline"
            role="combobox"
            className={cn("justify-between font-normal h-8 text-sm", className)}
            {...props}
        >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
    ),
);
RecipientComboboxTrigger.displayName = "RecipientComboboxTrigger";

interface RecipientComboboxItemsProps {
    value?: number | null;
    recipients: Recipient[];
    search: string;
    onSearchChange: (next: string) => void;
    /** Fires for both a recipient row and the "no recipient" row (null, null). */
    onPick: (recipientId: number | null, recipientName: string | null) => void;
}

/**
 * The popover body. Purely presentational — it never fetches, so it can be
 * mounted by a control that owns its query up front (`RecipientCombobox`) or by
 * one that only fetches while open (`DeferredRecipientCombobox`).
 */
function RecipientComboboxItems({ value, recipients, search, onSearchChange, onPick }: RecipientComboboxItemsProps) {
    const { t } = useLanguage();

    return (
        <Command shouldFilter={false}>
            <CommandInput
                placeholder={t('combobox.recipient.search')}
                value={search}
                onValueChange={onSearchChange}
            />
            <CommandList>
                <CommandEmpty>{t('combobox.recipient.empty')}</CommandEmpty>
                <CommandGroup>
                    <CommandItem
                        value="__none__"
                        onSelect={() => onPick(null, null)}
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
                                onSelect={() => onPick(recipient.id, label)}
                            >
                                <Check className={cn("mr-2 h-4 w-4", value === recipient.id ? "opacity-100" : "opacity-0")} />
                                {label}
                            </CommandItem>
                        );
                    })}
                </CommandGroup>
            </CommandList>
        </Command>
    );
}

/** Server-side search page size. Only paid once a search is actually typed. */
const SEARCH_PAGE_LIMIT = 1000;

function useSearchedRecipients(search: string): Recipient[] {
    const debouncedSearch = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);

    const { data } = useRecipients({
        // The server search is the filter; keep the unsearched fetch small so
        // opening the popover doesn't mount ~1000 CommandItems at once.
        limit: debouncedSearch ? SEARCH_PAGE_LIMIT : BASE_PAGE.limit,
        active: BASE_PAGE.active,
        search: debouncedSearch || undefined,
    });

    return useMemo(() => data?.items ?? [], [data?.items]);
}

export function RecipientCombobox({ id, value, onSelect, disabled, className, portalContainer }: RecipientComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const recipients = useSearchedRecipients(search);
    const selected = useMemo(() => recipients.find((r) => r.id === value), [recipients, value]);
    const displayLabel = selected ? selected.name : t('combobox.recipient.placeholder');

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <RecipientComboboxTrigger
                    id={id}
                    aria-expanded={open}
                    disabled={disabled}
                    className={className}
                    label={displayLabel}
                />
            </PopoverTrigger>
            <PopoverContent container={portalContainer} className="w-[280px] p-0 z-[200]" align="start">
                <RecipientComboboxItems
                    value={value}
                    recipients={recipients}
                    search={search}
                    onSearchChange={setSearch}
                    onPick={(recipientId, recipientName) => {
                        onSelect(recipientId, recipientName);
                        setOpen(false);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

/**
 * Resolves a recipient id to the label a closed `RecipientCombobox` paints,
 * from ONE shared `useRecipients` subscription.
 *
 * Call it once per list that renders many `DeferredRecipientCombobox`es and
 * hand the result down: the list then holds a single query observer instead of
 * one per row, and — because it reads the very same cache entry the live
 * control reads (`BASE_PAGE`) — the deferred rows render identically to the
 * live control they stand in for. It doubles as the warm-up fetch, so opening
 * any row's popover shows its recipients from cache with no empty flash.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useRecipientComboboxLabel(): (value?: number | null) => string {
    const { t } = useLanguage();
    const { data } = useRecipients(BASE_PAGE);
    const placeholder = t('combobox.recipient.placeholder');

    const namesById = useMemo(() => {
        const map = new Map<number, string>();
        for (const recipient of data?.items ?? []) map.set(recipient.id, recipient.name);
        return map;
    }, [data?.items]);

    return useCallback(
        (value?: number | null) => (value == null ? undefined : namesById.get(value)) ?? placeholder,
        [namesById, placeholder],
    );
}

interface DeferredRecipientComboboxProps extends RecipientComboboxProps {
    /**
     * Closed-state text, resolved by the caller through
     * `useRecipientComboboxLabel` so the whole list shares one subscription.
     */
    label: string;
}

/** Query owner for the deferred variant — mounted only while the popover is open. */
function DeferredRecipientComboboxItems({
    value,
    search,
    onSearchChange,
    onPick,
}: Omit<RecipientComboboxItemsProps, "recipients">) {
    const recipients = useSearchedRecipients(search);
    return (
        <RecipientComboboxItems
            value={value}
            recipients={recipients}
            search={search}
            onSearchChange={onSearchChange}
            onPick={onPick}
        />
    );
}

/**
 * A `RecipientCombobox` for lists that render one per row.
 *
 * Import review mounts a combobox in every accordion trigger, and a year of
 * bank CSV is easily 100-300 recipient groups. The live control subscribes to
 * `useRecipients`, arms a debounce timer and scans its page on every render
 * just to know what to print while closed — costs paid N times over for rows
 * nobody has touched. Here the trigger is the same element, painted from the
 * caller's single shared subscription, and everything that costs anything (the
 * query, the debounce, the command list) mounts with the popover and unmounts
 * with it. The rendered row is byte-identical to the live control's, and the
 * popover is the real Radix one, so opening/keyboard/selection behave exactly
 * as before.
 *
 * The one deliberate divergence: while a search is filtering the selected
 * recipient out of the fetched page, the live control's trigger falls back to
 * the placeholder mid-search — here the trigger keeps naming the selected
 * recipient, since its label comes from the shared unsearched page.
 */
export function DeferredRecipientCombobox({
    id,
    value,
    onSelect,
    disabled,
    className,
    portalContainer,
    label,
}: DeferredRecipientComboboxProps) {
    const [open, setOpen] = useState(false);
    // Held out here (it costs one useState, no timer and no query) so a
    // reopened popover still shows the search the user last typed, as the live
    // control does.
    const [search, setSearch] = useState("");

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <RecipientComboboxTrigger
                    id={id}
                    aria-expanded={open}
                    disabled={disabled}
                    className={className}
                    label={label}
                />
            </PopoverTrigger>
            <PopoverContent container={portalContainer} className="w-[280px] p-0 z-[200]" align="start">
                <DeferredRecipientComboboxItems
                    value={value}
                    search={search}
                    onSearchChange={setSearch}
                    onPick={(recipientId, recipientName) => {
                        onSelect(recipientId, recipientName);
                        setOpen(false);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}
