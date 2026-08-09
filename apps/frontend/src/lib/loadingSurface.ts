import { useLanguage } from "@/contexts/LanguageContext";

/**
 * ARIA for the ONE element that announces a loading surface.
 *
 * `Skeleton` bones are decorative (`aria-hidden`), so something has to speak for
 * them. `role="status"` carries an implicit `aria-live="polite"`, which is what
 * makes the surface audible — but it also means a grid of twelve bones must not
 * each carry it, or a screen reader hears "Loading" twelve times. Spread the
 * hook's result on the single outermost element that already wraps the whole
 * loading branch (a grid div, a Card, a CardContent) — no extra DOM node — or
 * directly on a lone `Skeleton` that is a surface by itself.
 *
 * When the wrapping element is shared with the loaded state, spread it
 * conditionally (`{...(isLoading ? loadingSurfaceProps : {})}`) so the live
 * region disappears once real content arrives. Where the loading branch sits
 * inside a `<table>` — a wrapper element there would be invalid HTML — put it on
 * the container around the `<Table>` instead.
 *
 * `aria-hidden: undefined` is load-bearing: it cancels `Skeleton`'s own
 * `aria-hidden` for the lone-skeleton case, which would otherwise hide the very
 * element doing the announcing.
 *
 * A hook, not a const, so the label comes from the active locale's dictionary
 * (`common.loading`) instead of a hardcoded English literal — localised once
 * here rather than in ~35 call sites.
 */
export function useLoadingSurfaceProps(): {
    readonly role: "status";
    readonly "aria-busy": true;
    readonly "aria-hidden": undefined;
    readonly "aria-label": string;
} {
    const { t } = useLanguage();
    return {
        role: "status",
        "aria-busy": true,
        "aria-hidden": undefined,
        "aria-label": t('common.loading'),
    } as const;
}
