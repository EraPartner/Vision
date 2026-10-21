import type { VisualEffectsTier } from '@/stores/settingsStore';

/**
 * Display-size heuristic for the auto-adapt visual-effects cap (ADR-075).
 *
 * Backdrop-filter glass and the always-animating aurora scale with the
 * display's *physical* pixel count, and a base M-series GPU that sits at
 * ~70% on the built-in panel (~4.3M px) has no headroom left for a 4K TV
 * (~8.3M px). The threshold deliberately sits between those two.
 */
export const LARGE_DISPLAY_PHYSICAL_PX = 6_000_000;

export function isLargeDisplay(
    screenWidth: number,
    screenHeight: number,
    dpr: number,
    builtIn: boolean | null = null,
): boolean {
    // A built-in panel is never "large": the cap exists for external 4K/5K
    // outputs. A MacBook Air in a "More Space" scaled mode (1680x1050 @2x =
    // 7.06 MP backing store on a 4.1 MP panel) would otherwise trip it. The
    // panel ships matched to its own GPU, so pixel count alone is the wrong
    // signal there. builtIn is null outside the desktop app (no display
    // API), where the pixel heuristic applies as before.
    if (builtIn === true) return false;
    return screenWidth * screenHeight * dpr * dpr > LARGE_DISPLAY_PHYSICAL_PX;
}

/** Whether the display the window currently sits on is large. */
export function currentDisplayIsLarge(builtIn: boolean | null = null): boolean {
    return isLargeDisplay(
        window.screen.width,
        window.screen.height,
        window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
        builtIn,
    );
}

/**
 * The tier actually applied: the user's chosen tier, capped at 'reduced'
 * while auto-adapt is on and the window sits on a large display. Turning
 * auto-adapt off is the persistent "don't touch my effects" override.
 *
 * `sessionOverride` is the in-memory, this-device-only escape hatch: it
 * replaces the cap (not the preference), so it only has effect while the
 * cap would apply — back on a small display the synced preference governs,
 * and a restart returns the large display to auto mode.
 */
export function resolveEffectiveTier(
    visualEffects: VisualEffectsTier,
    autoAdaptDisplay: boolean,
    largeDisplay: boolean,
    sessionOverride?: VisualEffectsTier,
): VisualEffectsTier {
    if (autoAdaptDisplay && largeDisplay) return sessionOverride ?? 'reduced';
    return visualEffects;
}
