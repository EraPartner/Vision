import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Inset grouped list (ADR-179): the macOS/iOS settings-style list of rows on
 * one rounded surface, with hairline dividers. Rows carry a leading glyph, a
 * title, an optional subtitle and a trailing value or control; an interactive
 * row renders a button (or the child passed through `asChild`) and shows a
 * chevron when it leads somewhere.
 *
 * Corners nest concentrically: the group uses the card radius; rows are flush
 * and clipped by it, so they need no radius of their own.
 */
const List = React.forwardRef<
    HTMLUListElement,
    React.HTMLAttributes<HTMLUListElement>
>(({ className, ...props }, ref) => (
    <ul
        ref={ref}
        className={cn(
            "m-0 list-none divide-y divide-border/50 overflow-hidden rounded-card corner-continuous border border-border/60 bg-card/70 p-0",
            className,
        )}
        {...props}
    />
));
List.displayName = "List";

export interface ListRowProps extends Omit<
    React.HTMLAttributes<HTMLLIElement>,
    "title"
> {
    /** Glyph or avatar in front of the title. */
    leading?: React.ReactNode;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** Value, badge or control at the trailing edge. */
    trailing?: React.ReactNode;
    /** Shows a disclosure chevron after the trailing slot. */
    chevron?: boolean;
    /** Activates the row; renders the row content as a button. */
    onActivate?: () => void;
    /** Pass a link or custom control as the row's interactive element. */
    asChild?: boolean;
    disabled?: boolean;
    /**
     * Controls rendered beside the row, outside its interactive element, so a
     * row can carry a ••• menu or a switch without nesting buttons.
     */
    actions?: React.ReactNode;
    /** Marks the row as the current selection (tinted, `aria-current`). */
    selected?: boolean;
}

const rowSurfaceClass =
    "flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left type-body text-foreground";
const rowInteractiveClass =
    "cursor-default transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04] active:bg-foreground/[0.07] focus-visible:bg-foreground/[0.04] focus-ring focus-visible:outline-offset-[-3px] disabled:pointer-events-none disabled:opacity-50";

const ListRow = React.forwardRef<HTMLLIElement, ListRowProps>(
    (
        {
            className,
            leading,
            title,
            subtitle,
            trailing,
            chevron = false,
            onActivate,
            asChild = false,
            disabled,
            actions,
            selected = false,
            children,
            ...props
        },
        ref,
    ) => {
        const interactive = asChild || onActivate !== undefined;
        const content = (
            <>
                {leading && (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center text-label-secondary [&>svg]:size-[18px]">
                        {leading}
                    </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn("truncate", selected && "font-medium")}>
                        {title}
                    </span>
                    {subtitle && (
                        <span className="truncate type-footnote text-label-secondary">
                            {subtitle}
                        </span>
                    )}
                </span>
                {trailing && (
                    <span className="flex shrink-0 items-center gap-2 type-body text-label-secondary tabular-nums">
                        {trailing}
                    </span>
                )}
                {chevron && (
                    <ChevronRight
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-label-tertiary"
                    />
                )}
                {/* In asChild mode the child IS the row element, so it must
                    not be rendered a second time inside itself. */}
                {asChild ? null : children}
            </>
        );

        const surface = cn(rowSurfaceClass, actions && "pr-1");

        return (
            <li
                ref={ref}
                className={cn(
                    "min-h-11",
                    actions && "flex items-center",
                    selected && "bg-primary/[0.08]",
                    className,
                )}
                aria-current={selected ? "true" : undefined}
                data-selected={selected ? "" : undefined}
                {...props}
            >
                {interactive ? (
                    asChild ? (
                        <Slot className={cn(surface, rowInteractiveClass)}>
                            {/* the child supplies the element; the row supplies the content */}
                            {React.isValidElement(children)
                                ? React.cloneElement(
                                      children as React.ReactElement<{
                                          children?: React.ReactNode;
                                      }>,
                                      undefined,
                                      content,
                                  )
                                : null}
                        </Slot>
                    ) : (
                        <button
                            type="button"
                            onClick={onActivate}
                            disabled={disabled}
                            className={cn(surface, rowInteractiveClass)}
                        >
                            {content}
                        </button>
                    )
                ) : (
                    <div className={surface}>{content}</div>
                )}
                {actions && (
                    <span className="flex shrink-0 items-center gap-1 pr-2">
                        {actions}
                    </span>
                )}
            </li>
        );
    },
);
ListRow.displayName = "ListRow";

export { List, ListRow };
