import * as React from "react";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-[background-color,color,border-color] duration-[var(--duration-fast)] ease-[var(--ease-glide)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2",
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
                // Neutral "what kind of thing is this" pill on a solid muted
                // ground — the flat counterpart to `secondary`'s translucent
                // glass tone, for dense table/inspector rows.
                muted: "border-transparent bg-muted text-muted-foreground",
            },
            // The default badge is a small-caps label; `sm` is the dense pill
            // used inside table rows and toolbars, where a count or a raw
            // identifier has to stay legible rather than be styled as a label.
            size: {
                default: "",
                sm: "px-2 py-0.5 text-xs normal-case tracking-normal",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
}

function Badge({className, variant, size, ...props}: BadgeProps) {
    return <div className={cn(badgeVariants({variant, size}), className)} {...props} />;
}

// eslint-disable-next-line react-refresh/only-export-components
export {Badge, badgeVariants};
