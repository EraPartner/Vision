import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StateBlockProps {
    icon: LucideIcon;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    details?: ReactNode;
    tone?: "neutral" | "destructive";
    size?: "default" | "compact";
    headingLevel?: 2 | 3 | 4;
    className?: string;
}

export function StateBlock({
    icon: Icon,
    title,
    description,
    action,
    details,
    tone = "neutral",
    size = "default",
    headingLevel = 2,
    className,
}: StateBlockProps) {
    const compact = size === "compact";
    const destructive = tone === "destructive";
    const Heading =
        headingLevel === 2 ? "h2" : headingLevel === 4 ? "h4" : "h3";

    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center px-4 text-center animate-in",
                compact ? "py-6" : "py-10 sm:py-12",
                className,
            )}
        >
            <div
                aria-hidden="true"
                className={cn(
                    "mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted/50",
                    destructive ? "text-destructive" : "text-muted-foreground",
                )}
            >
                <Icon className="h-5 w-5" />
            </div>
            <Heading
                className={cn(
                    "font-semibold text-foreground text-balance",
                    compact ? "text-base" : "text-lg",
                )}
            >
                {title}
            </Heading>
            {description && (
                <p
                    className={cn(
                        "mt-1 text-sm leading-relaxed text-pretty text-muted-foreground",
                        compact ? "max-w-xs" : "max-w-sm",
                    )}
                >
                    {description}
                </p>
            )}
            {details && <div className="mt-3 w-full max-w-lg">{details}</div>}
            {action && (
                <div
                    className={cn(
                        "flex max-w-full flex-wrap justify-center gap-2",
                        compact ? "mt-4" : "mt-5",
                    )}
                >
                    {action}
                </div>
            )}
        </div>
    );
}
