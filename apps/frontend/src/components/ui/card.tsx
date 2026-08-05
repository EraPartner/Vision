import * as React from "react";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

/**
 * Hover affordance is HIERARCHICAL, not universal (ADR-105).
 *
 * Every Card used to lift, recolor its border to primary and fade in the
 * elevated shadow on hover. Uniform affordance is no affordance: a static
 * disclaimer reacted exactly like a clickable account tile, and the
 * glass-regular / glass-elevated elevation ladder ADR-105 built collapsed the
 * moment the pointer moved. The character is kept in full — it is now *routed*
 * to the cards that have earned it rather than sprayed across all of them.
 *
 * - `static` (default): the glass material and `premium-frame`'s resting
 *   embossed frame, unchanged. It simply sits still under the cursor.
 * - `interactive`: today's exact hover — the −2px lift, the primary border
 *   glow and the pre-rendered elevated shadow fading in — plus the press
 *   settle, because anything that lifts on hover must acknowledge the click.
 *   Use it for cards you can activate (click / navigate / open) and for
 *   hero-KPI tiles, the "something you could pick up" tier.
 *
 * There is deliberately no third `elevated` hover tier: ADR-105 specifies
 * elevation as a *material* (`glass-regular` for cards vs `glass-elevated` for
 * hero tiles/KPIs), applied via the class at the call site and orthogonal to
 * this variant. Inventing a third hover tier would add exactly the invented
 * sameness the ADR set out to remove.
 *
 * The lift is a single transform. `micro-lift` used to be re-added at the call
 * sites, stacking its `transform: translateY(-1px)` on top of the base
 * `hover:-translate-y-0.5`, which in Tailwind v4 rides the separate `translate`
 * property — two transforms composing to an inconsistent −3px on some pages and
 * −2px on others. The variant now owns the lift outright.
 *
 * That same `translate`-not-`transform` detail is why the reduced-motion
 * classes below come in pairs, and why they are not the whole story: an
 * unqualified `motion-reduce:*` utility (0,1,0) loses the cascade to
 * `.hover\:-translate-y-0\.5:hover` (0,2,0), so the lift is actually cancelled
 * by `.premium-frame-interactive:hover { translate: none }` in the
 * `prefers-reduced-motion` block of index.css. These stay as the declaration of
 * intent at the call site and to cover the resting/`:active` states.
 */
const cardVariants = cva("glass-regular premium-frame relative rounded-[0.75rem] text-card-foreground", {
    variants: {
        variant: {
            static: "",
            interactive:
                "premium-frame-interactive press-feedback hover:-translate-y-0.5 active:translate-y-0 motion-reduce:translate-none motion-reduce:transform-none motion-reduce:transition-none",
        },
    },
    defaultVariants: {
        variant: "static",
    },
});

export interface CardProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}

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
