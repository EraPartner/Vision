import type { ReactNode } from "react";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface TouchDisclosureProps {
    label: string;
    content: ReactNode;
    children: ReactNode;
    className?: string;
}

/**
 * Tap-, click-, and keyboard-accessible replacement for information that would
 * otherwise exist only in a hover tooltip or native title attribute.
 */
export function TouchDisclosure({
    label,
    content,
    children,
    className,
}: TouchDisclosureProps) {
    const triggerClassName = cn(
        "inline-flex cursor-help items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:justify-center",
        className,
    );

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={label}
                    className={triggerClassName}
                >
                    {children}
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="center"
                className="w-auto max-w-xs px-3 py-2 text-sm tabular-nums"
            >
                {content}
            </PopoverContent>
        </Popover>
    );
}

interface CompactValueDisclosureProps {
    display: ReactNode;
    fullValue?: string;
    className?: string;
}

export function CompactValueDisclosure({
    display,
    fullValue,
    className,
}: CompactValueDisclosureProps) {
    if (!fullValue) {
        return <span className={className}>{display}</span>;
    }

    return (
        <TouchDisclosure
            label={fullValue}
            content={fullValue}
            className={cn(
                "decoration-dotted underline decoration-muted-foreground/60 underline-offset-4",
                className,
            )}
        >
            {display}
        </TouchDisclosure>
    );
}
