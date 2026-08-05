import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import {Check} from "lucide-react";

import {cn} from "@/lib/utils";

const Checkbox = React.forwardRef<
    React.ElementRef<typeof CheckboxPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({className, ...props}, ref) => (
    <CheckboxPrimitive.Root
        ref={ref}
        className={cn(
            "peer h-[18px] w-[18px] shrink-0 rounded-[5px] border border-input/80 bg-background/40 shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] ring-offset-background transition-[background-color,border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-glide)] hover:border-primary/60 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            className,
        )}
        {...props}
    >
        <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
            <Check className="h-3.5 w-3.5" strokeWidth={3}/>
        </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export {Checkbox};
