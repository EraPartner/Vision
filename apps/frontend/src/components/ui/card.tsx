import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Static content keeps its glass material and rests under the pointer.
 * Use interactive only for a card whose surface activates a link or action.
 * A prominent total is a visual emphasis choice, not a click affordance.
 * Interactive lift uses Tailwind's translate property; reduced-motion CSS
 * cancels it with matching specificity in index.css.
 */
const cardVariants = cva(
    "card-material glass-thin premium-frame relative rounded-card corner-continuous text-card-foreground",
    {
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
    },
);

export interface CardProps
    extends
        React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof cardVariants> {
    asChild?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
    ({ className, variant, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "div";
        return (
            <Comp
                ref={ref}
                className={cn(cardVariants({ variant }), className)}
                {...props}
            />
        );
    },
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn("flex flex-col space-y-1.5 p-6", className)}
        {...props}
    />
));
CardHeader.displayName = "CardHeader";

const cardTitleVariants = cva("leading-tight", {
    variants: {
        variant: {
            default: "type-title-2 text-foreground",
            sm: "type-title-3 text-foreground",
            label: "type-body font-medium text-label-secondary",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});

export interface CardTitleProps
    extends
        React.HTMLAttributes<HTMLHeadingElement>,
        VariantProps<typeof cardTitleVariants> {
    /** Semantic heading level. Page-level card sections default to h2. */
    level?: 2 | 3 | 4;
}

const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
    ({ className, variant, level = 2, ...props }, ref) => {
        const Heading = `h${level}` as "h2" | "h3" | "h4";
        return (
            <Heading
                ref={ref}
                className={cn(cardTitleVariants({ variant }), className)}
                {...props}
            />
        );
    },
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
    HTMLParagraphElement,
    React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
    <p
        ref={ref}
        className={cn("type-body text-label-secondary", className)}
        {...props}
    />
));
CardDescription.displayName = "CardDescription";

const cardContentVariants = cva("", {
    variants: {
        variant: {
            default: "p-6 pt-0",
            headerless: "p-6",
            flush: "p-0",
            compact: "p-4",
            row: "px-6 py-4",
            state: "px-6 py-8",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});

export interface CardContentProps
    extends
        React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof cardContentVariants> {}

const CardContent = React.forwardRef<HTMLDivElement, CardContentProps>(
    ({ className, variant, ...props }, ref) => (
        <div
            ref={ref}
            className={cn(cardContentVariants({ variant }), className)}
            {...props}
        />
    ),
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn("flex items-center p-6 pt-0", className)}
        {...props}
    />
));
CardFooter.displayName = "CardFooter";

export {
    Card,
    CardHeader,
    CardFooter,
    CardTitle,
    CardDescription,
    CardContent,
};
