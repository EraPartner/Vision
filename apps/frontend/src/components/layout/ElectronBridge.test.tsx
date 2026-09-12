/** @vitest-environment jsdom */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ElectronBridge } from "./ElectronBridge";

const mocks = vi.hoisted(() => {
    const unsubscribe = vi.fn();
    return {
        tier: { value: "enhanced" as "reduced" | "standard" | "enhanced" },
        navigate: vi.fn(),
        toggleSidebar: vi.fn(),
        menuAction: undefined as
            | ((event: { action: string; payload?: unknown }) => void)
            | undefined,
        setNativeVibrancy: vi.fn(),
        api: {
            ready: vi.fn().mockResolvedValue({ success: true }),
            onFullScreenChange: vi.fn(() => unsubscribe),
            onMenuAction: vi.fn(
                (
                    callback: (event: {
                        action: string;
                        payload?: unknown;
                    }) => void,
                ) => {
                    mocks.menuAction = callback;
                    return unsubscribe;
                },
            ),
            onCsvOpen: vi.fn(() => unsubscribe),
        },
    };
});

vi.mock("react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/ui/sidebar", () => ({
    useSidebar: () => ({ toggleSidebar: mocks.toggleSidebar }),
}));
vi.mock("@/hooks/useVisualEffectsTier", () => ({
    useVisualEffectsTier: () => ({ tier: mocks.tier.value }),
}));
vi.mock("@/lib/api/electron", () => ({
    getElectronAPI: () => mocks.api,
    isElectronMac: () => true,
    setNativeVibrancy: mocks.setNativeVibrancy,
}));
vi.mock("@/lib/importHandoff", () => ({
    registerPendingImportFile: vi.fn(),
}));

afterEach(() => {
    mocks.tier.value = "enhanced";
    mocks.navigate.mockClear();
    mocks.toggleSidebar.mockClear();
    mocks.menuAction = undefined;
    mocks.setNativeVibrancy.mockClear();
    document.documentElement.className = "";
});

describe("ElectronBridge vibrancy", () => {
    it("keeps the native material aligned with the effective visual-effects tier", () => {
        const props = { onOpenSettings: vi.fn(), onOpenShortcuts: vi.fn() };
        const view = render(<ElectronBridge {...props} />);

        expect(document.documentElement).toHaveClass("vibrancy");
        expect(mocks.setNativeVibrancy).toHaveBeenLastCalledWith(true);

        mocks.tier.value = "standard";
        view.rerender(<ElectronBridge {...props} />);

        expect(document.documentElement).not.toHaveClass("vibrancy");
        expect(mocks.setNativeVibrancy).toHaveBeenLastCalledWith(false);

        view.unmount();
        expect(mocks.setNativeVibrancy).toHaveBeenLastCalledWith(false);
    });
});

describe("ElectronBridge menu routes", () => {
    it("passes a canonical Research route from the Electron menu to the router", () => {
        render(
            <ElectronBridge
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
            />,
        );

        act(() => {
            mocks.menuAction?.({
                action: "navigate",
                payload: "/research/watchlist",
            });
        });

        expect(mocks.navigate).toHaveBeenCalledWith("/research/watchlist");
    });

    it("opens the canonical General settings section", () => {
        const onOpenSettings = vi.fn();
        render(
            <ElectronBridge
                onOpenSettings={onOpenSettings}
                onOpenShortcuts={vi.fn()}
            />,
        );

        act(() => {
            mocks.menuAction?.({ action: "open-settings" });
        });

        expect(onOpenSettings).toHaveBeenCalledWith("general");
    });
});
