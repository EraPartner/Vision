import { useSyncExternalStore } from 'react';
import { apiEventBus, type ApiRequestEvent } from './apiEventBus';

const RING_BUFFER_CAP = 200;

// In-progress requests keyed by correlation id, waiting for success/error
const inFlight = new Map<string, ApiRequestEvent>();

// Completed request log (ring buffer)
let log: ApiRequestEvent[] = [];
const logListeners = new Set<() => void>();

function notify(): void {
    // Publish the new snapshot before waking React, so the last event of a
    // burst is visible too. A stale snapshot here kept a finished request
    // "in flight" (and the inspector icon pulsing) until the next re-render.
    cachedSnapshot = getSnapshot();
    for (const fn of logListeners) fn();
}

function handleEvent(event: ApiRequestEvent): void {
    if (event.phase === 'start') {
        inFlight.set(event.id, event);
        notify();
        return;
    }

    inFlight.delete(event.id);
    log = [event, ...log].slice(0, RING_BUFFER_CAP);
    notify();
}

// Subscribe to the bus once at module level (dev-only code path)
apiEventBus.subscribe(handleEvent);

function getSnapshot(): { log: ApiRequestEvent[]; inFlight: ApiRequestEvent[] } {
    return { log, inFlight: Array.from(inFlight.values()) };
}

// Stable snapshot reference — only replaced when log/inFlight change
let cachedSnapshot = getSnapshot();

export function useApiRequestLog() {
    return useSyncExternalStore(
        (cb) => {
            logListeners.add(cb);
            return () => logListeners.delete(cb);
        },
        () => cachedSnapshot,
    );
}

export function clearApiRequestLog(): void {
    log = [];
    inFlight.clear();
    notify();
}
