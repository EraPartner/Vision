import type { LucideIcon } from "lucide-react";

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    icon?: LucideIcon;
    iconColor?: string;
    actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, icon: Icon, iconColor = "from-primary/20 to-primary/5 text-primary", actions }: PageHeaderProps) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
                {Icon && (
                    <div className={`hidden sm:flex h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br ${iconColor} items-center justify-center shadow-sm`}>
                        <Icon className="h-6 w-6" />
                    </div>
                )}
                <div>
                    <h1 className="text-3xl font-bold text-foreground tracking-tight">{title}</h1>
                    {subtitle && <p className="text-muted-foreground mt-1">{subtitle}</p>}
                </div>
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
    );
}
