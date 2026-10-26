import { type ReactNode } from "react";
import { AppNavigate } from "@/lib/appNavigation";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";

/**
 * Gate the /admin/* routes behind the user's adminMode toggle. This is
 * purely a UX preference, not a security boundary: the backend is
 * loopback-only and has no admin credentials (ADR-233). Until Admin Mode is
 * enabled in settings, the user is redirected back to the dashboard.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
    const { appSettings, isLoading } = useAppSettings();

    if (isLoading) return null;
    if (!appSettings.adminMode) return <AppNavigate to="/" replace />;
    return <>{children}</>;
}
