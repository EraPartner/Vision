import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import {motion, useReducedMotion} from "framer-motion";

import {cn} from "@/lib/utils";
import {springs} from "@/lib/motion";

// Mirrors the active value (Radix doesn't expose it to triggers) so the
// active pill can magic-move between triggers via framer layoutId.
const TabsActiveValueContext = React.createContext<string | undefined>(undefined);
const TabsLayoutIdContext = React.createContext<string>("tabs");

const Tabs = React.forwardRef<
    React.ElementRef<typeof TabsPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({value, defaultValue, onValueChange, ...props}, ref) => {
    const [active, setActive] = React.useState<string | undefined>(value ?? defaultValue);
    const layoutId = React.useId();

    React.useEffect(() => {
        if (value !== undefined) setActive(value);
    }, [value]);

    return (
        <TabsLayoutIdContext.Provider value={layoutId}>
            <TabsActiveValueContext.Provider value={active}>
                <TabsPrimitive.Root
                    ref={ref}
                    value={value}
                    defaultValue={defaultValue}
                    onValueChange={(v) => {
                        setActive(v);
                        onValueChange?.(v);
                    }}
                    {...props}
                />
            </TabsActiveValueContext.Provider>
        </TabsLayoutIdContext.Provider>
    );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

const TabsList = React.forwardRef<
    React.ElementRef<typeof TabsPrimitive.List>,
    React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({className, ...props}, ref) => (
    <TabsPrimitive.List
        ref={ref}
        className={cn(
            "inline-flex h-10 items-center justify-center gap-1 rounded-xl border border-border/50 bg-muted/70 p-1 text-muted-foreground",
            className,
        )}
        {...props}
    />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
    React.ElementRef<typeof TabsPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({className, value, children, ...props}, ref) => {
    const active = React.useContext(TabsActiveValueContext);
    const layoutId = React.useContext(TabsLayoutIdContext);
    const reducedMotion = useReducedMotion();
    const isActive = active === value;

    return (
        <TabsPrimitive.Trigger
            ref={ref}
            value={value}
            className={cn(
                "relative inline-flex items-center justify-center whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium tracking-tight ring-offset-background transition-[color] duration-[var(--duration-normal)] ease-[var(--ease-out-expo)] hover:text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground",
                className,
            )}
            {...props}
        >
            {isActive && (
                <motion.span
                    layoutId={`${layoutId}-pill`}
                    aria-hidden="true"
                    transition={reducedMotion ? {duration: 0} : springs.snappy}
                    className="absolute inset-0 rounded-lg bg-background/90 shadow-[0_4px_14px_-6px_hsl(var(--primary)/0.25)] ring-1 ring-primary/20"
                />
            )}
            <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
        </TabsPrimitive.Trigger>
    );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
    React.ElementRef<typeof TabsPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({className, ...props}, ref) => (
    <TabsPrimitive.Content
        ref={ref}
        className={cn(
            "mt-3 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2",
            className,
        )}
        {...props}
    />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export {Tabs, TabsList, TabsTrigger, TabsContent};
