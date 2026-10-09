import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

export function ScrollToTop() {
    const { pathname } = useLocation();
    const navigationType = useNavigationType();

    const previousPathname = useRef(pathname);

    useEffect(() => {
        const changedPage = previousPathname.current !== pathname;
        previousPathname.current = pathname;
        // Search parameters belong to the current view. PUSH/REPLACE changes
        // from chart controls must not reset the reader’s position.
        if (!changedPage) return;
        // Skip on POP (back/forward): the window is the real scroller, so forcing
        // it to the top here would override the browser's native scroll
        // restoration and land the user at the top instead of where they left off.
        if (navigationType === "POP") return;
        window.scrollTo({ top: 0, behavior: "instant" });
    }, [pathname, navigationType]);

    return null;
}
