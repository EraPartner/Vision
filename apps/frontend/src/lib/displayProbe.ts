import { currentDisplayIsLarge } from '@/lib/visualEffects';
import { canCheckBuiltInDisplay, getDisplayIsBuiltIn } from '@/lib/api/electron';

// No DOM event fires reliably when a window is dragged between displays
// (resize covers most moves; same-DPR moves between different-resolution
// screens fire nothing), so a cheap poll (four property reads, plus one IPC
// call in the desktop app) backstops it. One shared probe serves every
// caller (ADR-256): it ticks every 5 s while the window has focus, every 30 s
// while it is visible but not frontmost, and not at all while hidden. Focus,
// visibility and resize changes re-check at once.
export const DISPLAY_POLL_FOCUSED_MS = 5000;
export const DISPLAY_POLL_BLURRED_MS = 30_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let builtIn: boolean | null = null;
let pixelsLarge = false;
let snapshot = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function publish(): void {
    const next = builtIn === true ? false : pixelsLarge;
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
}

function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (listeners.size === 0 || document.hidden) return;
    const delay = document.hasFocus() ? DISPLAY_POLL_FOCUSED_MS : DISPLAY_POLL_BLURRED_MS;
    timer = setTimeout(check, delay);
}

function check(): void {
    if (document.hidden) {
        schedule();
        return;
    }
    pixelsLarge = currentDisplayIsLarge();
    publish();
    schedule();
    if (!canCheckBuiltInDisplay()) return;
    const current = generation;
    void getDisplayIsBuiltIn().then((value) => {
        if (current !== generation) return;
        builtIn = value;
        publish();
    });
}

function start(): void {
    generation += 1;
    // In the desktop app, main answers whether the window is on a built-in
    // panel, which is never large (lib/visualEffects.ts). Until the first
    // answer arrives, assume built-in so the Mac's own screen never flashes
    // the reduced tier at launch; an external 4K output drops to reduced one
    // IPC round trip later. Outside Electron the pixel heuristic alone applies.
    builtIn = canCheckBuiltInDisplay() ? true : null;
    pixelsLarge = currentDisplayIsLarge();
    snapshot = builtIn === true ? false : pixelsLarge;
    window.addEventListener('resize', check);
    window.addEventListener('focus', check);
    window.addEventListener('blur', schedule);
    document.addEventListener('visibilitychange', check);
    check();
}

function stop(): void {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    window.removeEventListener('resize', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('blur', schedule);
    document.removeEventListener('visibilitychange', check);
}

export function subscribeDisplayProbe(listener: Listener): () => void {
    listeners.add(listener);
    if (listeners.size === 1) start();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
    };
}

/** Whether the window's display counts as large. Before the first subscriber
 *  this mirrors what `start` would compute, so the first render matches. */
export function getDisplayIsLargeSnapshot(): boolean {
    if (listeners.size > 0) return snapshot;
    return canCheckBuiltInDisplay() ? false : currentDisplayIsLarge();
}
