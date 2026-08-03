import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
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

// Canonical last-route key (lib/localStorage-keys). Persists across launches so
// the "last opened page" startup option can restore it on the next launch.
function readLastPage(): string | undefined {
    try {
        const v = localStorage.getItem(LOCAL_STORAGE_KEYS.LAST_ROUTE);
        // Only accept in-app absolute paths; ignore anything else.
        return v && v.startsWith("/") ? v : undefined;
    } catch {
        // localStorage unavailable (private mode, SSR) — restore disabled.
        return undefined;
    }
}

const STARTUP_SECTIONS: readonly StartupSection[] = [
    "budgeting",
    "portfolio",
    "research",
    "ai-chat",
    "last",
];

// Startup section mirrored from the server-persisted setting on a prior session.
// Available synchronously at launch, so we can redirect before the settings API
// round trip resolves instead of rendering + fetching the default Dashboard and
// then discarding it.
function readMirroredSection(): StartupSection | undefined {
    try {
        const v = localStorage.getItem(LOCAL_STORAGE_KEYS.STARTUP_SECTION);
        return v != null && (STARTUP_SECTIONS as readonly string[]).includes(v)
            ? (v as StartupSection)
            : undefined;
    } catch {
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
    // Captured synchronously at launch so we can redirect without waiting on the
    // settings round trip when a mirror from a prior session exists.
    const mirroredSectionAtLaunch = useRef<StartupSection | undefined>(readMirroredSection());

    // One-time launch redirect.
    useEffect(() => {
        if (didRedirect.current) return;

        // Prefer the localStorage mirror (available synchronously); only wait for
        // the settings round trip on a first-ever launch that has no mirror yet.
        const mirrored = mirroredSectionAtLaunch.current;
        if (mirrored === undefined && isLoading) return;
        didRedirect.current = true;

        // Only the fresh launch at the root is redirected.
        if (location.pathname !== "/") return;

        const section = mirrored ?? appSettings.startupSection;
        const target =
            section === "last"
                ? lastPageAtLaunch.current ?? "/"
                : SECTION_HOME[section] ?? "/";

        if (target && target !== "/") navigate(target, { replace: true });
    }, [isLoading, appSettings.startupSection, location.pathname, navigate]);

    // Mirror the (hydrated) startup section to localStorage for the next launch.
    useEffect(() => {
        if (isLoading) return; // don't persist the pre-hydration default
        try {
            localStorage.setItem(LOCAL_STORAGE_KEYS.STARTUP_SECTION, appSettings.startupSection);
        } catch {
            // localStorage unavailable — synchronous redirect falls back to settings.
        }
    }, [isLoading, appSettings.startupSection]);

    // Track the current page (path + query) for the "last opened page" option.
    useEffect(() => {
        try {
            localStorage.setItem(LOCAL_STORAGE_KEYS.LAST_ROUTE, location.pathname + location.search);
        } catch {
            // localStorage unavailable — last-page restore disabled this session.
        }
    }, [location.pathname, location.search]);

    return null;
}
