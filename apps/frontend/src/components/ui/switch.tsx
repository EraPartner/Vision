import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import {cn} from "@/lib/utils";

const Switch = React.forwardRef<
    React.ElementRef<typeof SwitchPrimitives.Root>,
    React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({className, ...props}, ref) => (
    <SwitchPrimitives.Root
        className={cn(
            "peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-[inset_0_1px_2px_hsl(var(--foreground)/0.08)] transition-[background-color,box-shadow] duration-normal ease-glide data-[state=unchecked]:bg-foreground/[0.1] data-[state=checked]:bg-primary data-[state=checked]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.6),0_2px_10px_-2px_hsl(var(--primary)/0.4)] focus-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
        )}
        {...props}
        ref={ref}
    >
        <SwitchPrimitives.Thumb
            className={cn(
                "pointer-events-none block h-[18px] w-[18px] rounded-full bg-background shadow-[0_1px_3px_rgba(0,0,0,0.3),inset_0_1px_0_0_hsl(var(--foreground)/0.12)] ring-0 transition-transform duration-spring-snappy ease-spring-snappy data-[state=checked]:translate-x-[17px] data-[state=unchecked]:translate-x-[1px]",
            )}
        />
    </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export {Switch};
