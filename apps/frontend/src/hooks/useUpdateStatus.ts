import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import type { UpdateCheckStatus } from "@/lib/api/electron";

export const updateStatusKeys = {
    check: ["update-status"] as const,
};

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Shared "is an update available" state. Polled every five minutes while the
 * window is visible; the sidebar's Settings row shows a dot from it and the
 * About section shows the same status with the install action (ADR-180).
 */
export function useUpdateStatus() {
    return useQuery<UpdateCheckStatus>({
        queryKey: updateStatusKeys.check,
        queryFn: () => apiClient.checkForUpdates(),
        staleTime: CHECK_INTERVAL_MS,
        refetchInterval: (query) =>
            typeof document !== "undefined" && document.hidden
                ? false
                : query.state.status === "error"
                  ? false
                  : CHECK_INTERVAL_MS,
        refetchOnWindowFocus: true,
        retry: false,
    });
}
