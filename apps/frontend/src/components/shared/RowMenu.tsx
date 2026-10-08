import {
    forwardRef,
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode,
} from "react";
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
    /** `ghost` for rows and cards; `outline` for the page-header ••• menu. */
    variant?: "ghost" | "outline";
    className?: string;
    contentClassName?: string;
    /** Disables the trigger, for example while a row action is in flight. */
    disabled?: boolean;
    children: ReactNode;
}

const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();

/**
 * The row ••• menu convention (ADR-181, ADR-187): a ghost icon trigger with an
 * accessible name, a right-aligned menu, and events that never activate the
 * row it sits in. Items go in as children; destructive ones last, after a
 * separator, with `variant="destructive"`.
 */
export const RowMenu = forwardRef<HTMLButtonElement, RowMenuProps>(
    function RowMenu(
        {
            label,
            align = "end",
            size = "icon-sm",
            variant = "ghost",
            className,
            contentClassName,
            disabled,
            children,
        },
        ref,
    ) {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        ref={ref}
                        type="button"
                        variant={variant}
                        size={size}
                        aria-label={label}
                        disabled={disabled}
                        className={cn(
                            variant === "ghost" && "text-label-secondary",
                            className,
                        )}
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
    },
);
