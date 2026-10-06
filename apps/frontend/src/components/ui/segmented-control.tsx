import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import { m, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";
import { springs } from "@/lib/motion";

/**
 * macOS-style segmented control (ADR-179): one filled pill marks the chosen
 * segment and glides between segments on the snappy spring. Built on Radix
 * ToggleGroup in single mode, so the group is a radiogroup and each segment
 * a radio for assistive technology. Selection can never be cleared by
 * clicking the chosen segment, which keeps the control a picker, not a toggle.
 *
 * Corners nest concentrically: the track is a 10px control radius with 2px
 * padding, so each segment keeps an 8px radius.
 */
const SegmentedControlValueContext = React.createContext<string | undefined>(
    undefined,
);
const SegmentedControlLayoutIdContext = React.createContext<string>(
    "segmented",
);

const segmentedControlVariants = cva(
    "inline-flex max-w-full items-center rounded-control bg-foreground/[0.06] p-0.5 text-label-secondary",
    {
        variants: {
            size: {
                default: "h-9",
                sm: "h-8",
            },
        },
        defaultVariants: { size: "default" },
    },
);

export interface SegmentedControlProps
    extends
        Omit<
            React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>,
            "type" | "value" | "defaultValue" | "onValueChange"
        >,
        VariantProps<typeof segmentedControlVariants> {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
}

const SegmentedControl = React.forwardRef<
    React.ElementRef<typeof ToggleGroupPrimitive.Root>,
    SegmentedControlProps
>(
    (
        { className, size, value, defaultValue, onValueChange, ...props },
        ref,
    ) => {
        const [active, setActive] = React.useState<string | undefined>(
            value ?? defaultValue,
        );
        const layoutId = React.useId();

        React.useEffect(() => {
            if (value !== undefined) setActive(value);
        }, [value]);

        return (
            <SegmentedControlLayoutIdContext.Provider value={layoutId}>
                <SegmentedControlValueContext.Provider value={active}>
                    <ToggleGroupPrimitive.Root
                        ref={ref}
                        type="single"
                        value={value}
                        defaultValue={defaultValue}
                        onValueChange={(next) => {
                            // Radix reports "" when the pressed item is clicked
                            // again; a segmented control always has a choice.
                            if (!next) return;
                            setActive(next);
                            onValueChange?.(next);
                        }}
                        className={cn(
                            segmentedControlVariants({ size }),
                            className,
                        )}
                        {...props}
                    />
                </SegmentedControlValueContext.Provider>
            </SegmentedControlLayoutIdContext.Provider>
        );
    },
);
SegmentedControl.displayName = "SegmentedControl";

const SegmentedControlItem = React.forwardRef<
    React.ElementRef<typeof ToggleGroupPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, value, children, ...props }, ref) => {
    const active = React.useContext(SegmentedControlValueContext);
    const layoutId = React.useContext(SegmentedControlLayoutIdContext);
    const reducedMotion = useReducedMotion();
    const isActive = active === value;

    return (
        <ToggleGroupPrimitive.Item
            ref={ref}
            value={value}
            className={cn(
                "press-feedback [--press-compose:color_var(--duration-normal)_var(--ease-glide),transform_var(--duration-press)_ease-out] relative inline-flex h-full min-w-0 flex-auto items-center justify-center whitespace-nowrap rounded-[calc(var(--radius-control)-0.125rem)] px-3 type-body font-medium hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:text-foreground",
                className,
            )}
            {...props}
        >
            {isActive && (
                <m.span
                    layoutId={`${layoutId}-pill`}
                    aria-hidden="true"
                    transition={reducedMotion ? { duration: 0 } : springs.snappy}
                    className="absolute inset-0 rounded-[inherit] bg-background shadow-elevation-1 ring-1 ring-foreground/[0.06]"
                />
            )}
            <span className="relative z-10 inline-flex min-w-0 items-center gap-1.5 truncate">
                {children}
            </span>
        </ToggleGroupPrimitive.Item>
    );
});
SegmentedControlItem.displayName = "SegmentedControlItem";

export { SegmentedControl, SegmentedControlItem };
