// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    hasNativeShellCapability,
    NATIVE_ONBOARDING_EVENT,
    readNativeOnboardingState,
    requestNativeOverlay,
    startNativeOverlayKeyboardBridge,
    subscribeNativeOnboarding,
    type NativeShellWindow,
} from "@/lib/nativeShell";

const flagNames = ["__VISION_NATIVE_PALETTE__", "__VISION_NATIVE_SHORTCUTS__",
    "__VISION_NATIVE_SHELL_NOTIFICATIONS__", "__VISION_NATIVE_ONBOARDING__"];

function property(name: string, value: unknown) {
    Object.defineProperty(window, name, { value, configurable: true });
}

const stops: Array<() => void> = [];
afterEach(() => {
    stops.forEach((stop) => stop());
    stops.length = 0;
    [...flagNames, "__visionNativeOpenOverlay", "__VISION_NATIVE_ONBOARDING_STATE__"]
        .forEach((name) => Reflect.deleteProperty(window, name));
    document.body.innerHTML = "";
});

describe("strict native shell takeover capabilities", () => {
    it("requires the matching strict boolean flag and keeps older native navigation fallbacks", () => {
        const host = { electronAPI: { nativeNavigation: true } } as unknown as NativeShellWindow;
        expect(hasNativeShellCapability("palette", host)).toBe(false);
        property("__VISION_NATIVE_PALETTE__", "true");
        expect(hasNativeShellCapability("palette")).toBe(false);
        property("__VISION_NATIVE_PALETTE__", true);
        expect(hasNativeShellCapability("palette")).toBe(true);
        expect(hasNativeShellCapability("shortcuts")).toBe(false);
        expect(hasNativeShellCapability("notifications")).toBe(false);
        expect(hasNativeShellCapability("onboarding")).toBe(false);
    });

    it("allows only an enabled known overlay kind, never arbitrary bridge arguments", async () => {
        const open = vi.fn().mockResolvedValue(undefined);
        property("__visionNativeOpenOverlay", open);
        await expect(requestNativeOverlay("palette")).rejects.toThrow("unavailable");
        property("__VISION_NATIVE_PALETTE__", true);
        await requestNativeOverlay("palette");
        await expect(requestNativeOverlay("shortcuts")).rejects.toThrow("unavailable");
        await expect(requestNativeOverlay("settings" as "palette")).rejects.toThrow("unavailable");
        expect(open).toHaveBeenCalledExactlyOnceWith("palette");
    });
});

describe("retained web native overlay keyboard bridge", () => {
    function install() {
        property("__VISION_NATIVE_PALETTE__", true);
        property("__VISION_NATIVE_SHORTCUTS__", true);
        const open = vi.fn().mockResolvedValue(undefined);
        property("__visionNativeOpenOverlay", open);
        const failure = vi.fn();
        const stop = startNativeOverlayKeyboardBridge(window, failure);
        stops.push(stop);
        return { open, failure, stop };
    }

    it("preserves explicit Cmd/Ctrl K inside text fields and the original lowercase key guard", () => {
        const { open } = install();
        const input = document.createElement("input");
        document.body.append(input);
        const key = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
        input.dispatchEvent(key);
        expect(key.defaultPrevented).toBe(true);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "K", metaKey: true, shiftKey: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
        expect(open.mock.calls).toEqual([["palette"], ["palette"]]);
    });

    it("keeps question-mark help inert in inputs, selects, textareas, editable content and dialogs", () => {
        const { open } = install();
        for (const tag of ["input", "select", "textarea", "div"]) {
            const element = document.createElement(tag);
            if (tag === "div") Object.defineProperty(element, "isContentEditable", { value: true });
            document.body.append(element);
            element.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
            element.remove();
        }
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("data-state", "open");
        document.body.append(dialog);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
        dialog.remove();
        for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", [modifier]: true }));
        }
        expect(open).not.toHaveBeenCalled();
        const key = new KeyboardEvent("keydown", { key: "?", shiftKey: true, cancelable: true });
        document.dispatchEvent(key);
        expect(key.defaultPrevented).toBe(true);
        expect(open).toHaveBeenCalledExactlyOnceWith("shortcuts");
    });

    it("detaches on unmount and handles a rejected host request without leaving web open state", async () => {
        const { open, failure, stop } = install();
        open.mockRejectedValueOnce(Error("closed session"));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
        await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
        stop();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
        expect(open).toHaveBeenCalledOnce();
    });

    it("does not install handlers on ordinary web and does not swallow keys without a host function", () => {
        const open = vi.fn();
        property("__visionNativeOpenOverlay", open);
        stops.push(startNativeOverlayKeyboardBridge());
        const webKey = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
        document.dispatchEvent(webKey);
        expect(webKey.defaultPrevented).toBe(false);
        expect(open).not.toHaveBeenCalled();
        Reflect.deleteProperty(window, "__visionNativeOpenOverlay");
        property("__VISION_NATIVE_PALETTE__", true);
        stops.push(startNativeOverlayKeyboardBridge());
        const nativeKey = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
        document.dispatchEvent(nativeKey);
        expect(nativeKey.defaultPrevented).toBe(false);
    });
});

describe("native onboarding mirror", () => {
    it("starts unknown, validates strict status, and removes event listeners", () => {
        expect(readNativeOnboardingState()).toEqual({ complete: null, presented: false });
        property("__VISION_NATIVE_ONBOARDING_STATE__", { complete: "true", presented: false });
        expect(readNativeOnboardingState()).toEqual({ complete: null, presented: false });
        property("__VISION_NATIVE_ONBOARDING_STATE__", { complete: false, presented: true });
        const receive = vi.fn();
        const stop = subscribeNativeOnboarding(receive);
        stops.push(stop);
        expect(receive).toHaveBeenLastCalledWith({ complete: false, presented: true });
        window.dispatchEvent(new CustomEvent(NATIVE_ONBOARDING_EVENT, { detail: { complete: "true", presented: false } }));
        expect(receive).toHaveBeenCalledOnce();
        window.dispatchEvent(new CustomEvent(NATIVE_ONBOARDING_EVENT, { detail: { complete: true, presented: false } }));
        expect(receive).toHaveBeenLastCalledWith({ complete: true, presented: false });
        stop();
        window.dispatchEvent(new CustomEvent(NATIVE_ONBOARDING_EVENT, { detail: { complete: null, presented: false } }));
        expect(receive).toHaveBeenCalledTimes(2);
    });
});
