import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Native `<details>` disclosure on the design system (ADR-187 follow-up). It
 * keeps the browser's open state, keyboard handling and the marker, and only
 * standardises the summary typography and the optional card surface, so the
 * many progressive-disclosure sections in research, analysis and import
 * screens read the same way.
 */
const disclosureVariants = cva("group", {
    variants: {
        variant: {
            plain: "",
            card: "rounded-card corner-continuous border border-border/60 bg-card/70",
            inset: "rounded-control bg-foreground/[0.03]",
        },
    },
    defaultVariants: { variant: "plain" },
});

export interface DisclosureProps
    extends
        React.DetailsHTMLAttributes<HTMLDetailsElement>,
        VariantProps<typeof disclosureVariants> {}

const Disclosure = React.forwardRef<HTMLDetailsElement, DisclosureProps>(
    ({ className, variant, ...props }, ref) => (
        <details
            ref={ref}
            className={cn(disclosureVariants({ variant }), className)}
            {...props}
        />
    ),
);
Disclosure.displayName = "Disclosure";

const summaryVariants = cva(
    "cursor-pointer select-none rounded-control marker:text-label-tertiary focus-ring",
    {
        variants: {
            tone: {
                default: "type-body font-medium text-foreground",
                subtle: "type-callout text-label-secondary",
                footnote: "w-fit type-footnote text-label-secondary",
            },
            padded: {
                true: "px-4 py-3",
                false: "",
            },
        },
        defaultVariants: { tone: "default", padded: false },
    },
);

export interface DisclosureSummaryProps
    extends
        React.HTMLAttributes<HTMLElement>,
        VariantProps<typeof summaryVariants> {}

const DisclosureSummary = React.forwardRef<HTMLElement, DisclosureSummaryProps>(
    ({ className, tone, padded, ...props }, ref) => (
        <summary
            ref={ref}
            className={cn(summaryVariants({ tone, padded }), className)}
            {...props}
        />
    ),
);
DisclosureSummary.displayName = "DisclosureSummary";

/** Body of a card or inset disclosure; plain disclosures lay out their own body. */
const DisclosureContent = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div ref={ref} className={cn("px-4 pb-4 pt-1", className)} {...props} />
));
DisclosureContent.displayName = "DisclosureContent";

export { Disclosure, DisclosureSummary, DisclosureContent };
