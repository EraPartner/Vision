import { Link } from "react-router";
import { AlertTriangle, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { ApiClientError } from "@/lib/api/client";
import { apiErrorToMessage } from "@/lib/api/errorMessage";

/**
 * True when a query error is an admin auth failure (401 Unauthorized / 403
 * Forbidden). These are recoverable by setting the admin token on `/admin`,
 * so the error state points the user there rather than showing a raw string.
 */
function isAdminAuthError(error: unknown): boolean {
    return (
        error instanceof ApiClientError &&
        (error.status === 401 || error.status === 403)
    );
}

/**
 * Error state for admin sub-pages. On an auth failure it mirrors the token card
 * on `/admin` and links back to it; any other error falls back to a plain
 * message so the user still sees what went wrong.
 */
export function AdminErrorState({
    error,
    fallbackMessage,
}: {
    error: unknown;
    fallbackMessage: string;
}) {
    const { t } = useLanguage();

    if (isAdminAuthError(error)) {
        return (
            <Alert variant="destructive" role="alert">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>{t("admin.authError.title")}</AlertTitle>
                <AlertDescription className="space-y-3">
                    <p>{t("admin.authError.description")}</p>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/admin">{t("admin.authError.action")}</Link>
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

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
