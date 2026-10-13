import {
    SettingRecordSchema,
    SettingsWithBaselinesSchema,
} from "@vision/types/contracts";
import { apiRequest } from "@/lib/api/client";

interface SettingBaseline {
    exists: boolean;
    value?: unknown;
}
interface SettingResult {
    key: string;
    value: unknown;
    expected: SettingBaseline;
}
// A tab keeps the state it read. Background reads must not bless a stale local
// edit with a newer baseline. Reload the application after a conflict.
const baselines = new Map<string, SettingBaseline>();
const saves = new Map<string, Promise<unknown>>();
let allSettingsRead = false;

function orderedJSON(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(orderedJSON);
    if (value !== null && typeof value === "object") {
        const fields = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(fields)
                .sort()
                .map((key) => [key, orderedJSON(fields[key])]),
        );
    }
    return value;
}

/** Only the native writer's acknowledged receipt can advance these owned lanes. */
export function acknowledgeNativeSettingReceipt(
    key: string,
    value: unknown,
    expected: unknown,
): boolean {
    if (
        typeof window === "undefined" ||
        (window as Window & { __VISION_NATIVE_SETTINGS__?: boolean })
            .__VISION_NATIVE_SETTINGS__ !== true ||
        !["app_settings", "dashboard_settings", "theme_settings"].includes(
            key,
        ) ||
        !expected ||
        typeof expected !== "object" ||
        !("exists" in expected) ||
        expected.exists !== true ||
        !("value" in expected)
    )
        return false;
    try {
        const encoded = JSON.stringify(value);
        const baseline = JSON.stringify(expected.value);
        if (
            encoded === undefined ||
            baseline === undefined ||
            JSON.stringify(orderedJSON(JSON.parse(baseline))) !==
                JSON.stringify(orderedJSON(JSON.parse(encoded)))
        )
            return false;
    } catch {
        return false;
    }
    // Do not clear a failed queue or seed unrelated/absent keys from a draft.
    baselines.set(key, { exists: true, value });
    return true;
}

export async function getSettings(): Promise<Record<string, unknown>> {
    const { settings: values, expected } = await apiRequest<{
        settings: Record<string, unknown>;
        expected: Record<string, SettingBaseline>;
    }>("/api/settings?withBaselines=true", {
        schema: SettingsWithBaselinesSchema,
    });
    if (!allSettingsRead) {
        for (const [key, baseline] of Object.entries(expected)) {
            if (!baselines.has(key)) baselines.set(key, baseline);
        }
        allSettingsRead = true;
    }
    return values;
}

export async function getSetting(key: string): Promise<SettingResult> {
    const result = await apiRequest<SettingResult>(
        `/api/settings/${encodeURIComponent(key)}`,
        { schema: SettingRecordSchema },
    );
    if (!baselines.has(key)) baselines.set(key, result.expected);
    return result;
}

export function saveSetting(
    key: string,
    value: unknown,
): Promise<SettingResult> {
    // Serialize this tab's saves. Advance only on acknowledgment; never fetch a
    // baseline at save time or retry a conflict with a silently fresh baseline.
    const previous = saves.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
        const expected =
            baselines.get(key) ??
            (allSettingsRead ? { exists: false } : undefined);
        if (!expected)
            throw new Error("Settings were not loaded. Reload before saving.");
        const result = await apiRequest<SettingResult>(
            `/api/settings/${encodeURIComponent(key)}`,
            {
                method: "PUT",
                body: JSON.stringify({ value, expected }),
                schema: SettingRecordSchema,
            },
            0,
        );
        baselines.set(key, { exists: true, value: result.value });
        return result;
    });
    // Keep a rejected queue rejected until reload. Later edits cannot overwrite
    // an unacknowledged or conflicting save.
    saves.set(key, next);
    return next;
}
