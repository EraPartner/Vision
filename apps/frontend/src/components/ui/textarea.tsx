import * as React from "react";

import {cn} from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({className, ...props}, ref) => {
    return (
        <textarea
            className={cn(
                "flex min-h-20 w-full rounded-control border border-input/70 bg-background/80 px-3 py-2 type-body text-foreground shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] transition-[border-color,box-shadow,background-color] duration-fast ease-glide placeholder:text-label-tertiary hover:border-input focus-visible:border-primary/60 focus-visible:bg-background/70 focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            ref={ref}
            {...props}
        />
    );
});
Textarea.displayName = "Textarea";

export {Textarea};
