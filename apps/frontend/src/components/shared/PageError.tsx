import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

interface PageErrorProps {
    message: string;
    onRetry?: () => void;
}

export function PageError({ message, onRetry }: PageErrorProps) {
    const { t } = useLanguage();
    return (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-destructive/15 to-destructive/5 flex items-center justify-center mb-4 shadow-sm">
                <AlertTriangle className="h-8 w-8 text-destructive/70" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">Something went wrong</h3>
            <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
            {onRetry && (
                <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
                    Try again
                </Button>
            )}
        </div>
    );
}
