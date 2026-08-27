import { forwardRef } from "react";
import { Link, type LinkProps } from "react-router";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const textLinkVariants = cva(
    "rounded-sm underline-offset-4 decoration-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2",
    {
        variants: {
            tone: {
                primary: "text-primary decoration-primary/40 hover:underline",
                inherit: "text-inherit decoration-current/40 hover:underline",
                muted: "text-muted-foreground decoration-muted-foreground/40 hover:text-foreground hover:underline",
            },
        },
        defaultVariants: { tone: "primary" },
    },
);

export interface TextLinkProps
    extends LinkProps, VariantProps<typeof textLinkVariants> {}

export const TextLink = forwardRef<HTMLAnchorElement, TextLinkProps>(
    ({ className, tone, ...props }, ref) => (
        <Link
            ref={ref}
            className={cn(textLinkVariants({ tone }), className)}
            {...props}
        />
    ),
);

TextLink.displayName = "TextLink";
