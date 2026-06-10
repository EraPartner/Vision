import { motion, useReducedMotion } from "framer-motion";
import { useLocation } from "react-router-dom";
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
 */
export function PageTransition({ children }: PageTransitionProps) {
    const { pathname } = useLocation();
    const reducedMotion = useReducedMotion();

    if (reducedMotion) {
        return <>{children}</>;
    }

    return (
        <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 14, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: durations.page, ease: easings.outExpo }}
        >
            {children}
        </motion.div>
    );
}
