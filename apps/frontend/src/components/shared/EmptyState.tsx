import type { LucideIcon } from "lucide-react";
import { StateBlock } from "@/components/shared/StateBlock";

interface EmptyStateProps {
    icon: LucideIcon;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    size?: "default" | "compact";
    headingLevel?: 2 | 3 | 4;
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
