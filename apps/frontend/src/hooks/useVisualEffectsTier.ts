import { useEffect, useState } from 'react';
import { useAppSettings } from '@/stores/hydration/AppSettingsHydration';
import { currentDisplayIsLarge, resolveEffectiveTier } from '@/lib/visualEffects';
import { canCheckBuiltInDisplay, getDisplayIsBuiltIn } from '@/lib/api/electron';
import { useSettingsStore } from '@/stores/settingsStore';
import type { VisualEffectsTier } from '@/stores/settingsStore';

// No DOM event fires reliably when a window is dragged between displays
// (resize covers most moves; same-DPR moves between different-resolution
// screens fire nothing), so a cheap poll (four property reads, plus one IPC
// call in the desktop app) backstops it.
const DISPLAY_POLL_MS = 5000;

export function useLargeDisplay(): boolean {
    // In the desktop app, main answers whether the window is on a built-in
    // panel, which is never large (lib/visualEffects.ts). Until the first
    // answer arrives, assume built-in so the Mac's own screen never flashes
    // the reduced tier at launch; an external 4K output drops to reduced one
    // IPC round trip later. Outside Electron the pixel heuristic alone applies.
    const [builtIn, setBuiltIn] = useState<boolean | null>(() =>
        canCheckBuiltInDisplay() ? true : null,
    );
    const [pixelsLarge, setPixelsLarge] = useState(() => currentDisplayIsLarge());

    useEffect(() => {
        let cancelled = false;
        const check = () => {
            setPixelsLarge(currentDisplayIsLarge());
            if (!canCheckBuiltInDisplay()) return;
            void getDisplayIsBuiltIn().then((value) => {
                if (!cancelled) setBuiltIn(value);
            });
        };
        check();
        window.addEventListener('resize', check);
        const interval = setInterval(check, DISPLAY_POLL_MS);
        return () => {
            cancelled = true;
            window.removeEventListener('resize', check);
            clearInterval(interval);
        };
    }, []);

    return builtIn === true ? false : pixelsLarge;
}

/** Effective visual-effects tier for the display the window is on (ADR-075). */
export function useVisualEffectsTier(): { tier: VisualEffectsTier; largeDisplay: boolean } {
    const { visualEffects, autoAdaptDisplay } = useAppSettings().appSettings;
    const sessionTierOverride = useSettingsStore((s) => s.sessionTierOverride);
    const largeDisplay = useLargeDisplay();
    return {
        tier: resolveEffectiveTier(visualEffects, autoAdaptDisplay, largeDisplay, sessionTierOverride),
        largeDisplay,
    };
}

/**
 * The "Full effects" switch (AppSettings.fullEffects). A narrow store
 * selector, so the components that read it (cards, chart tooltips) re-render
 * only when this one flag flips.
 */
export function useFullEffects(): boolean {
    return useSettingsStore((s) => s.appSettings.fullEffects);
}
