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
                compact ? "py-8" : "py-16",
                className,
            )}
        >
            <div className={cn("relative", compact ? "mb-3" : "mb-5")}>
                <div
                    aria-hidden="true"
                    className={cn(
                        "absolute rounded-3xl blur-2xl",
                        compact ? "-inset-2" : "-inset-3",
                        destructive
                            ? "bg-destructive/10"
                            : "bg-gradient-to-br from-primary/15 to-accent/10",
                    )}
                />
                <div
                    className={cn(
                        "relative flex items-center justify-center rounded-2xl glass-regular",
                        compact ? "h-12 w-12" : "h-16 w-16",
                        destructive && "border-destructive/20 bg-destructive/5",
                    )}
                >
                    <Icon
                        className={cn(
                            compact ? "h-6 w-6" : "h-8 w-8",
                            destructive
                                ? "text-destructive/80"
                                : "text-muted-foreground/70",
                        )}
                    />
                </div>
            </div>
            <Heading
                className={cn(
                    "font-display font-semibold text-foreground",
                    compact ? "text-base" : "text-lg",
                )}
            >
                {title}
            </Heading>
            {description && (
                <p
                    className={cn(
                        "mt-1 text-sm text-muted-foreground",
                        compact ? "max-w-xs" : "max-w-sm",
                    )}
                >
                    {description}
                </p>
            )}
            {details && <div className="mt-3 w-full max-w-lg">{details}</div>}
            {action && (
                <div className={compact ? "mt-4" : "mt-5"}>{action}</div>
            )}
        </div>
    );
}
