/**
 * Genie dialog exit — dialogs close toward the pointer position that opened
 * them (macOS minimize feel). A module-level capture listener remembers the
 * last pointerdown; dialog content reads it once at mount and parks the
 * origin in CSS vars that the `dialog-out` keyframes + transform-origin
 * consume. Keyboard-opened dialogs (no recent pointerdown) keep the default
 * subtle scale/translate exit, and reduced-motion users never see either
 * (animations are disabled at the class level).
 */
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
        (e) => {
            lastPointerDown = { x: e.clientX, y: e.clientY, at: performance.now() };
        },
        { capture: true, passive: true },
    );
}

/** Pointerdowns older than this are not "the click that opened the dialog". */
const RECENCY_MS = 1500;

/**
 * Ref callback for dialog content. When the dialog was opened by a recent
 * pointer interaction, sets the exit transform-origin to that point
 * (element-relative; may lie outside the box) so `dialog-out` shrinks the
 * dialog toward its trigger. Without pointer data the vars stay unset and
 * the keyframe fallbacks reproduce the previous neutral exit.
 */
export function useGenieOrigin() {
    return useCallback((node: HTMLElement | null) => {
        if (!node) return;
        const snap = lastPointerDown;
        if (!snap || performance.now() - snap.at > RECENCY_MS) return;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        node.style.setProperty("--genie-origin", `${snap.x - rect.left}px ${snap.y - rect.top}px`);
        node.style.setProperty("--genie-scale", "0.5");
        node.style.setProperty("--genie-y", "0px");
    }, []);
}

/** Merge a forwarded ref with the genie ref callback. */
export function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
    return (node: T | null) => {
        refs.forEach((ref) => {
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
        });
    };
}
