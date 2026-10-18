import { z } from "zod";
import { isShortcutSafeTarget } from "@/lib/keyboard";

export type NativeOverlayKind = "palette" | "shortcuts";
export type NativeShellCapability = NativeOverlayKind | "notifications" | "onboarding" | "reports";

export interface NativeOnboardingState {
    complete: boolean | null;
    presented: boolean;
}

export interface NativeShellWindow extends Window {
    readonly __VISION_NATIVE_PALETTE__?: boolean;
    readonly __VISION_NATIVE_SHORTCUTS__?: boolean;
    readonly __VISION_NATIVE_SHELL_NOTIFICATIONS__?: boolean;
    readonly __VISION_NATIVE_ONBOARDING__?: boolean;
    readonly __VISION_NATIVE_REPORTS__?: boolean;
    readonly __VISION_NATIVE_ONBOARDING_STATE__?: NativeOnboardingState;
    readonly __visionNativeOpenOverlay?: (kind: NativeOverlayKind) => Promise<void>;
}

const flags = {
    palette: "__VISION_NATIVE_PALETTE__",
    shortcuts: "__VISION_NATIVE_SHORTCUTS__",
    notifications: "__VISION_NATIVE_SHELL_NOTIFICATIONS__",
    onboarding: "__VISION_NATIVE_ONBOARDING__",
    reports: "__VISION_NATIVE_REPORTS__",
} as const;

export const NATIVE_ONBOARDING_EVENT = "vision:native-onboarding";
const onboardingSchema = z.object({
    complete: z.boolean().nullable(),
    presented: z.boolean(),
});

/** Each replacement has its own capability; an older native sidebar keeps the web UI. */
export function hasNativeShellCapability(
    capability: NativeShellCapability,
    target: NativeShellWindow | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
    return target?.[flags[capability]] === true;
}

export async function requestNativeOverlay(
    kind: NativeOverlayKind,
    target: NativeShellWindow = window,
): Promise<void> {
    if ((kind !== "palette" && kind !== "shortcuts") ||
        !hasNativeShellCapability(kind, target) ||
        typeof target.__visionNativeOpenOverlay !== "function") {
        throw new Error("Native overlay bridge is unavailable");
    }
    await target.__visionNativeOpenOverlay(kind);
}

/** Retained web pages keep the original palette and help shortcut guards. */
export function startNativeOverlayKeyboardBridge(
    target: NativeShellWindow = window,
    reportFailure: (error: unknown) => void = () => {},
): () => void {
    if (!hasNativeShellCapability("palette", target) &&
        !hasNativeShellCapability("shortcuts", target)) return () => {};
    const keydown = (event: KeyboardEvent) => {
        let kind: NativeOverlayKind | undefined;
        if (hasNativeShellCapability("palette", target) &&
            event.key === "k" && (event.metaKey || event.ctrlKey)) {
            kind = "palette";
        } else if (hasNativeShellCapability("shortcuts", target) &&
            event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey &&
            !isShortcutSafeTarget(event.target)) {
            kind = "shortcuts";
        }
        if (!kind || typeof target.__visionNativeOpenOverlay !== "function") return;
        event.preventDefault();
        void requestNativeOverlay(kind, target).catch(reportFailure);
    };
    target.document.addEventListener("keydown", keydown);
    return () => target.document.removeEventListener("keydown", keydown);
}

export function readNativeOnboardingState(
    target: NativeShellWindow = window,
): NativeOnboardingState {
    const parsed = onboardingSchema.safeParse(target.__VISION_NATIVE_ONBOARDING_STATE__);
    return parsed.success ? parsed.data : { complete: null, presented: false };
}

export function subscribeNativeOnboarding(
    receive: (state: NativeOnboardingState) => void,
    target: NativeShellWindow = window,
): () => void {
    const changed = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const parsed = onboardingSchema.safeParse(event.detail);
        if (parsed.success) receive(parsed.data);
    };
    target.addEventListener(NATIVE_ONBOARDING_EVENT, changed);
    receive(readNativeOnboardingState(target));
    return () => target.removeEventListener(NATIVE_ONBOARDING_EVENT, changed);
}
