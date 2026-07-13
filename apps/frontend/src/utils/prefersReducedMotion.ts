/**
 * True when the user has requested reduced motion. Guarded so environments
 * without `matchMedia` (SSR, jsdom) fall through to the normal animation path.
 * Shared by the animation call sites (SIMP-09).
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
