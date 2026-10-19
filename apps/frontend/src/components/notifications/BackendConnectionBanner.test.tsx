// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BackendConnectionBanner } from "@/components/notifications/BackendConnectionBanner";
import { renderWithApp } from "@/test/renderWithApp";

function installRecoveryBridge() {
    const listeners = {
        lost: new Set<() => void>(),
        restored: new Set<() => void>(),
    };
    window.electronRecovery = {
        retry: () => Promise.resolve({ success: true }),
        openLogs: () => Promise.resolve({ success: true }),
        onBackendLost: (callback) => {
            const listener = () => callback({ message: "lost" });
            listeners.lost.add(listener);
            return () => listeners.lost.delete(listener);
        },
        onBackendRestored: (callback) => {
            listeners.restored.add(callback);
            return () => listeners.restored.delete(callback);
        },
    };
    return {
        lose: () => listeners.lost.forEach((listener) => listener()),
        restore: () => listeners.restored.forEach((listener) => listener()),
    };
}

describe("BackendConnectionBanner", () => {
    afterEach(() => {
        delete window.electronRecovery;
    });

    it("shows while the desktop backend is lost and clears when it returns", async () => {
        const shell = installRecoveryBridge();
        renderWithApp(<BackendConnectionBanner />);
        expect(screen.queryByText(/reconnecting/i)).toBeNull();

        act(() => shell.lose());
        expect(await screen.findByText(/reconnecting/i)).toBeTruthy();

        act(() => shell.restore());
        expect(screen.queryByText(/reconnecting/i)).toBeNull();
    });

    it("renders nothing outside the desktop shell", () => {
        renderWithApp(<BackendConnectionBanner />);
        expect(screen.queryByText(/reconnecting/i)).toBeNull();
    });
});
