import {
    changeNativeSettings,
    isNativeSettings,
    isNativeSettingsKey,
    type NativeSettingsKey,
    type NativeSettingsWindow,
} from "@/lib/api/electron";
import { acknowledgeNativeSettingReceipt } from "@/lib/api/settings";
import {
    DEFAULT_DASHBOARD_SETTINGS,
    migrateAppSettings,
    useSettingsStore,
    type SettingsStore,
    type ThemeMode,
    type ThemeSchedule,
} from "@/stores/settingsStore";
import { isThemeVariant } from "@/styles/themes";

export const NATIVE_SETTINGS_EVENT = "vision:native-settings";
export const NATIVE_SETTINGS_SESSION_EVENT = "vision:native-settings-session";

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function jsonValue(value: unknown, seen = new Set<object>()): boolean {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const valid = Array.isArray(value)
        ? value.every((item) => jsonValue(item, seen))
        : Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null
          ? Object.values(value).every((item) => jsonValue(item, seen))
          : false;
    seen.delete(value);
    return valid;
}

function theme(state: SettingsStore): Record<string, unknown> {
    return {
        mode: state.themeMode,
        schedule: state.themeSchedule,
        variant: state.themeVariant,
        systemAccent: state.themeSystemAccent,
    };
}

function applyDraft(key: NativeSettingsKey, value: unknown): void {
    const store = useSettingsStore.getState();
    if (key === "app_settings") {
        store._hydrateAppSettings(migrateAppSettings(value), false);
    } else if (key === "dashboard_settings") {
        store._hydrateDashboardSettings(
            { ...DEFAULT_DASHBOARD_SETTINGS, ...object(value) },
            false,
        );
    } else {
        const fields = object(value) ?? {};
        const mode = fields.mode;
        const schedule = object(fields.schedule);
        store._hydrateTheme({
            mode:
                typeof mode === "string" &&
                ["light", "dark", "system", "schedule"].includes(mode)
                    ? (mode as ThemeMode)
                    : undefined,
            schedule:
                schedule &&
                typeof schedule.lightFrom === "string" &&
                typeof schedule.darkFrom === "string"
                    ? (schedule as unknown as ThemeSchedule)
                    : undefined,
            variant: isThemeVariant(fields.variant)
                ? fields.variant
                : undefined,
            systemAccent:
                typeof fields.systemAccent === "boolean"
                    ? fields.systemAccent
                    : undefined,
        });
        store._setThemeLoaded(true);
    }
}

/** One subscription forwards every existing store action, while host hydration never echoes. */
export function startNativeSettingsMirror(
    onDraft: (key: NativeSettingsKey, value: unknown) => void,
): { stop: () => void; drafts: Partial<Record<NativeSettingsKey, unknown>> } {
    const drafts: Partial<Record<NativeSettingsKey, unknown>> = {};
    if (!isNativeSettings()) return { stop: () => {}, drafts };
    let applying = false;
    const receiveDraft = (key: NativeSettingsKey, value: unknown) => {
        applying = true;
        try {
            drafts[key] = value;
            applyDraft(key, value);
            onDraft(key, value);
        } finally {
            applying = false;
        }
    };
    const receive = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const detail = object(event.detail);
        if (
            !detail ||
            !isNativeSettingsKey(detail.key) ||
            !jsonValue(detail.value)
        )
            return;
        if (detail.kind === "draft") receiveDraft(detail.key, detail.value);
        else if (detail.kind === "ack")
            acknowledgeNativeSettingReceipt(
                detail.key,
                detail.value,
                detail.expected,
            );
    };
    window.addEventListener(NATIVE_SETTINGS_EVENT, receive);
    const session = (value: unknown) => {
        if (value === null || value === "standard" || value === "enhanced")
            useSettingsStore
                .getState()
                .setSessionTierOverride(value ?? undefined);
    };
    const receiveSession = (event: Event) => {
        if (event instanceof CustomEvent)
            session(object(event.detail)?.sessionTierOverride);
    };
    window.addEventListener(NATIVE_SETTINGS_SESSION_EVENT, receiveSession);
    session(
        (window as NativeSettingsWindow).__VISION_NATIVE_SETTINGS_SESSION_TIER__
            ?.value,
    );

    const forward = (
        key: NativeSettingsKey,
        before: Record<string, unknown>,
        after: Record<string, unknown>,
    ) => {
        const updates: Record<string, unknown> = {};
        const removed: string[] = [];
        try {
            for (const name of new Set([
                ...Object.keys(before),
                ...Object.keys(after),
            ])) {
                if (key === "theme_settings" && name === "schedule") {
                    const oldSchedule = object(before[name]) ?? {};
                    const nextSchedule = object(after[name]) ?? {};
                    const changed: Record<string, unknown> = {};
                    for (const field of ["lightFrom", "darkFrom"]) {
                        if (
                            oldSchedule[field] !== nextSchedule[field] &&
                            typeof nextSchedule[field] === "string"
                        )
                            changed[field] = nextSchedule[field];
                    }
                    if (Object.keys(changed).length) updates[name] = changed;
                    continue;
                }
                if (
                    JSON.stringify(before[name]) === JSON.stringify(after[name])
                )
                    continue;
                if (after[name] === undefined) removed.push(name);
                else updates[name] = after[name];
            }
        } catch {
            if (key !== "theme_settings")
                useSettingsStore.getState()._markSettingsSaveError();
            return;
        }
        if (!Object.keys(updates).length && !removed.length) return;
        if (!jsonValue(updates)) {
            if (key !== "theme_settings")
                useSettingsStore.getState()._markSettingsSaveError();
            return;
        }
        void changeNativeSettings(key, updates, removed).catch(() => {
            if (key !== "theme_settings")
                useSettingsStore.getState()._markSettingsSaveError();
        });
    };
    const unsubscribe = useSettingsStore.subscribe((state, previous) => {
        if (applying) return;
        // The first API hydration supplies display defaults; it is not a user edit.
        if (
            !previous.isAppSettingsLoading &&
            !state.isAppSettingsLoading &&
            state.appSettings !== previous.appSettings
        )
            forward(
                "app_settings",
                { ...previous.appSettings },
                { ...state.appSettings },
            );
        if (
            !previous.isDashboardSettingsLoading &&
            !state.isDashboardSettingsLoading &&
            state.dashboardSettings !== previous.dashboardSettings
        )
            forward(
                "dashboard_settings",
                { ...previous.dashboardSettings },
                { ...state.dashboardSettings },
            );
        if (previous.isThemeLoaded && state.isThemeLoaded)
            forward("theme_settings", theme(previous), theme(state));
    });
    const snapshot = object(
        (window as NativeSettingsWindow).__VISION_NATIVE_SETTINGS_SNAPSHOT__,
    );
    for (const [key, value] of Object.entries(snapshot ?? {})) {
        if (isNativeSettingsKey(key) && jsonValue(value))
            receiveDraft(key, value);
    }
    return {
        drafts,
        stop: () => {
            unsubscribe();
            window.removeEventListener(NATIVE_SETTINGS_EVENT, receive);
            window.removeEventListener(
                NATIVE_SETTINGS_SESSION_EVENT,
                receiveSession,
            );
        },
    };
}
