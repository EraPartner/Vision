import {
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SymbolSearchListContext } from "@/components/shared/symbolSearchContext";

interface SymbolSearchBoxProps {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** Whether the results dropdown should be shown. */
    open: boolean;
    /** Closes the caller-controlled result popup without selecting an option. */
    onDismiss: () => void;
    /** Result rows plus any empty / unavailable / no-results states. */
    children: ReactNode;
    autoFocus?: boolean;
    /** Shows a spinner on the trailing edge of the input while fetching. */
    loading?: boolean;
    /** Defaults to `placeholder` when omitted. */
    ariaLabel?: string;
    /** Layout/width class for the outer wrapper (e.g. `max-w-2xl`). */
    className?: string;
}

/**
 * Canonical ticker/company search box, shared across every symbol picker
 * (Research home, Market Lookup, Compare, Chart Builder) so they stay visually
 * consistent: a tall glass input with a leading search icon and a glass-elevated
 * results dropdown. Pages supply their own results/states as `children` and own
 * the query logic; this component only owns the chrome. Rows inside should use
 * {@link SymbolSearchResultItem}.
 */
export function SymbolSearchBox({
    value,
    onChange,
    placeholder,
    open,
    onDismiss,
    children,
    autoFocus,
    loading,
    ariaLabel,
    className,
}: SymbolSearchBoxProps) {
    const listboxId = `symbol-search-listbox-${useId()}`;
    const listboxRef = useRef<HTMLDivElement>(null);
    const [activeOptionId, setActiveOptionId] = useState<string>();

    useEffect(() => {
        if (!open) setActiveOptionId(undefined);
    }, [open]);

    const options = () =>
        Array.from(
            listboxRef.current?.querySelectorAll<HTMLElement>(
                '[role="option"]',
            ) ?? [],
        );

    const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape" && open) {
            event.preventDefault();
            setActiveOptionId(undefined);
            onDismiss();
            return;
        }

        const resultOptions = options();
        if (!open || resultOptions.length === 0) return;

        const currentIndex = resultOptions.findIndex(
            (option) => option.id === activeOptionId,
        );
        let nextIndex: number | undefined;

        if (event.key === "ArrowDown") {
            nextIndex =
                currentIndex < resultOptions.length - 1 ? currentIndex + 1 : 0;
        } else if (event.key === "ArrowUp") {
            nextIndex =
                currentIndex > 0 ? currentIndex - 1 : resultOptions.length - 1;
        } else if (event.key === "Enter" && currentIndex >= 0) {
            event.preventDefault();
            resultOptions[currentIndex].click();
            return;
        } else {
            return;
        }

        event.preventDefault();
        const nextOption = resultOptions[nextIndex];
        setActiveOptionId(nextOption.id);
        nextOption.scrollIntoView?.({ block: "nearest" });
    };

    return (
        <div className={cn("relative", className)}>
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
                autoFocus={autoFocus}
                placeholder={placeholder}
                value={value}
                onChange={(e) => {
                    setActiveOptionId(undefined);
                    onChange(e.target.value);
                }}
                onKeyDown={onInputKeyDown}
                className="h-14 pl-12 text-base glass-regular"
                aria-label={ariaLabel ?? placeholder}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={open ? activeOptionId : undefined}
            />
            {loading ? (
                <div className="absolute right-4 top-1/2 -translate-y-1/2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
            ) : null}
            {open ? (
                <Card className="absolute z-50 top-full mt-2 w-full glass-thick">
                    <CardContent
                        ref={listboxRef}
                        id={listboxId}
                        role="listbox"
                        className="p-1"
                    >
                        <SymbolSearchListContext.Provider
                            value={{ activeOptionId, setActiveOptionId }}
                        >
                            {children}
                        </SymbolSearchListContext.Provider>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
}
