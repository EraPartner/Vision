import { useEffect, useRef, useSyncExternalStore } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { ShimmerLayer } from "@/components/ui/shimmer-layer";

const placeholderObservers = new Set<object>();
const placeholderListeners = new Set<() => void>();

function emitPlaceholderChange() {
    placeholderListeners.forEach((listener) => listener());
}

function subscribeToPlaceholderObservers(listener: () => void) {
    placeholderListeners.add(listener);
    return () => placeholderListeners.delete(listener);
}

/** Register the real, observer-owned placeholder state for a keepPreviousData query. */
export function useBackgroundQueryCue(active: boolean) {
    const observer = useRef<object>({});

    useEffect(() => {
        const token = observer.current;
        if (!active) {
            if (placeholderObservers.delete(token)) emitPlaceholderChange();
            return;
        }

        placeholderObservers.add(token);
        emitPlaceholderChange();
        return () => {
            if (placeholderObservers.delete(token)) emitPlaceholderChange();
        };
    }, [active]);
}

/**
 * Global cue for background refreshes that leave cached data on screen.
 * Cold initial loads keep their page-owned skeleton or loading surface.
 */
export function BackgroundQueryIndicator() {
    const cachedFetchCount = useIsFetching({
        predicate: (query) => query.state.data !== undefined,
    });
    const placeholderFetchCount = useSyncExternalStore(
        subscribeToPlaceholderObservers,
        () => placeholderObservers.size,
        () => 0,
    );

    if (cachedFetchCount === 0 && placeholderFetchCount === 0) return null;

    return (
        <div
            data-testid="background-query-indicator"
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/25"
        >
            <ShimmerLayer className="bg-[linear-gradient(90deg,transparent_0%,hsl(var(--primary))_45%,hsl(var(--accent))_65%,transparent_100%)] motion-reduce:hidden" />
        </div>
    );
}
