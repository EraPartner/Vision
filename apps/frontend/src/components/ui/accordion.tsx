import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import {ChevronDown} from "lucide-react";

import {cn} from "@/lib/utils";
import {composeRefs} from "@/lib/composeRefs";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({className, ...props}, ref) => (
    <AccordionPrimitive.Item ref={ref} className={cn("border-b border-border/50", className)} {...props} />
));
AccordionItem.displayName = "AccordionItem";

const triggerBase =
    "group flex flex-1 items-center justify-between gap-4 py-4 text-left text-sm font-medium tracking-tight text-foreground/90 outline-none transition-colors duration-[var(--duration-fast)] hover:text-foreground focus-visible:text-foreground data-[state=open]:text-foreground";

const chevronBase =
    "h-4 w-4 shrink-0 text-muted-foreground/80 transition-transform duration-[var(--duration-normal)] ease-[var(--ease-glide)]";

interface AccordionTriggerProps
    extends React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> {
    /**
     * Interactive content that belongs on the header row but must NOT live
     * inside the trigger — a <button> (or any focusable control) nested in the
     * trigger button is invalid HTML, and assistive tech cannot reach it.
     *
     * When set, the header itself becomes the flex row: the trigger shrinks to
     * the label, `trailing` is its sibling, and the chevron moves out of the
     * button so it still paints last. Row padding therefore belongs on
     * `headerClassName` (the header owns the row box) rather than `className`.
     */
    trailing?: React.ReactNode;
    /** Classes for the header row — only meaningful together with `trailing`. */
    headerClassName?: string;
}

const AccordionTrigger = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Trigger>,
    AccordionTriggerProps
>(({className, children, trailing, headerClassName, ...props}, ref) => {
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    if (trailing !== undefined) {
        return (
            // group/accordion-row so the chevron — now outside the button — keeps
            // rotating on open and lighting up on row hover exactly as it did
            // when it was the trigger's own child (Radix puts data-state on the
            // header too).
            <AccordionPrimitive.Header
                // tracking-tight is lifted off the trigger onto the row so
                // `trailing` inherits exactly what it inherited while it was
                // still a child of the trigger.
                className={cn("group/accordion-row flex items-center gap-4 tracking-tight", headerClassName)}
            >
                <AccordionPrimitive.Trigger
                    ref={composeRefs(ref, triggerRef)}
                    className={cn(triggerBase, "min-w-0 group-hover/accordion-row:text-foreground", className)}
                    {...props}
                >
                    {children}
                </AccordionPrimitive.Trigger>
                {trailing}
                {/* Decorative, but the chevron was clickable while it lived
                    inside the trigger — forward clicks so that affordance
                    survives the move out of the button. */}
                <ChevronDown
                    aria-hidden="true"
                    onClick={() => triggerRef.current?.click()}
                    className={cn(
                        chevronBase,
                        "cursor-pointer group-hover/accordion-row:text-foreground group-data-[state=open]/accordion-row:rotate-180",
                    )}
                />
            </AccordionPrimitive.Header>
        );
    }

    return (
        <AccordionPrimitive.Header className="flex">
            <AccordionPrimitive.Trigger
                ref={ref}
                className={cn(triggerBase, "[&[data-state=open]>svg]:rotate-180", className)}
                {...props}
            >
                {children}
                <ChevronDown className={cn(chevronBase, "group-hover:text-foreground")}/>
            </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
    );
});
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({className, children, ...props}, ref) => (
    <AccordionPrimitive.Content
        ref={ref}
        className="overflow-hidden text-sm leading-relaxed text-muted-foreground data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
        {...props}
    >
        <div className={cn("pb-4 pt-0", className)}>{children}</div>
    </AccordionPrimitive.Content>
));

AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export {Accordion, AccordionItem, AccordionTrigger, AccordionContent};
