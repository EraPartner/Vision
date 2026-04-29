import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

const toggleVariants = cva(
    "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium tracking-tight ring-offset-background transition-[background-color,color,border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.3)]",
    {
        variants: {
            variant: {
                default: "bg-transparent",
                outline:
                    "border border-input/70 bg-background/80 shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] hover:border-input hover:bg-foreground/[0.06]",
            },
            size: {
                default: "h-10 px-3",
                sm: "h-9 px-2.5",
                lg: "h-11 px-5",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

const Toggle = React.forwardRef<
    React.ElementRef<typeof TogglePrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({className, variant, size, ...props}, ref) => (
    <TogglePrimitive.Root ref={ref} className={cn(toggleVariants({variant, size, className}))} {...props} />
));

Toggle.displayName = TogglePrimitive.Root.displayName;

// eslint-disable-next-line react-refresh/only-export-components
export {Toggle, toggleVariants};
