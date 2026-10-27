import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppSettings } from '@/stores/hydration/AppSettingsHydration';
import { resolveEffectiveTier } from '@/lib/visualEffects';
import { getDisplayIsLargeSnapshot, subscribeDisplayProbe } from '@/lib/displayProbe';
import { useSettingsStore } from '@/stores/settingsStore';
import type { FullEffectsChoice, VisualEffectsTier } from '@/stores/settingsStore';

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
 * Whether Full effects apply. `auto` follows the tier the user chose (not
 * the display-capped one), so it needs no display check: on for standard
 * only. On reduced the switch restores almost nothing (no glass, no aurora).
 */
export function resolveFullEffects(choice: FullEffectsChoice, chosenTier: VisualEffectsTier): boolean {
    if (choice === 'auto') return chosenTier === 'standard';
    return choice === 'on';
}

/**
 * The "Full effects" switch (AppSettings.fullEffects, resolved). A narrow
 * store selector, so the components that read it (cards, chart tooltips)
 * re-render only when the resolved flag flips.
 */
export function useFullEffects(): boolean {
    return useSettingsStore((s) => resolveFullEffects(s.appSettings.fullEffects, s.appSettings.visualEffects));
}

/**
 * Whether `<html data-fx-variant>` names `name`. Set only by the Mac
 * measurement script (scripts/mac-baseline.ts --variant) to try a change
 * before it ships; never set in normal use.
 */
export function useFxVariant(name: string): boolean {
    const [active, setActive] = useState(() => hasFxVariant(name));
    useEffect(() => {
        const root = document.documentElement;
        const update = () => setActive(hasFxVariant(name));
        update();
        const observer = new MutationObserver(update);
        observer.observe(root, { attributes: true, attributeFilter: ['data-fx-variant'] });
        return () => observer.disconnect();
    }, [name]);
    return active;
}

function hasFxVariant(name: string): boolean {
    return (document.documentElement.dataset.fxVariant ?? '').split(/\s+/).includes(name);
}
