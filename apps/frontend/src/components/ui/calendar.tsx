import * as React from "react";
import {ChevronLeft, ChevronRight} from "lucide-react";
import {DayPicker} from "react-day-picker";

import {cn} from "@/lib/utils";
import {buttonVariants} from "@/components/ui/button";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({className, classNames, showOutsideDays = true, ...props}: CalendarProps) {
    const weekStartsOn = props.weekStartsOn ?? 1;
    return (
        <DayPicker
            showOutsideDays={showOutsideDays}
            weekStartsOn={weekStartsOn}
            className={cn("p-3", className)}
            classNames={{
                months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0",
                month: "space-y-4 relative",
                month_caption: "flex justify-center pt-1 relative items-center",
                caption_label: "font-display text-sm font-semibold tracking-tight text-foreground",
                nav: "flex items-center",
                button_previous: cn(
                    buttonVariants({variant: "ghost", size: "icon"}),
                    "absolute left-1 top-1 z-10 h-7 w-7 p-0 text-muted-foreground/80 hover:text-foreground",
                ),
                button_next: cn(
                    buttonVariants({variant: "ghost", size: "icon"}),
                    "absolute right-1 top-1 z-10 h-7 w-7 p-0 text-muted-foreground/80 hover:text-foreground",
                ),
                month_grid: "w-full border-collapse space-y-1",
                weekdays: "flex",
                weekday: "w-9 rounded-md text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70",
                week: "flex w-full mt-2",
                // `day` is the grid cell (<td>); `day_button` is the clickable button inside it.
                day: "relative h-9 w-9 p-0 text-center text-sm focus-within:relative focus-within:z-20",
                day_button: cn(
                    buttonVariants({variant: "ghost"}),
                    "h-9 w-9 p-0 font-normal tracking-tight aria-selected:opacity-100",
                ),
                // Selection / day-state modifiers (v10: applied to the `day` cell).
                selected:
                    "rounded-md [&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.4)] [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground [&>button:focus]:bg-primary [&>button:focus]:text-primary-foreground",
                today: "rounded-md bg-foreground/[0.06] font-semibold text-foreground",
                outside: "text-muted-foreground/50",
                disabled: "text-muted-foreground/50 opacity-50",
                range_start: "rounded-l-md",
                range_middle: "!rounded-none bg-primary/10 [&>button]:bg-transparent [&>button]:text-foreground",
                range_end: "rounded-r-md",
                hidden: "invisible",
                ...classNames,
            }}
            components={{
                Chevron: ({orientation}) => orientation === "left"
                    ? <ChevronLeft className="h-4 w-4"/>
                    : <ChevronRight className="h-4 w-4"/>,
            }}
            {...props}
        />
    );
}

Calendar.displayName = "Calendar";

export {Calendar};
