import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export interface PageShellProps extends ComponentPropsWithoutRef<"div"> {
    rhythm?: "standard" | "airy";
}

/** Canonical vertical rhythm for page-level content below PageTransition. */
export const PageShell = forwardRef<HTMLDivElement, PageShellProps>(
    ({ rhythm = "standard", className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn(
                className,
                rhythm === "airy" ? "space-y-8" : "space-y-6",
            )}
            {...props}
        />
    ),
);

PageShell.displayName = "PageShell";
