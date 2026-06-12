import { useEffect } from 'react';
import { useVisualEffectsTier } from '@/hooks/useVisualEffectsTier';

/**
 * Renders nothing; tags <html> with the visual-effects state (ADR-075):
 * - `fx-reduced` — effective tier is 'reduced': index.css drops all
 *   backdrop-filter glass and hides the liquid canvas (mirrors the
 *   prefers-reduced-transparency fallback).
 * - `fx-static-atmosphere` — large display but the user kept a higher tier
 *   (auto-adapt off): the aurora blobs stay visible but stop drifting, so
 *   the compositor can go idle between frames.
 */
export function VisualEffectsController() {
    const { tier, largeDisplay } = useVisualEffectsTier();

    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle('fx-reduced', tier === 'reduced');
        root.classList.toggle('fx-static-atmosphere', largeDisplay && tier !== 'reduced');
        return () => {
            root.classList.remove('fx-reduced', 'fx-static-atmosphere');
        };
    }, [tier, largeDisplay]);

    return null;
}
