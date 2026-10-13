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
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { useNavigate } from "react-router";
import type {
    ElectronApiBridge,
    ElectronMenuAction,
} from "@vision/types/electron";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { AppLayout } from "@/components/layout/AppLayout";
import type { NativePaletteWindow } from "@/lib/nativePaletteAnswer";

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

let menuAction: ((action: ElectronMenuAction) => void) | undefined;

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
        onMenuAction: vi.fn(
            (listener: (action: ElectronMenuAction) => void) => {
                menuAction = listener;
                return unsubscribe;
            },
        ),
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
        Reflect.deleteProperty(window, "__VISION_NATIVE_SETTINGS__");
        Reflect.deleteProperty(window, "__VISION_NATIVE_PALETTE__");
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
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=1",
                false,
            ),
        );

        fireEvent.click(screen.getByRole("button", { name: "Go to rates" }));
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/admin/exchange-rates?tab=fallback",
                false,
            ),
        );
    });

    it("reports the route again when the palette closes", async () => {
        const api = installNativeBridge(true);
        renderLayout();
        await screen.findByText("page content");
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=1",
                false,
            ),
        );
        const before = vi.mocked(api.routeChanged!).mock.calls.length;

        act(() => menuAction?.({ action: "open-palette" }));
        await screen.findByRole("dialog");
        expect(api.routeChanged).toHaveBeenCalledTimes(before);

        fireEvent.keyDown(document.activeElement ?? document.body, {
            key: "Escape",
        });
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenCalledTimes(before + 1),
        );
        expect(api.routeChanged).toHaveBeenLastCalledWith("/?keep=1", false);
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

    it("retains the web Settings dialog in an earlier native-sidebar build", async () => {
        installNativeBridge(true);
        renderLayout();
        await screen.findByText("page content");
        act(() => menuAction?.({ action: "open-settings" }));
        expect(
            await screen.findByRole("dialog", { name: "Settings" }),
        ).toBeInTheDocument();
    });

    it("native Settings owns its pane while the web router retains push, replace and back", async () => {
        Object.defineProperty(window, "__VISION_NATIVE_SETTINGS__", {
            value: true,
            configurable: true,
        });
        const api = installNativeBridge(true);
        renderLayout();
        await screen.findByText("page content");
        act(() => menuAction?.({ action: "open-settings" }));
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=1&settings=general",
                false,
            ),
        );
        expect(
            screen.queryByRole("dialog", { name: "Settings" }),
        ).not.toBeInTheDocument();
        act(() =>
            menuAction?.({
                action: "replace-route",
                payload: "/?keep=1&settings=ai",
            }),
        );
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=1&settings=ai",
                false,
            ),
        );
        expect(
            screen.queryByRole("dialog", { name: "Settings" }),
        ).not.toBeInTheDocument();
        act(() => menuAction?.({ action: "close-settings" }));
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=1",
                false,
            ),
        );
    });

    it("closing a native Settings deep link replaces only its query parameter", async () => {
        Object.defineProperty(window, "__VISION_NATIVE_SETTINGS__", {
            value: true,
            configurable: true,
        });
        const api = installNativeBridge(true);
        renderWithApp(
            <AppLayout>
                <div>deep-linked page</div>
            </AppLayout>,
            { initialEntries: ["/?settings=ai&keep=2"] },
        );
        await screen.findByText("deep-linked page");
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?settings=ai&keep=2",
                false,
            ),
        );
        expect(
            screen.queryByRole("dialog", { name: "Settings" }),
        ).not.toBeInTheDocument();
        act(() => menuAction?.({ action: "close-settings" }));
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=2",
                false,
            ),
        );
    });

    it("reports onboarding opening and closing on the same route without replacing the wizard", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                ok({
                    key: "onboarding_complete",
                    value: false,
                    expected: { exists: true, value: false },
                }),
            ),
        );
        Object.defineProperty(window, "__VISION_NATIVE_SETTINGS__", {
            value: true,
            configurable: true,
        });
        const api = installNativeBridge(true);
        renderLayout();
        await screen.findByRole("dialog");
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith("/?keep=1", true),
        );
        fireEvent.keyDown(document.activeElement ?? document.body, {
            key: "Escape",
        });
        await waitFor(() =>
            expect(api.routeChanged).toHaveBeenLastCalledWith(
                "/?keep=1",
                false,
            ),
        );
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("mounts the fixed palette answer callback and deactivates it with the layout", async () => {
        Object.defineProperty(window, "__VISION_NATIVE_PALETTE__", {
            value: true,
            configurable: true,
        });
        installNativeBridge(true);
        const view = renderLayout();
        await screen.findByText("page content");
        const host = window as NativePaletteWindow;
        await waitFor(() => expect(host.__visionNativePaletteAnswer).toBeTypeOf("function"));
        const answer = host.__visionNativePaletteAnswer!;
        expect(await answer("1,5 + 2", "eu", "EUR", 2)).toEqual({
            kind: "arithmetic",
            text: "3,5",
        });
        expect(Object.getOwnPropertyDescriptor(window, "__visionNativePaletteAnswer"))
            .toMatchObject({ writable: false, configurable: false });
        view.unmount();
        expect(await answer("1,5 + 2", "eu", "EUR", 2)).toBeNull();
    });
});
