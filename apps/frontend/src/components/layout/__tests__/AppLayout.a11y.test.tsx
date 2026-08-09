// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { AppLayout } from "@/components/layout/AppLayout";

const API_BASE = "http://localhost:3002";

function renderLayout() {
    return renderWithApp(
        <AppLayout>
            <div>page content</div>
        </AppLayout>,
        { initialEntries: ["/"] },
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
        expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();

        await user.keyboard("{Enter}");
        expect(screen.getByRole("main")).toHaveFocus();
    });

    it("exposes the sidebar menus as a labelled navigation landmark", async () => {
        renderLayout();
        await screen.findByText("page content");

        const nav = screen.getByRole("navigation", { name: "Main navigation" });
        expect(nav.tagName).toBe("NAV");
    });
});
