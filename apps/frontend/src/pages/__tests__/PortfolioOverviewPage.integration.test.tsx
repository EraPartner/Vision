// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, INVESTMENT_STUB } from "@/test/msw/handlers";
import PortfolioOverviewPage from "@/pages/portfolio/PortfolioOverviewPage";

const API_BASE = "http://localhost:3002";

describe("PortfolioOverviewPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /portfolio overview/i }),
        ).toBeInTheDocument();
    });

    it("renders empty state when no investments exist", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /no investments yet/i }),
        ).toBeInTheDocument();
    });

    it("shows Add Investment button", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        // Multiple AddInvestmentDialog instances render when investments = []
        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        expect(buttons.length).toBeGreaterThan(0);
    });

    it("shows Refresh Prices button", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("button", { name: /refresh prices/i }),
        ).toBeInTheDocument();
    });

    it("shows Manage Widgets button", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("button", { name: /widgets/i }),
        ).toBeInTheDocument();
    });

    it("opens Choose Asset Type dialog when Add Investment is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /choose asset type/i }),
        ).toBeInTheDocument();
    });

    it("closes Choose Asset Type dialog when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens Manage Widgets dialog when Widgets button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        await user.click(
            await screen.findByRole("button", { name: /widgets/i }),
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /manage widgets/i }),
        ).toBeInTheDocument();
    });

    it("closes Manage Widgets dialog via Escape", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        await user.click(
            await screen.findByRole("button", { name: /widgets/i }),
        );
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("Choose Asset Type dialog shows Stock asset class button", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // portfolio.assetClass.stock = "Stock"
        expect(screen.getByText(/^stock$/i)).toBeInTheDocument();
    });

    it("Choose Asset Type dialog shows ETF asset class button", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // portfolio.assetClass.etf = "ETF"
        expect(screen.getByText(/^etf$/i)).toBeInTheDocument();
    });

    it("clicking Stock in Choose Asset Type advances to details form", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // Click the "Stock" asset type button (rendered as <button> by AssetTypeSelector)
        await user.click(screen.getByText(/^stock$/i));

        // After selecting asset type, dialog title changes to "Add Stock" (addInv.assetTitle)
        // and a "Back" button appears (addInv.back = "Back")
        expect(
            await screen.findByRole("button", { name: /^back$/i }),
        ).toBeInTheDocument();
    });

    it("shows empty state description text when no investments exist", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        // portfolio.noInvestmentsDesc = "Add your first investment to start tracking stocks, ETFs, crypto..."
        expect(
            await screen.findByText(
                /add your first investment to start tracking/i,
            ),
        ).toBeInTheDocument();
    });

    it("shows Cryptocurrency asset type in Choose Asset Type dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // portfolio.assetClass.crypto = "Cryptocurrency" — may appear in label + description
        const matches = screen.getAllByText(/cryptocurrency/i);
        expect(matches.length).toBeGreaterThan(0);
    });

    it("renders empty state without crashing when investments API fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                err(500, "Server error"),
            ),
        );
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /portfolio overview/i }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /no investments yet/i }),
        ).toBeInTheDocument();
    });

    it("still shows investment list when portfolio summary API fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [INVESTMENT_STUB],
                    total: 1,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/investments/transactions`, () =>
                ok({ items: [], total: 0, limit: 1000, offset: 0, links: [] }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                err(500, "Server error"),
            ),
        );
        renderWithApp(<PortfolioOverviewPage />);
        expect(await screen.findByText(/msci world etf/i)).toBeInTheDocument();
    });

    it("shows the live-price as-of caption with the portfolio total", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [INVESTMENT_STUB],
                    total: 1,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PortfolioOverviewPage />);

        expect(await screen.findByText(/prices as of/i)).toBeInTheDocument();
    });

    it("disables Refresh Prices button when offline", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        const refreshBtn = await screen.findByRole("button", {
            name: /refresh prices/i,
        });

        await act(async () => {
            window.dispatchEvent(new Event("offline"));
        });

        expect(refreshBtn).toBeDisabled();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when investments endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                err(404, "Not found"),
            ),
        );
        const { container } = renderWithApp(<PortfolioOverviewPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
