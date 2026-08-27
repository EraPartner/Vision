import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { StateBlock } from "@/components/shared/StateBlock";

interface PageErrorProps {
    message: string;
    /** Per-surface heading (e.g. "Couldn't load your portfolio"). Defaults to the generic common.error copy. */
    title?: string;
    onRetry?: () => void;
}

export function PageError({ message, title, onRetry }: PageErrorProps) {
    const { t } = useLanguage();
    return (
        <StateBlock
            icon={AlertTriangle}
            tone="destructive"
            title={title ?? t('common.error')}
            description={message}
            action={onRetry && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                    {t('common.retry')}
                </Button>
            )}
        />
    );
}
