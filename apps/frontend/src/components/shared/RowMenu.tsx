import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface RowMenuProps {
    /** Accessible name of the trigger, for example "Actions for Groceries". */
    label: string;
    align?: "start" | "center" | "end";
    /** Trigger square: 32px by default, 36px for header rows, 28px for dense tables. */
    size?: "icon" | "icon-sm" | "icon-xs";
    className?: string;
    contentClassName?: string;
    children: ReactNode;
}

const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();

/**
 * The row ••• menu convention (ADR-181, ADR-187): a ghost icon trigger with an
 * accessible name, a right-aligned menu, and events that never activate the
 * row it sits in. Items go in as children; destructive ones last, after a
 * separator, with `variant="destructive"`.
 */
export function RowMenu({
    label,
    align = "end",
    size = "icon-sm",
    className,
    contentClassName,
    children,
}: RowMenuProps) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size={size}
                    aria-label={label}
                    className={cn("text-label-secondary", className)}
                    onClick={stop}
                    onKeyDown={stop}
                >
                    <MoreHorizontal aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align={align}
                className={contentClassName}
                onClick={stop}
                onKeyDown={stop}
            >
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
