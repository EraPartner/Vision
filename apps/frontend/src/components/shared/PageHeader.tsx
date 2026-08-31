import { useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import { usePageTitle } from "@/contexts/PageTitleContext";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    icon?: LucideIcon;
    iconColor?: string;
    actions?: React.ReactNode;
}

export function PageHeader({
    title,
    subtitle,
    icon: Icon,
    iconColor = "from-primary/20 to-primary/5 text-primary",
    actions,
}: PageHeaderProps) {
    // Register the title so the topbar can show it when this header scrolls out.
    const { setTitle } = usePageTitle();
    useEffect(() => {
        setTitle(title);
        return () => setTitle(null);
    }, [title, setTitle]);

    return (
        <div className="canvas-text flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex items-center gap-4">
                {Icon && (
                    <div
                        className={cn(
                            "hidden sm:flex h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br",
                            iconColor,
                            "items-center justify-center icon-tile-glow",
                        )}
                    >
                        <Icon className="h-6 w-6" />
                    </div>
                )}
                <div>
                    <h1 className="page-header-title text-3xl font-bold text-foreground tracking-tight">
                        {title}
                    </h1>
                    {subtitle && (
                        <p className="page-header-subtitle text-muted-foreground mt-1">
                            {subtitle}
                        </p>
                    )}
                </div>
            </div>
            {actions && (
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {actions}
                </div>
            )}
        </div>
    );
}
