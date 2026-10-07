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
        "inline-flex cursor-help items-center rounded-chip focus-ring [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:justify-center",
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
                className="w-auto max-w-xs px-3 py-2 type-body tabular-nums"
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
                "underline decoration-label-tertiary decoration-dotted underline-offset-4",
                className,
            )}
        >
            {display}
        </TouchDisclosure>
    );
}
