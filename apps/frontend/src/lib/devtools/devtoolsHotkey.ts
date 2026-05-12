import { useSyncExternalStore } from 'react';

let open = false;
const hotKeyListeners = new Set<() => void>();

function notify(): void {
    for (const fn of hotKeyListeners) fn();
}

export function toggleInspector(): void {
    open = !open;
    notify();
}

export function setInspectorOpen(value: boolean): void {
    if (open === value) return;
    open = value;
    notify();
}

export function useInspectorOpen(): boolean {
    return useSyncExternalStore(
        (cb) => {
            hotKeyListeners.add(cb);
            return () => hotKeyListeners.delete(cb);
        },
        () => open,
    );
}

export function registerInspectorHotkey(): () => void {
    function handleKeyDown(e: KeyboardEvent): void {
        // Cmd+Shift+A (Mac) or Ctrl+Shift+A (Win/Linux)
        if (e.key === 'A' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            toggleInspector();
        }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
}
