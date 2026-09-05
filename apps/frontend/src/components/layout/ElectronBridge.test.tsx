/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ElectronBridge } from "./ElectronBridge";

const mocks = vi.hoisted(() => {
    const unsubscribe = vi.fn();
    return {
        tier: { value: "enhanced" as "reduced" | "standard" | "enhanced" },
        setNativeVibrancy: vi.fn(),
        api: {
            ready: vi.fn().mockResolvedValue({ success: true }),
            onFullScreenChange: vi.fn(() => unsubscribe),
            onMenuAction: vi.fn(() => unsubscribe),
            onCsvOpen: vi.fn(() => unsubscribe),
        },
    };
});

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/ui/sidebar", () => ({
    useSidebar: () => ({ toggleSidebar: vi.fn() }),
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
