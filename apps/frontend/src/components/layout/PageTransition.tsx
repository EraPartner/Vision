import { m, useReducedMotion } from "framer-motion";
import { useLocation } from "react-router";
import { durations, easings } from "@/lib/motion";

interface PageTransitionProps {
    children: React.ReactNode;
}

/**
 * Animates route content in on navigation. Enter-only by design: exit
 * animations require AnimatePresence around lazy routes, which double-renders
 * Suspense boundaries. Keyed on pathname so each navigation remounts and
 * replays the entrance — the same remount boundary RoutedErrorBoundary
 * already establishes.
 *
 * Uses the tree-shaken `m` API, not `motion` — this component is in the
 * always-loaded shell, and `motion` would drag the whole animation engine into
 * the boot chunk. The <LazyMotion> provider at the root of App.tsx supplies the
 * features; rendered output and timing are identical either way.
 */
export function PageTransition({ children }: PageTransitionProps) {
    const { pathname } = useLocation();
    const reducedMotion = useReducedMotion();

    if (reducedMotion) {
        return <>{children}</>;
    }

    return (
        <m.div
            key={pathname}
            initial={{ opacity: 0, y: 14, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: durations.page, ease: easings.outExpo }}
            // A permanent layer: without it Chromium promotes the page for
            // the entrance and demotes it when the animation ends, rastering
            // the whole page twice per navigation. Opacity, not transform: a
            // transform hint would become the containing block of the
            // position:fixed chart tooltips. will-change alone does not make
            // the wrapper a backdrop root, so the glass blur is unchanged.
            style={{ willChange: "opacity" }}
        >
            {children}
        </m.div>
    );
}
