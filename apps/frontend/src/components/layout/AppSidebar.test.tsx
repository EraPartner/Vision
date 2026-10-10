// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { SidebarProvider } from "@/components/ui/sidebar";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { resetSidebarPreferencesForTests } from "@/hooks/useSidebarPreferences";
import { AppSidebar } from "./AppSidebar";

const API_BASE = "http://localhost:3002";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/usePortfolioPrefetch", () => ({
    usePortfolioPrefetch: () => ({
        prefetchNetWorth: vi.fn(),
        prefetchPerformance: vi.fn(),
    }),
}));

// Count endpoints the badges read; the defaults keep every count at zero.
function quietCounts() {
    server.use(
        http.get(`${API_BASE}/api/info/insights-count`, () =>
            ok({ count: 0, status: "ready", computed_at: null }),
        ),
        http.get(`${API_BASE}/api/analysis/monitors/notifications`, () =>
            ok({ items: [], total: 0, unreadCount: 0, limit: 200, offset: 0 }),
        ),
    );
}

function renderSidebar(initialEntry = "/", defaultOpen = true) {
    const onOpenSettings = vi.fn();
    const onOpenPalette = vi.fn();
    renderWithApp(
        <SidebarProvider defaultOpen={defaultOpen}>
            <AppSidebar
                onOpenSettings={onOpenSettings}
                onOpenPalette={onOpenPalette}
            />
        </SidebarProvider>,
        { initialEntries: [initialEntry] },
    );
    return { onOpenSettings, onOpenPalette };
}

function storedHiddenSections(): Record<string, boolean> {
    return JSON.parse(
        localStorage.getItem(LOCAL_STORAGE_KEYS.SIDEBAR_HIDDEN_SECTIONS) ??
            "{}",
    ) as Record<string, boolean>;
}

beforeEach(() => {
    resetSidebarPreferencesForTests();
    quietCounts();
});

describe("AppSidebar sections", () => {
    it("shows Money and Wealth labelled, and Research hidden by default", async () => {
        renderSidebar();
        const nav = await screen.findByRole("navigation", {
            name: "Main navigation",
        });
        expect(nav).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /^home/i })).toHaveAttribute(
            "aria-current",
            "page",
        );
        expect(
            screen.getByRole("link", { name: /^transactions/i }),
        ).toBeInTheDocument();
        expect(screen.getByText("Money")).toBeInTheDocument();
        expect(screen.getByText("Wealth")).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /^categories/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /^net worth/i }),
        ).toBeInTheDocument();
        // Hidden sections keep their label and a Show button, but their
        // links are out of the accessibility tree.
        expect(
            screen.queryByRole("link", { name: /research home/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Show Research" }),
        ).toHaveAttribute("aria-expanded", "false");
        // Admin stays out until admin mode is on.
        expect(
            screen.queryByRole("link", { name: /db maintenance/i }),
        ).not.toBeInTheDocument();
    });

    it("shows and hides a section on request and remembers it", async () => {
        const user = userEvent.setup();
        renderSidebar();
        await user.click(
            await screen.findByRole("button", { name: "Show Research" }),
        );
        expect(
            await screen.findByRole("link", { name: /research home/i }),
        ).toBeInTheDocument();
        expect(storedHiddenSections()).toMatchObject({ research: false });

        await user.click(screen.getByRole("button", { name: "Hide Money" }));
        await waitFor(() =>
            expect(
                screen.queryByRole("link", { name: /^categories/i }),
            ).not.toBeInTheDocument(),
        );
        expect(storedHiddenSections()).toMatchObject({
            research: false,
            money: true,
        });
    });

    it("reveals a hidden section when its page is the active one", async () => {
        renderSidebar("/research/markets");
        expect(
            await screen.findByRole("link", { name: /^markets/i }),
        ).toHaveAttribute("aria-current", "page");
        await waitFor(() =>
            expect(storedHiddenSections()).toMatchObject({ research: false }),
        );
    });
});

describe("AppSidebar footer and header", () => {
    it("opens Settings and the palette through the given callbacks", async () => {
        const user = userEvent.setup();
        const { onOpenSettings, onOpenPalette } = renderSidebar();
        await user.click(
            await screen.findByRole("button", { name: "Settings" }),
        );
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Open command palette" }));
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
    });

    it("marks the Settings row when an update is ready", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok({
                    up_to_date: false,
                    current_version: "1.2.3",
                    latest_version: "1.3.0",
                    update_mode: "native",
                }),
            ),
        );
        renderSidebar();
        expect(await screen.findByTestId("update-ready-dot")).toBeVisible();
        expect(screen.getByText("Update ready")).toHaveClass("sr-only");
    });

    it("does not mark the Settings row when up to date", async () => {
        renderSidebar();
        await screen.findByRole("button", { name: "Settings" });
        await waitFor(() =>
            expect(
                screen.queryByTestId("update-ready-dot"),
            ).not.toBeInTheDocument(),
        );
    });
});

describe("AppSidebar counts", () => {
    it("shows how many transactions need a category", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, ({ request }) => {
                const url = new URL(request.url);
                const total = url.searchParams.get("uncategorised") === "true"
                    ? 4
                    : 0;
                return ok({ items: [], total, limit: 1, offset: 0, links: [] });
            }),
        );
        renderSidebar();
        expect(await screen.findByText("4 need a category")).toBeInTheDocument();
        expect(screen.getByText("4")).toBeInTheDocument();
    });
});
