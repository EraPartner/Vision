import { forwardRef } from "react";
import { AppLink, type AppLinkProps } from "@/lib/appNavigation";
import { cva, type VariantProps } from "@/lib/classNames";
import { cn } from "@/lib/utils";

const textLinkVariants = cva(
    "rounded-chip underline-offset-4 decoration-1 focus-ring",
    {
        variants: {
            tone: {
                primary: "text-primary decoration-primary/40 hover:underline",
                inherit: "text-inherit decoration-current/40 hover:underline",
                muted: "text-label-secondary decoration-label-secondary/40 hover:text-foreground hover:underline",
            },
        },
        defaultVariants: { tone: "primary" },
    },
);

export interface TextLinkProps
    extends AppLinkProps, VariantProps<typeof textLinkVariants> {}

export const TextLink = forwardRef<HTMLAnchorElement, TextLinkProps>(
    ({ className, tone, ...props }, ref) => (
        <AppLink
            ref={ref}
            className={cn(textLinkVariants({ tone }), className)}
            {...props}
        />
    ),
);

TextLink.displayName = "TextLink";
