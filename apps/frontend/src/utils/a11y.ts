import type { KeyboardEvent } from "react";

/**
 * Returns an `onKeyDown` handler that invokes `handler` on Enter or Space.
 *
 * Use it to give keyboard users a path to actions otherwise bound only to
 * `onClick`/`onDoubleClick`. On a non-interactive element pair it with
 * `role="button"` + `tabIndex={0}`; on a native `<button>` it just adds an
 * activation path without changing the mouse (e.g. double-click) behaviour.
 *
 * Ignores key events that bubbled up from a nested focusable child so it
 * doesn't fire when the user is operating an inner control.
 */
export function onActivateKeyDown<E extends HTMLElement = HTMLElement>(handler: () => void) {
  return (e: KeyboardEvent<E>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}
