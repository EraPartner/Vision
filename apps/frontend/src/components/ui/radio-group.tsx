import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import {Circle} from "lucide-react";

import {cn} from "@/lib/utils";

const RadioGroup = React.forwardRef<
    React.ElementRef<typeof RadioGroupPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({className, ...props}, ref) => {
    return <RadioGroupPrimitive.Root className={cn("grid gap-2.5", className)} {...props} ref={ref}/>;
});
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
    React.ElementRef<typeof RadioGroupPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({className, ...props}, ref) => {
    return (
        <RadioGroupPrimitive.Item
            ref={ref}
            className={cn(
                "aspect-square h-[18px] w-[18px] rounded-full border border-input/80 bg-background/40 text-primary shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.04)] ring-offset-background transition-[background-color,border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] hover:border-primary/60 data-[state=checked]:border-primary data-[state=checked]:shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            {...props}
        >
            <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
                <Circle className="h-2.5 w-2.5 fill-primary text-primary"/>
            </RadioGroupPrimitive.Indicator>
        </RadioGroupPrimitive.Item>
    );
});
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export {RadioGroup, RadioGroupItem};
