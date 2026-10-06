import { useCallback, useSyncExternalStore } from "react";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { NAV_SECTIONS, type NavSectionId } from "@/lib/navigation";

/**
 * Per-browser sidebar preferences (ADR-180): whether the sidebar is shown as
 * icons only, and which sections the user has hidden. Both live in
 * localStorage so they survive a relaunch; the server-persisted settings are
 * for the data model, not window state.
 */

type HiddenSections = Partial<Record<NavSectionId, boolean>>;

const DEFAULT_HIDDEN: Readonly<HiddenSections> = Object.freeze(
    Object.fromEntries(
        NAV_SECTIONS.filter((s) => s.defaultHidden).map((s) => [s.id, true]),
    ) as HiddenSections,
);

function readHidden(): HiddenSections {
    try {
        const raw = localStorage.getItem(
            LOCAL_STORAGE_KEYS.SIDEBAR_HIDDEN_SECTIONS,
        );
        if (!raw) return { ...DEFAULT_HIDDEN };
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return { ...DEFAULT_HIDDEN };
        const out: HiddenSections = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "boolean") out[key as NavSectionId] = value;
        }
        return out;
    } catch {
        return { ...DEFAULT_HIDDEN };
    }
}

let hiddenCache: HiddenSections | undefined;
const listeners = new Set<() => void>();

function getHidden(): HiddenSections {
    if (!hiddenCache) hiddenCache = readHidden();
    return hiddenCache;
}

function setHidden(next: HiddenSections) {
    hiddenCache = next;
    try {
        localStorage.setItem(
            LOCAL_STORAGE_KEYS.SIDEBAR_HIDDEN_SECTIONS,
            JSON.stringify(next),
        );
    } catch {
        // localStorage unavailable — the choice lasts for this session only.
    }
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Test-only reset of the in-memory cache. */
export function resetSidebarPreferencesForTests(): void {
    hiddenCache = undefined;
}

export function useHiddenSections() {
    const hidden = useSyncExternalStore(subscribe, getHidden, getHidden);
    const isHidden = useCallback(
        (id: NavSectionId) => hidden[id] === true,
        [hidden],
    );
    const setSectionHidden = useCallback((id: NavSectionId, value: boolean) => {
        setHidden({ ...getHidden(), [id]: value });
    }, []);
    return { isHidden, setSectionHidden };
}

/** Whether the sidebar was icons-only when the app was last used. */
export function readSidebarCollapsed(): boolean {
    try {
        return localStorage.getItem(LOCAL_STORAGE_KEYS.SIDEBAR_COLLAPSED) === "1";
    } catch {
        return false;
    }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
    try {
        if (collapsed) {
            localStorage.setItem(LOCAL_STORAGE_KEYS.SIDEBAR_COLLAPSED, "1");
        } else {
            localStorage.removeItem(LOCAL_STORAGE_KEYS.SIDEBAR_COLLAPSED);
        }
    } catch {
        // localStorage unavailable — the choice lasts for this session only.
    }
}
