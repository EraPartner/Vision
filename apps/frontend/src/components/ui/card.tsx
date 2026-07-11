import * as React from "react";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

/**
 * Card material vs. affordance (ADR-105 elevation hierarchy).
 *
 * The base card carries the glass *material* and sits still — a static content
 * card must not react to the pointer, or the affordance stops meaning anything.
 * The `interactive` variant is the single, hierarchical hover treatment: it
 * lifts, glows the border primary, and rises to the elevated shadow. Reach for
 * it on hero/KPI tiles and clickable cards — never on plain content.
 *
 * The hover treatment lives in the `.micro-lift` utility (index.css) so the two
 * mechanisms can't drift; the variant simply applies it plus a pointer cursor.
 */
const cardVariants = cva(
    "glass-regular premium-frame relative rounded-[0.75rem] text-card-foreground",
    {
        variants: {
            variant: {
                default: "",
                interactive: "micro-lift cursor-pointer",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);

interface CardProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({className, variant, ...props}, ref) => (
    <div ref={ref} className={cn(cardVariants({variant}), className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({className, ...props}, ref) => (
        <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
    ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
    ({className, ...props}, ref) => (
        <h3
            ref={ref}
            className={cn(
                "font-display text-2xl font-semibold leading-tight tracking-tight text-foreground",
                className,
            )}
            {...props}
        />
    ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
    ({className, ...props}, ref) => (
        <p ref={ref} className={cn("text-sm text-muted-foreground/90 tracking-tight", className)} {...props} />
    ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({className, ...props}, ref) => <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({className, ...props}, ref) => (
        <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
    ),
);
CardFooter.displayName = "CardFooter";

export {Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent};
