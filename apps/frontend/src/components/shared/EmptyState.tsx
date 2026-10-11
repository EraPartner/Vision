import type { LucideIcon } from "lucide-react";
import { StateBlock } from "@/components/shared/StateBlock";

interface EmptyStateProps {
    icon: LucideIcon;
    title: React.ReactNode;
    description?: React.ReactNode | undefined;
    action?: React.ReactNode | undefined;
    size?: "default" | "compact" | undefined;
    headingLevel?: 2 | 3 | 4 | undefined;
}

export function EmptyState({ icon, title, description, action, size, headingLevel }: EmptyStateProps) {
    return (
        <StateBlock
            icon={icon}
            title={title}
            description={description}
            action={action}
            size={size}
            headingLevel={headingLevel}
        />
    );
}
