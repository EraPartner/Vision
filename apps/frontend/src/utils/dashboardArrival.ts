export const DASHBOARD_ARRIVAL_EVENT = "vision:dashboard-arrival";
const DASHBOARD_ARRIVAL_SESSION_KEY = "vision.dashboardArrivalSeen";

function sessionStorageOrNull(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

/** Claim the full dashboard reveal once for this browser session. */
export function claimDashboardArrival(): boolean {
    const storage = sessionStorageOrNull();
    if (!storage) return true;

    try {
        if (storage.getItem(DASHBOARD_ARRIVAL_SESSION_KEY) === "1")
            return false;
        storage.setItem(DASHBOARD_ARRIVAL_SESSION_KEY, "1");
        return true;
    } catch {
        return true;
    }
}

/**
 * Reserve the next full dashboard reveal for a meaningful completion. The
 * event handles an already-mounted dashboard behind onboarding; clearing the
 * key handles a dashboard mounted by the following navigation.
 */
export function requestDashboardArrival(): void {
    const storage = sessionStorageOrNull();
    try {
        storage?.removeItem(DASHBOARD_ARRIVAL_SESSION_KEY);
    } catch {
        // Storage can be unavailable in privacy modes; the event still works.
    }
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(DASHBOARD_ARRIVAL_EVENT));
    }
}

export function markDashboardArrivalSeen(): void {
    try {
        sessionStorageOrNull()?.setItem(DASHBOARD_ARRIVAL_SESSION_KEY, "1");
    } catch {
        // Motion gating is a progressive enhancement.
    }
}
