import * as React from "react";
import {cva, type VariantProps} from "class-variance-authority";

import {cn} from "@/lib/utils";

const alertVariants = cva(
    "relative w-full rounded-xl p-4 shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4",
    {
        variants: {
            variant: {
                default:
                    "border border-border/60 bg-foreground/[0.03] text-foreground [&>svg]:text-foreground/80",
                destructive:
                    "border border-destructive/30 bg-destructive/10 text-destructive [&>svg]:text-destructive",
                warning:
                    "border border-warning/30 bg-warning/10 text-foreground [&>svg]:text-warning",
                success:
                    "border border-success/30 bg-success/10 text-success [&>svg]:text-success",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);

const Alert = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({className, variant, ...props}, ref) => (
    <div ref={ref} role="alert" className={cn(alertVariants({variant}), className)} {...props} />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
    ({className, ...props}, ref) => (
        <h5
            ref={ref}
            className={cn("mb-1 font-display text-sm font-semibold leading-tight tracking-tight", className)}
            {...props}
        />
    ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
    ({className, ...props}, ref) => (
        <div
            ref={ref}
            className={cn("text-sm opacity-90 tracking-tight [&_p]:leading-relaxed", className)}
            {...props}
        />
    ),
);
AlertDescription.displayName = "AlertDescription";

export {Alert, AlertTitle, AlertDescription};
