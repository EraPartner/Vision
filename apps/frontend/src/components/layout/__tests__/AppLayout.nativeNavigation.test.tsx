// @vitest-environment jsdom
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { useNavigate } from "react-router";
import type { ElectronApiBridge } from "@vision/types/electron";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { AppLayout } from "@/components/layout/AppLayout";

const API_BASE = "http://localhost:3002";

function NavigateProbe() {
    const navigate = useNavigate();
    return (
        <button
            type="button"
            onClick={() => navigate("/admin/exchange-rates?tab=fallback")}
        >
            Go to rates
        </button>
    );
}

function renderLayout() {
    return renderWithApp(
        <AppLayout>
            <div>page content</div>
            <NavigateProbe />
        </AppLayout>,
        { initialEntries: ["/?keep=1"] },
    );
}

/** The `window.electronAPI` Vision Native's user script defines. */
function installNativeBridge(nativeNavigation: boolean) {
    const unsubscribe = () => {};
    const success = () => Promise.resolve({ success: true });
    const api: ElectronApiBridge = {
        platform: "darwin",
        ready: vi.fn(success),
        setDockBadge: vi.fn(success),
        setLanguage: vi.fn(success),
        setVibrancy: vi.fn(success),
        getAccentColor: vi.fn(() => Promise.resolve(null)),
        persistSplashTheme: vi.fn(success),
        onAccentColorChanged: vi.fn(() => unsubscribe),
        onMenuAction: vi.fn(() => unsubscribe),
        onCsvOpen: vi.fn(() => unsubscribe),
        onFullScreenChange: vi.fn(() => unsubscribe),
        ...(nativeNavigation
            ? { nativeNavigation: true, routeChanged: vi.fn(success) }
            : {}),
    };
    Object.defineProperty(window, "electronAPI", {
        value: api,
        configurable: true,
        writable: true,
    });
    return api;
}

describe("AppLayout with Vision Native's sidebar", () => {
    beforeAll(() => {
        // jsdom has no matchMedia; useIsMobile (sidebar) needs it.
        Object.defineProperty(window, "matchMedia", {
            writable: true,
            configurable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })),
        });
    });

    beforeEach(() => {
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                ok({
                    key: "onboarding_complete",
                    value: true,
                    expected: { exists: true, value: true },
                }),
            ),
        );
    });

    afterEach(() => {
        Reflect.deleteProperty(window, "electronAPI");
        document.documentElement.className = "";
    });

    it("leaves the sidebar to the shell and reports every route", async () => {
        const api = installNativeBridge(true);
        renderLayout();
        await screen.findByText("page content");

        expect(
            screen.queryByRole("navigation", { name: "Main navigation" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Toggle Sidebar" }),
        ).not.toBeInTheDocument();
        expect(document.documentElement).toHaveClass("native-navigation");
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith("/?keep=1"),
        );

        fireEvent.click(screen.getByRole("button", { name: "Go to rates" }));
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/admin/exchange-rates?tab=fallback",
            ),
        );
    });

    it("keeps the web sidebar in Electron, which has no route channel", async () => {
        installNativeBridge(false);
        renderLayout();
        await screen.findByText("page content");

        expect(
            screen.getByRole("navigation", { name: "Main navigation" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Toggle Sidebar" }),
        ).toBeInTheDocument();
        expect(document.documentElement).not.toHaveClass("native-navigation");
    });
});
