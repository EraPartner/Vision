import { useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

/**
 * Shown while the desktop shell's health watchdog reports the local backend
 * as unreachable. It clears itself, and refetches every query, once the shell
 * reports the backend restored. Renders nothing outside Electron.
 */
export function BackendConnectionBanner() {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const [lost, setLost] = useState(false);

    useEffect(() => {
        const recovery = window.electronRecovery;
        if (!recovery) return;
        const stopLost = recovery.onBackendLost(() => setLost(true));
        const stopRestored = recovery.onBackendRestored(() => {
            setLost(false);
            void queryClient.invalidateQueries();
        });
        return () => {
            stopLost();
            stopRestored();
        };
    }, [queryClient]);

    if (!lost) return null;
    return (
        <Alert variant="warning" className="mb-4">
            <WifiOff className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{t("app.backendLost")}</AlertDescription>
        </Alert>
    );
}
