// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { AppLayout } from "@/components/layout/AppLayout";
import { useLocation, useNavigate } from "react-router";

const API_BASE = "http://localhost:3002";

function LocationProbe() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
        <>
            <output aria-label="location">
                {location.pathname}
                {location.search}
            </output>
            <button data-testid="history-back" onClick={() => navigate(-1)}>
                Test back
            </button>
        </>
    );
}

function renderLayout(initialEntry = "/") {
    return renderWithApp(
        <AppLayout>
            <div>page content</div>
            <LocationProbe />
        </AppLayout>,
        { initialEntries: [initialEntry] },
    );
}

function renderLayoutEntries(initialEntries: string[]) {
    return renderWithApp(
        <AppLayout>
            <div>page content</div>
            <LocationProbe />
        </AppLayout>,
        { initialEntries },
    );
}

describe("AppLayout a11y landmarks", () => {
    beforeAll(() => {
        // jsdom has no matchMedia; useIsMobile (sidebar) needs it. Desktop-width
        // stub, same shape as useUtilityHooks.test.ts.
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
        // Completed onboarding, otherwise the wizard dialog opens and traps focus.
        server.use(
            http.get(`${API_BASE}/api/settings/onboarding_complete`, () =>
                ok({ value: true }),
            ),
        );
    });

    it("renders a skip link as the first tab stop, targeting #main", async () => {
        const user = userEvent.setup();
        renderLayout();
        await screen.findByText("page content");

        // AppLayout focuses <main> on route change/mount; reset to body so we
        // can prove the skip link is the document's FIRST tab stop.
        (document.activeElement as HTMLElement | null)?.blur();
        await user.tab();

        const skipLink = screen.getByRole("link", { name: "Skip to content" });
        expect(skipLink).toHaveFocus();
        expect(skipLink).toHaveAttribute("href", "#main");
        expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    });

    it("activating the skip link moves focus to main content", async () => {
        const user = userEvent.setup();
        renderLayout();
        await screen.findByText("page content");

        (document.activeElement as HTMLElement | null)?.blur();
        await user.tab();
        expect(
            screen.getByRole("link", { name: "Skip to content" }),
        ).toHaveFocus();

        await user.keyboard("{Enter}");
        expect(screen.getByRole("main")).toHaveFocus();
    });

    it("exposes the sidebar menus as a labelled navigation landmark", async () => {
        renderLayout();
        await screen.findByText("page content");

        const nav = screen.getByRole("navigation", { name: "Main navigation" });
        expect(nav.tagName).toBe("NAV");
    });

    it("deep-links to a settings section and keeps unrelated query state", async () => {
        const user = userEvent.setup();
        renderLayout("/?keep=1&settings=appearance");

        expect(
            await screen.findByRole("tab", { name: "Appearance" }),
        ).toHaveAttribute("aria-selected", "true");

        await user.click(screen.getByRole("tab", { name: "Statistics" }));
        await waitFor(() =>
            expect(screen.getByLabelText("location")).toHaveTextContent(
                "/?keep=1&settings=statistics",
            ),
        );
    });

    it("pushes one settings entry and browser Back closes it", async () => {
        const user = userEvent.setup();
        renderLayoutEntries(["/sentinel", "/?keep=1"]);

        await user.click(
            screen.getByRole("button", {
                name: /^(Open settings|layout\.openSettings)$/,
            }),
        );
        await screen.findByRole("dialog", { name: "Settings" });
        expect(screen.getByLabelText("location")).toHaveTextContent(
            "/?keep=1&settings=general",
        );

        fireEvent.click(screen.getByTestId("history-back"));
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Settings" }),
            ).not.toBeInTheDocument(),
        );
        expect(screen.getByLabelText("location")).toHaveTextContent("/?keep=1");
    });

    it("explicit close and repeated shortcuts do not leave duplicate entries", async () => {
        const user = userEvent.setup();
        renderLayoutEntries(["/sentinel", "/?keep=1"]);

        await user.keyboard("{Meta>},{/Meta}");
        await screen.findByRole("dialog", { name: "Settings" });
        await user.keyboard("{Meta>},{/Meta}");
        await user.click(screen.getByRole("button", { name: "Done" }));
        await waitFor(() =>
            expect(screen.getByLabelText("location")).toHaveTextContent(
                "/?keep=1",
            ),
        );

        await user.click(screen.getByTestId("history-back"));
        await waitFor(() =>
            expect(screen.getByLabelText("location")).toHaveTextContent(
                "/sentinel",
            ),
        );
    });

    it("closes a direct deep link with replace and preserves unrelated params", async () => {
        const user = userEvent.setup();
        renderLayout("/?keep=1&settings=appearance");

        await screen.findByRole("dialog", { name: "Settings" });
        await user.click(screen.getByRole("button", { name: "Done" }));

        await waitFor(() =>
            expect(screen.getByLabelText("location")).toHaveTextContent(
                "/?keep=1",
            ),
        );
    });
});
