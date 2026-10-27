import {
    skipToken,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import type { MonitorCreate, MonitorUpdate } from "@/lib/api/monitors";

const key = ["analysis-monitors"] as const;

export function useMonitors(offset = 0) {
    return useQuery({
        queryKey: [...key, "list", offset],
        queryFn: () => apiClient.listMonitors(offset),
        refetchInterval: 60_000,
    });
}

export function useMonitorObservations(id: string | null, offset = 0) {
    return useQuery({
        queryKey: [...key, "observations", id, offset],
        queryFn: id ? () => apiClient.listMonitorObservations(id, offset) : skipToken,
        enabled: Boolean(id),
    });
}

/** The monitors page polls its inbox every minute. */
export function useMonitorNotifications(offset = 0) {
    return useQuery({
        queryKey: [...key, "notifications", offset],
        queryFn: () => apiClient.listMonitorNotifications(offset),
        refetchInterval: 60_000,
    });
}

/**
 * The always-mounted sidebar badge shares the page's first inbox page but
 * polls every 5 min, and catches up whenever the window regains focus
 * (ADR-256). Monitor mutations invalidate the whole key, so actions inside
 * the app still update the badge at once.
 */
export function useMonitorInboxBadge() {
    return useQuery({
        queryKey: [...key, "notifications", 0],
        queryFn: () => apiClient.listMonitorNotifications(0),
        refetchInterval: 5 * 60_000,
        refetchOnWindowFocus: true,
    });
}

export function useMonitorTargets(dossierOffset = 0) {
    const analyses = useQuery({
        queryKey: ["analysis", "saved", "monitor-picker"],
        queryFn: () => apiClient.listSavedAnalyses(),
    });
    const dossiers = useQuery({
        queryKey: ["research-dossiers", "monitor-picker", dossierOffset],
        queryFn: () => apiClient.listDossiers(dossierOffset),
    });
    return { analyses, dossiers };
}

export function useMonitorActions() {
    const cache = useQueryClient();
    const refresh = async () => cache.invalidateQueries({ queryKey: key });
    return {
        create: useMutation({
            mutationFn: (input: MonitorCreate) =>
                apiClient.createMonitor(input),
            onSuccess: refresh,
        }),
        update: useMutation({
            mutationFn: ({ id, patch }: { id: string; patch: MonitorUpdate }) =>
                apiClient.updateMonitor(id, patch),
            onSuccess: refresh,
        }),
        remove: useMutation({
            mutationFn: apiClient.deleteMonitor,
            onSuccess: refresh,
        }),
        check: useMutation({
            mutationFn: apiClient.checkMonitor,
            onSuccess: refresh,
        }),
        read: useMutation({
            mutationFn: apiClient.readMonitorNotification,
            onSuccess: refresh,
        }),
    };
}
