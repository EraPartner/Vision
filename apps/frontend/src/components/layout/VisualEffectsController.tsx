import { useEffect } from 'react';
import { useVisualEffectsTier } from '@/hooks/useVisualEffectsTier';

/**
 * Renders nothing; tags <html> with the visual-effects state (ADR-075):
 * - `fx-reduced` — effective tier is 'reduced': index.css drops all
 *   backdrop-filter glass and hides the liquid canvas (mirrors the
 *   prefers-reduced-transparency fallback).
 * - `fx-enhanced` — effective tier is 'enhanced': lets index.css opt specific
 *   surfaces into heavier frosting (e.g. the pivot table's frozen column).
 *   The 'standard' tier carries neither class — it is the CSS base.
 * - `fx-static-atmosphere` — large display but the user kept a higher tier
 *   (auto-adapt off): the aurora blobs stay visible but stop drifting, so
 *   the compositor can go idle between frames.
 */
export function VisualEffectsController() {
    const { tier, largeDisplay } = useVisualEffectsTier();

    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle('fx-reduced', tier === 'reduced');
        root.classList.toggle('fx-enhanced', tier === 'enhanced');
        root.classList.toggle('fx-static-atmosphere', largeDisplay && tier !== 'reduced');
        return () => {
            root.classList.remove('fx-reduced', 'fx-enhanced', 'fx-static-atmosphere');
        };
    }, [tier, largeDisplay]);

    return null;
}
