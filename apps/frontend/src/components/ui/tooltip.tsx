import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import {cn} from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
    React.ElementRef<typeof TooltipPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({className, sideOffset = 6, ...props}, ref) => (
    <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
            "z-50 overflow-hidden rounded-lg glass-thick px-2.5 py-1.5 text-xs font-medium tracking-tight text-popover-foreground data-[state=instant-open]:animate-in data-[state=delayed-open]:animate-in data-[state=instant-open]:duration-[var(--duration-fast)] data-[state=delayed-open]:duration-[var(--duration-fast)] data-[state=closed]:animate-out data-[state=closed]:duration-[var(--duration-fast)] ease-[var(--ease-out-expo)] data-[state=instant-open]:fade-in-0 data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:zoom-in-95 data-[state=delayed-open]:zoom-in-95 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 motion-reduce:data-[state=instant-open]:animate-none motion-reduce:data-[state=delayed-open]:animate-none motion-reduce:data-[state=closed]:animate-none",
            className,
        )}
        {...props}
    />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export {Tooltip, TooltipTrigger, TooltipContent, TooltipProvider};
