export type AuroraDrawMode = 'loop' | 'static' | 'stopped';

/**
 * What the aurora canvas should be doing, given the current motion state.
 * Pure — ShaderAurora wires DOM/GL events into it (unit-tested directly,
 * since the canvas itself cannot run in jsdom).
 *
 * - `stopped` on a lost context: nothing is drawable; the CSS blobs
 *   underneath are the fallback and must be left to animate.
 * - `static` under prefers-reduced-motion or fx-static-atmosphere
 *   (ADR-075): the aurora stays visible as a single held frame. Static
 *   outranks the idle pause — a held frame costs nothing while blurred and
 *   is already correct when the window is shown again.
 * - `stopped` while the window is blurred / the tab hidden: the last
 *   rendered frame stays on screen (mirrors fx-idle-atmosphere).
 * - `loop` otherwise: animate at the capped frame rate.
 */
export function resolveAuroraMode(state: {
    contextLost: boolean;
    reducedMotion: boolean;
    staticAtmosphere: boolean;
    hidden: boolean;
    focused: boolean;
}): AuroraDrawMode {
    if (state.contextLost) return 'stopped';
    if (state.reducedMotion || state.staticAtmosphere) return 'static';
    if (state.hidden || !state.focused) return 'stopped';
    return 'loop';
}
