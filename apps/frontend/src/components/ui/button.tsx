import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/* Press feedback composes its transition through --press-compose. Keep the
   transform entry so active feedback and reduced-motion handling stay shared. */
const buttonVariants = cva(
    "press-feedback [--press-compose:background-color_var(--duration-fast)_var(--ease-glide),box-shadow_var(--duration-fast)_var(--ease-glide),color_var(--duration-fast)_var(--ease-glide),transform_var(--duration-press)_ease-out] inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control type-body font-medium focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default:
                    "bg-primary text-primary-foreground shadow-sm hover:bg-primary/92",
                destructive:
                    "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/92",
                outline:
                    "border border-input/70 bg-background/80 text-foreground hover:bg-background hover:text-foreground",
                secondary:
                    "border border-border/50 bg-secondary text-secondary-foreground hover:bg-secondary/90",
                ghost: "text-foreground/80 hover:text-foreground hover:bg-foreground/[0.06]",
                link: "text-primary underline-offset-4 hover:underline decoration-primary/50",
                accent: "bg-accent text-accent-foreground shadow-sm hover:bg-accent/92",
            },
            // macOS regular control height is 36px (ADR-179); `sm` is the
            // 32px small size, `xs` the 28px mini size for dense rows and
            // table chrome, `lg` the 40px large one. Icon-only actions have
            // matching `icon`, `icon-sm` and `icon-xs` squares; the ones that
            // need a 40px touch target add `.icon-touch-target`.
            size: {
                default: "h-9 px-4",
                sm: "h-8 px-3",
                xs: "h-7 px-2.5 type-footnote",
                lg: "h-10 px-6",
                icon: "h-9 w-9",
                "icon-sm": "h-8 w-8",
                "icon-xs": "h-7 w-7",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

export interface ButtonProps
    extends
        React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button";
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        );
    },
);
Button.displayName = "Button";

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
