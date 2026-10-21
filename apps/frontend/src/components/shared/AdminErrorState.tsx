import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiErrorToMessage } from "@/lib/api/errorMessage";

/** Error state for admin sub-pages: the page's title plus a humanized message. */
export function AdminErrorState({
    error,
    fallbackMessage,
}: {
    error: unknown;
    fallbackMessage: string;
}) {
    const { t } = useLanguage();

    // Humanized, not raw: this is the page-level twin of the toast leak — a
    // browser's "Failed to fetch" or a transport sentinel is noise to a user.
    const message = apiErrorToMessage(error, t);
    return (
        <Alert variant="destructive" role="alert">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{fallbackMessage}</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
        </Alert>
    );
}
