/** True when the event target is a text-entry surface — global single-key
 *  shortcuts must stay inert there. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** True when a Radix Dialog/AlertDialog overlay is currently open. Radix
 *  dialogs don't stop keydown propagation to `document`, so global
 *  single-key shortcuts (g-sequences, `[`/`]`, `?`) must stay inert while
 *  one is open — otherwise a route change unmounts the page-owned dialog
 *  and any in-progress edits inside it are lost. */
export function isOverlayOpen(): boolean {
    return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/** True when global single-key shortcuts must stay inert: either the event
 *  target is a text-entry surface, or a dialog overlay is open. */
export function isShortcutSafeTarget(target: EventTarget | null): boolean {
    return isTypingTarget(target) || isOverlayOpen();
}
