import { CloudOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface ResearchUnavailableNoteProps {
    /** The provider that was attempted, or null when none was usable. */
    provider?: string | null;
    className?: string;
}

/**
 * Surfaces `meta.source === 'unavailable'` from the research API. Per ADR-079,
 * an unavailable response is genuine — all providers were exhausted, unkeyed, or
 * unhealthy — so the UI shows a "live data unavailable" indicator rather than a
 * loading spinner or a silent blank.
 */
export function ResearchUnavailableNote({
    provider,
    className,
}: ResearchUnavailableNoteProps) {
    const { t } = useLanguage();
    return (
        <Alert variant="warning" role="note" className={className}>
            <CloudOff className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{t("research.unavailable")}</AlertTitle>
            {provider && (
                <AlertDescription>
                    {t("research.unavailableProvider", { provider })}
                </AlertDescription>
            )}
        </Alert>
    );
}
