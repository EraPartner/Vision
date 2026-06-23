import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface SyncState {
    syncId: string;
    /** Hovered x position as epoch ms / numeric x. */
    x: number;
}

interface ChartSyncContextValue {
    hovered: SyncState | null;
    publish: (state: SyncState | null) => void;
}

const ChartSyncContext = createContext<ChartSyncContextValue>({
    hovered: null,
    publish: () => undefined,
});

/**
 * Synced crosshairs: charts that share a `syncId` under one provider mirror
 * each other's hovered x position (nearest data point per chart). Charts
 * without a provider or syncId behave exactly as before.
 */
export function ChartSyncProvider({ children }: { children: ReactNode }) {
    const [hovered, setHovered] = useState<SyncState | null>(null);
    const publish = useCallback((state: SyncState | null) => setHovered(state), []);
    const value = useMemo(() => ({ hovered, publish }), [hovered, publish]);
    return <ChartSyncContext.Provider value={value}>{children}</ChartSyncContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useChartSync(syncId: string | undefined) {
    const { hovered, publish } = useContext(ChartSyncContext);

    const publishHover = useCallback(
        (x: number | null) => {
            if (!syncId) return;
            publish(x == null ? null : { syncId, x });
        },
        [publish, syncId],
    );

    const syncedX = syncId && hovered && hovered.syncId === syncId ? hovered.x : null;
    return { syncedX, publishHover };
}
