import { useEffect } from "react";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/contexts/PageTitleContext";
import { cn } from "@/lib/utils";

export interface PageHeaderBack {
    /** Accessible and visible label, for example "Back to accounts". */
    label: string;
    /** Route to go back to; rendered as a link. */
    to?: string;
    /** Handler used instead of `to`, for in-page back navigation. */
    onClick?: () => void;
}

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    icon?: LucideIcon;
    iconColor?: string;
    actions?: React.ReactNode;
    /** Back control rendered above the title, for detail pages. */
    back?: PageHeaderBack;
}

export function PageHeader({
    title,
    subtitle,
    icon: Icon,
    iconColor = "text-muted-foreground",
    actions,
    back,
}: PageHeaderProps) {
    // Register the title so the topbar can show it when this header scrolls out.
    const { setTitle } = usePageTitle();
    useEffect(() => {
        setTitle(title);
        return () => setTitle(null);
    }, [title, setTitle]);

    const backControl = back ? (
        back.to ? (
            <Button
                asChild
                variant="ghost"
                size="sm"
                className="-ml-2 w-fit text-label-secondary"
            >
                <Link to={back.to}>
                    <ArrowLeft aria-hidden="true" />
                    {back.label}
                </Link>
            </Button>
        ) : (
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 w-fit text-label-secondary"
                onClick={back.onClick}
            >
                <ArrowLeft aria-hidden="true" />
                {back.label}
            </Button>
        )
    ) : null;

    return (
        <div className="canvas-text flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
            {backControl && (
                <div className="w-full sm:basis-full">{backControl}</div>
            )}
            <div className="flex min-w-0 items-center gap-3 sm:flex-1 sm:basis-80">
                {Icon && (
                    <div
                        className={cn(
                            "hidden sm:flex h-9 w-9 shrink-0 rounded-control bg-gradient-to-br",
                            iconColor,
                            "items-center justify-center",
                        )}
                    >
                        <Icon className="h-5 w-5" aria-hidden />
                    </div>
                )}
                <div className="min-w-0">
                    <h1 className="page-header-title break-words type-large-title text-foreground">
                        {title}
                    </h1>
                    {subtitle && (
                        <p className="page-header-subtitle mt-1 max-w-prose text-pretty type-body text-muted-foreground">
                            {subtitle}
                        </p>
                    )}
                </div>
            </div>
            {actions && (
                <div className="flex max-w-full flex-wrap items-center gap-2 sm:ml-auto">
                    {actions}
                </div>
            )}
        </div>
    );
}
