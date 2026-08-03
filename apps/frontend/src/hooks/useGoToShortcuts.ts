import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router";
import { isShortcutSafeTarget } from "@/lib/keyboard";
import { GO_TO_ROUTES, SECTION_CYCLE } from "@/lib/navigation";

// Budgeting owns the root and every route that isn't portfolio/research
// (admin included — it has no section root of its own).
function currentSectionIndex(pathname: string): number {
    if (pathname.startsWith("/portfolio")) return 1;
    if (pathname.startsWith("/research")) return 2;
    return 0;
}

const SEQUENCE_WINDOW_MS = 900;

export function useGoToShortcuts(): void {
    const navigate = useNavigate();

    useEffect(() => {
        let armed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const disarm = () => {
            armed = false;
            if (timer) clearTimeout(timer);
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isShortcutSafeTarget(e.target)) {
                disarm();
                return;
            }
            if (!armed) {
                if (e.key.toLowerCase() === "g") {
                    armed = true;
                    timer = setTimeout(disarm, SEQUENCE_WINDOW_MS);
                }
                return;
            }
            const target = GO_TO_ROUTES.find((r) => r.key === e.key.toLowerCase());
            disarm();
            if (target) {
                e.preventDefault();
                navigate(target.url);
            }
        };

        document.addEventListener("keydown", onKeyDown);
        return () => {
            disarm();
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [navigate]);
}

/** `[` / `]` step backward / forward through the three workspace sections,
 *  landing on each section's root. Inert while typing or with modifiers held
 *  (so bracketed text input and AltGr-composed brackets are never hijacked). */
export function useSectionCycleShortcuts(): void {
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isShortcutSafeTarget(e.target)) return;
            if (e.key !== "[" && e.key !== "]") return;
            e.preventDefault();
            const current = currentSectionIndex(location.pathname);
            const delta = e.key === "]" ? 1 : -1;
            const next = (current + delta + SECTION_CYCLE.length) % SECTION_CYCLE.length;
            navigate(SECTION_CYCLE[next].url);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [navigate, location.pathname]);
}
