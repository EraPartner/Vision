import { useSyncExternalStore } from 'react';
import { useAppSettings } from '@/stores/hydration/AppSettingsHydration';
import { resolveEffectiveTier } from '@/lib/visualEffects';
import { getDisplayIsLargeSnapshot, subscribeDisplayProbe } from '@/lib/displayProbe';
import { useSettingsStore } from '@/stores/settingsStore';
import type { VisualEffectsTier } from '@/stores/settingsStore';

/** Whether the window's display counts as large; one shared probe for all
 *  callers (lib/displayProbe.ts). */
export function useLargeDisplay(): boolean {
    return useSyncExternalStore(subscribeDisplayProbe, getDisplayIsLargeSnapshot);
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
