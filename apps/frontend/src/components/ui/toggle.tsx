import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

const toggleVariants = cva(
    "inline-flex items-center justify-center gap-2 rounded-control type-body font-medium transition-[background-color,color,border-color,box-shadow] duration-fast ease-glide hover:bg-foreground/[0.06] hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.3)]",
    {
        variants: {
            variant: {
                default: "bg-transparent",
                outline:
                    "border border-input/70 bg-background/80 shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] hover:border-input hover:bg-foreground/[0.06]",
            },
            size: {
                default: "h-9 px-3",
                sm: "h-8 px-2.5",
                lg: "h-10 px-5",
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
