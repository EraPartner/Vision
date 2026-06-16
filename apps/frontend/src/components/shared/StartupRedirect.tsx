import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import type { StartupSection } from "@/stores/settingsStore";

// Each fixed startup section's main page. Budgeting is the app root, so it
// needs no redirect — landing at "/" already lands on it. 'last' is dynamic
// (the previous session's page) and resolved separately.
const SECTION_HOME: Record<Exclude<StartupSection, "last">, string> = {
    budgeting: "/",
    portfolio: "/portfolio",
    research: "/research",
    "ai-chat": "/ai-chat",
};

// Persists across sessions (unlike the per-session workspace key), so the
// "last opened page" startup option can restore it on the next launch.
const LAST_PAGE_KEY = "vision_last_page";

function readLastPage(): string | undefined {
    try {
        const v = localStorage.getItem(LAST_PAGE_KEY);
        // Only accept in-app absolute paths; ignore anything else.
        return v && v.startsWith("/") ? v : undefined;
    } catch {
        // localStorage unavailable (private mode, SSR) — restore disabled.
        return undefined;
    }
}

/**
 * On launch, redirect the initial "/" landing to the page configured in
 * settings — either a fixed section's main page or, for 'last', the page open
 * when the app was last closed. Fires once, and only when the app opened at the
 * root — deep links (and later in-app navigation back to "/") are untouched.
 *
 * It also records the current page on every navigation so the 'last' option has
 * something to restore.
 */
export function StartupRedirect() {
    const navigate = useNavigate();
    const location = useLocation();
    const { appSettings, isLoading } = useAppSettings();
    const didRedirect = useRef(false);
    // Captured during render, before the tracking effect below overwrites the
    // stored value with this session's "/" landing.
    const lastPageAtLaunch = useRef<string | undefined>(readLastPage());

    // One-time launch redirect.
    useEffect(() => {
        if (didRedirect.current) return;
        // Wait for the persisted settings to hydrate before deciding.
        if (isLoading) return;
        didRedirect.current = true;

        // Only the fresh launch at the root is redirected.
        if (location.pathname !== "/") return;

        const section = appSettings.startupSection;
        const target =
            section === "last"
                ? lastPageAtLaunch.current ?? "/"
                : SECTION_HOME[section] ?? "/";

        if (target && target !== "/") navigate(target, { replace: true });
    }, [isLoading, appSettings.startupSection, location.pathname, navigate]);

    // Track the current page (path + query) for the "last opened page" option.
    useEffect(() => {
        try {
            localStorage.setItem(LAST_PAGE_KEY, location.pathname + location.search);
        } catch {
            // localStorage unavailable — last-page restore disabled this session.
        }
    }, [location.pathname, location.search]);

    return null;
}
