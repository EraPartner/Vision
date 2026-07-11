import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface SyncState {
    syncId: string;
    /** Hovered x position as epoch ms / numeric x. */
    x: number;
}

/**
 * Mutable hover store instead of React state: the provider wraps whole pages
 * (the dashboard), and hover publishes arrive at pointermove rate. Keeping the
 * hovered value in provider useState re-rendered EVERY chart under the
 * provider per move — including unsynced ones like BankBalancesWidget's
 * stacked area. With a subscriber set, publishes reach only the charts that
 * subscribed for a syncId, updates are rAF-coalesced, and same-value updates
 * bail out via the subscriber's own setState.
 */
interface ChartSyncStore {
    getSnapshot: () => SyncState | null;
    subscribe: (listener: () => void) => () => void;
    publish: (state: SyncState | null) => void;
}

const ChartSyncContext = createContext<ChartSyncStore | null>(null);

function createChartSyncStore(): ChartSyncStore {
    let hovered: SyncState | null = null;
    let pending: SyncState | null = null;
    let frame: number | null = null;
    const listeners = new Set<() => void>();

    const emit = () => {
        for (const listener of listeners) listener();
    };

    const flush = () => {
        frame = null;
        hovered = pending;
        emit();
    };

    return {
        getSnapshot: () => hovered,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        publish: (state) => {
            pending = state;
            if (state === null) {
                // Clear immediately — leaving a chart must not strand a stale
                // crosshair on its siblings for one more frame.
                if (frame !== null) {
                    cancelAnimationFrame(frame);
                    frame = null;
                }
                hovered = null;
                emit();
                return;
            }
            // Coalesce pointermove-rate publishes to one update per frame.
            if (frame === null) frame = requestAnimationFrame(flush);
        },
    };
}

/**
 * Synced crosshairs: charts that share a `syncId` under one provider mirror
 * each other's hovered x position (nearest data point per chart). Charts
 * without a provider or syncId behave exactly as before.
 */
export function ChartSyncProvider({ children }: { children: ReactNode }) {
    const store = useMemo(createChartSyncStore, []);
    return <ChartSyncContext.Provider value={store}>{children}</ChartSyncContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useChartSync(syncId: string | undefined) {
    const store = useContext(ChartSyncContext);
    const [syncedX, setSyncedX] = useState<number | null>(null);

    useEffect(() => {
        if (!store || !syncId) return;
        const update = () => {
            const s = store.getSnapshot();
            // Same-value setState bails out, so publishes for OTHER syncIds
            // (mapped to null here) never re-render this chart.
            setSyncedX(s && s.syncId === syncId ? s.x : null);
        };
        update();
        return store.subscribe(update);
    }, [store, syncId]);

    const publishHover = useCallback(
        (x: number | null) => {
            if (!store || !syncId) return;
            store.publish(x == null ? null : { syncId, x });
        },
        [store, syncId],
    );

    return { syncedX, publishHover };
}
