import { useCallback } from "react";

interface PointerSnapshot {
    x: number;
    y: number;
    at: number;
}

let lastPointerDown: PointerSnapshot | undefined;

if (typeof window !== "undefined") {
    window.addEventListener(
        "pointerdown",
        (event) => {
            lastPointerDown = {
                x: event.clientX,
                y: event.clientY,
                at: performance.now(),
            };
        },
        { capture: true, passive: true },
    );
}

/** Pointerdowns older than this are not the click that opened the dialog. */
const RECENCY_MS = 1500;

/**
 * Return a dialog-content ref that records a recent pointer as the genie-exit
 * transform origin. Keyboard-opened dialogs keep the neutral CSS fallback.
 */
export function useGenieOrigin() {
    return useCallback((node: HTMLElement | null) => {
        if (!node) return;
        const snapshot = lastPointerDown;
        if (!snapshot || performance.now() - snapshot.at > RECENCY_MS) return;

        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        node.style.setProperty(
            "--genie-origin",
            `${snapshot.x - rect.left}px ${snapshot.y - rect.top}px`,
        );
        node.style.setProperty("--genie-scale", "0.5");
        node.style.setProperty("--genie-y", "0px");
    }, []);
}
