import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import {cn} from "@/lib/utils";

const Slider = React.forwardRef<
    React.ElementRef<typeof SliderPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({className, ...props}, ref) => (
    <SliderPrimitive.Root
        ref={ref}
        className={cn("relative flex w-full touch-none select-none items-center", className)}
        {...props}
    >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-foreground/10 shadow-[inset_0_1px_1px_0_hsl(var(--foreground)/0.04)]">
            <SliderPrimitive.Range className="absolute h-full bg-primary shadow-[0_0_10px_-2px_hsl(var(--primary)/0.6)]"/>
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
            className="block h-5 w-5 rounded-full border border-primary/40 bg-background shadow-glass-soft ring-offset-background transition-[scale,box-shadow] motion-reduce:transition-[box-shadow] duration-[var(--duration-fast)] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        />
    </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export {Slider};
