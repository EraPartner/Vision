import * as React from "react";

import {cn} from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    ({className, type, onWheel, ...props}, ref) => {
        const handleWheel = React.useCallback(
            (e: React.WheelEvent<HTMLInputElement>) => {
                onWheel?.(e);
                // Prevent the mouse wheel from silently incrementing/decrementing a
                // focused number field while the user is just scrolling a long form.
                if (type === "number") {
                    (e.target as HTMLElement).blur();
                }
            },
            [onWheel, type],
        );
        return (
            <input
                type={type}
                className={cn(
                    "flex h-10 w-full rounded-lg border border-input/70 bg-background/80 px-3 py-2 text-sm tracking-tight text-foreground shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] ring-offset-background transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/70 hover:border-input focus-visible:border-primary/60 focus-visible:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                    className,
                )}
                ref={ref}
                onWheel={handleWheel}
                {...props}
            />
        );
    },
);
Input.displayName = "Input";

export {Input};
