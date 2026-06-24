import { useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import { usePageTitle } from "@/contexts/PageTitleContext";

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    /** Alias for `subtitle`, rendered identically when `subtitle` is absent. */
    description?: string;
    icon?: LucideIcon;
    iconColor?: string;
    actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, description, icon: Icon, iconColor = "from-primary/20 to-primary/5 text-primary", actions }: PageHeaderProps) {
    // Register the title so the topbar can show it when this header scrolls out.
    const { setTitle } = usePageTitle();
    useEffect(() => {
        setTitle(title);
        return () => setTitle(null);
    }, [title, setTitle]);

    return (
        <div className="canvas-text flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
                {Icon && (
                    <div className={`hidden sm:flex h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br ${iconColor} items-center justify-center shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)]`}>
                        <Icon className="h-6 w-6" />
                    </div>
                )}
                <div>
                    <h1 className="text-3xl font-bold text-foreground tracking-tight">{title}</h1>
                    {(subtitle ?? description) && <p className="text-muted-foreground mt-1">{subtitle ?? description}</p>}
                </div>
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
    );
}
