import {cn} from "@/lib/utils";

function Skeleton({className, ...props}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-md bg-foreground/[0.06] bg-[linear-gradient(90deg,transparent_0%,hsl(var(--foreground)/0.08)_50%,transparent_100%)] bg-[length:200%_100%] animate-shimmer",
                className,
            )}
            {...props}
        />
    );
}

export {Skeleton};
