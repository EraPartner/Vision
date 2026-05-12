export type ApiRequestPhase = 'start' | 'success' | 'error';

export interface ApiRequestEvent {
    id: string;
    method: string;
    endpoint: string;
    startedAt: number;
    attempt: number;
    phase: ApiRequestPhase;
    durationMs?: number;
    status?: number;
    errorCode?: string;
    errorMessage?: string;
}

type Listener = (event: ApiRequestEvent) => void;

const listeners = new Set<Listener>();

export const apiEventBus = {
    subscribe(fn: Listener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    emit(event: ApiRequestEvent): void {
        if (listeners.size === 0) return;
        for (const fn of listeners) {
            try { fn(event); } catch { /* never let a subscriber crash the bus */ }
        }
    },
};
