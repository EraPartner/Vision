import * as React from "react";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-[background-color,color,border-color] duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2",
    {
        variants: {
            variant: {
                default:
                    "border-transparent bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)] hover:bg-primary/20",
                secondary:
                    "border-transparent bg-foreground/[0.06] text-foreground/80 hover:bg-foreground/[0.1]",
                destructive:
                    "border-transparent bg-destructive/15 text-destructive shadow-[inset_0_0_0_1px_hsl(var(--destructive)/0.3)] hover:bg-destructive/20",
                outline: "border-border/70 bg-transparent text-foreground/80 hover:bg-foreground/[0.04]",
                accent:
                    "border-transparent bg-accent/20 text-accent-foreground shadow-[inset_0_0_0_1px_hsl(var(--accent)/0.35)] hover:bg-accent/25",
                success:
                    "border-transparent bg-success/15 text-success shadow-[inset_0_0_0_1px_hsl(var(--success)/0.3)]",
                // Amber "needs attention, not broken" tone — same palette the
                // merge/close warning callouts already use (no new colours).
                warning:
                    "border-amber-500/40 bg-amber-500/15 text-amber-600 hover:bg-amber-500/20 dark:text-amber-500",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
}

function Badge({className, variant, ...props}: BadgeProps) {
    return <div className={cn(badgeVariants({variant}), className)} {...props} />;
}

// eslint-disable-next-line react-refresh/only-export-components
export {Badge, badgeVariants};
