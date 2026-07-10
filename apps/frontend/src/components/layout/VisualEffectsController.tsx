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
 * - `fx-idle-atmosphere` — the window is blurred or the tab hidden: the
 *   aurora drift is paused. While it runs, every backdrop-filter surface
 *   (sidebar, topbar, all glass cards) re-blurs on every vsync because the
 *   moving backdrop defeats the compositor's blur cache — GPU burned while
 *   nobody is looking. Relevant for the always-open Electron window; rAF's
 *   implicit pause only covers fully hidden tabs, not unfocused windows.
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

    useEffect(() => {
        const root = document.documentElement;
        const update = () => {
            root.classList.toggle('fx-idle-atmosphere', document.hidden || !document.hasFocus());
        };
        update();
        window.addEventListener('focus', update);
        window.addEventListener('blur', update);
        document.addEventListener('visibilitychange', update);
        return () => {
            window.removeEventListener('focus', update);
            window.removeEventListener('blur', update);
            document.removeEventListener('visibilitychange', update);
            root.classList.remove('fx-idle-atmosphere');
        };
    }, []);

    return null;
}
