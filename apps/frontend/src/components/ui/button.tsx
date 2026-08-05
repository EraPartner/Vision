import * as React from "react";
import {Slot} from "@radix-ui/react-slot";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

const buttonVariants = cva(
    "press-feedback inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium tracking-tight ring-offset-background transition-[background-color,box-shadow,transform,color] duration-[var(--duration-fast)] ease-[var(--ease-glide)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default:
                    "bg-primary text-primary-foreground shadow-[0_6px_18px_-8px_hsl(var(--primary)/0.55)] hover:bg-primary/92 hover:-translate-y-px hover:shadow-[0_10px_28px_-10px_hsl(var(--primary)/0.65)] active:translate-y-0",
                destructive:
                    "bg-destructive text-destructive-foreground shadow-[0_6px_18px_-8px_hsl(var(--destructive)/0.55)] hover:bg-destructive/92 hover:-translate-y-px",
                outline:
                    "rounded-xl border border-input/70 bg-background/80 text-foreground hover:bg-background hover:text-foreground hover:-translate-y-px",
                secondary:
                    "rounded-xl border border-border/50 bg-secondary text-secondary-foreground hover:bg-secondary/90 hover:-translate-y-px",
                ghost:
                    "text-foreground/80 hover:text-foreground hover:bg-foreground/[0.06]",
                link: "text-primary underline-offset-4 hover:underline decoration-primary/50",
                accent:
                    "bg-accent text-accent-foreground shadow-[0_6px_18px_-8px_hsl(var(--accent)/0.55)] hover:bg-accent/92 hover:-translate-y-px",
            },
            size: {
                default: "h-10 px-4 py-2",
                sm: "h-9 rounded-md px-3",
                lg: "h-11 rounded-xl px-8 text-[0.95rem]",
                icon: "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({className, variant, size, asChild = false, ...props}, ref) => {
        const Comp = asChild ? Slot : "button";
        return <Comp className={cn(buttonVariants({variant, size, className}))} ref={ref} {...props} />;
    },
);
Button.displayName = "Button";

// eslint-disable-next-line react-refresh/only-export-components
export {Button, buttonVariants};
