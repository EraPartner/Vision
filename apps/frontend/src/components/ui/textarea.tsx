import * as React from "react";

import {cn} from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({className, ...props}, ref) => {
    return (
        <textarea
            className={cn(
                "flex min-h-[80px] w-full rounded-lg border border-input/70 bg-background/80 px-3 py-2 text-sm tracking-tight text-foreground shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] ring-offset-background transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] placeholder:text-muted-foreground/70 hover:border-input focus-visible:border-primary/60 focus-visible:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            ref={ref}
            {...props}
        />
    );
});
Textarea.displayName = "Textarea";

export {Textarea};
