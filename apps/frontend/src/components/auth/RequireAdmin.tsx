import { type ReactNode } from "react";
import { Navigate } from "react-router";
import { useAppSettings } from "@/contexts/AppSettingsContext";

/**
 * Gate the /admin/* routes behind the user's adminMode toggle. The
 * backend (apps/node-backend/src/middleware/adminAuth.js) is the actual
 * security boundary — it rejects /api/admin requests without the admin
 * token. This guard exists purely for UX: without it, deep-linking to
 * /admin renders an empty page that fails every API call. With it, the
 * user is redirected back to the dashboard until they enable Admin Mode
 * in settings.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
    const { appSettings, isLoading } = useAppSettings();

    if (isLoading) return null;
    if (!appSettings.adminMode) return <Navigate to="/" replace />;
    return <>{children}</>;
}
