import { useEffect, useState } from 'react';
import { useAppSettings } from '@/stores/hydration/AppSettingsHydration';
import { currentDisplayIsLarge, resolveEffectiveTier } from '@/lib/visualEffects';
import { useSettingsStore } from '@/stores/settingsStore';
import type { VisualEffectsTier } from '@/stores/settingsStore';

// No DOM event fires reliably when a window is dragged between displays
// (resize covers most moves; same-DPR moves between different-resolution
// screens fire nothing), so a cheap poll — four property reads — backstops it.
const DISPLAY_POLL_MS = 5000;

export function useLargeDisplay(): boolean {
    const [large, setLarge] = useState(currentDisplayIsLarge);

    useEffect(() => {
        const check = () => setLarge(currentDisplayIsLarge());
        window.addEventListener('resize', check);
        const interval = setInterval(check, DISPLAY_POLL_MS);
        return () => {
            window.removeEventListener('resize', check);
            clearInterval(interval);
        };
    }, []);

    return large;
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
