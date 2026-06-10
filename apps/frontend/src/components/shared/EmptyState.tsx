import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
    icon: LucideIcon;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center animate-in">
            <div className="relative mb-5">
                <div aria-hidden="true" className="absolute -inset-3 rounded-3xl bg-gradient-to-br from-primary/15 to-accent/10 blur-2xl" />
                <div className="relative h-16 w-16 rounded-2xl glass-regular flex items-center justify-center">
                    <Icon className="h-8 w-8 text-muted-foreground/70" />
                </div>
            </div>
            <h3 className="font-display text-lg font-semibold text-foreground mb-1">{title}</h3>
            {description && (
                <p className="text-sm text-muted-foreground max-w-sm">{description}</p>
            )}
            {action && <div className="mt-5">{action}</div>}
        </div>
    );
}
