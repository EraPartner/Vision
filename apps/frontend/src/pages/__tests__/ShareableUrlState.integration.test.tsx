// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { useLocation } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import ResearchComparePage from "@/pages/research/ResearchComparePage";
import RebalancePage from "@/pages/portfolio/RebalancePage";
import { useSettingsStore } from "@/stores/settingsStore";

const API_BASE = "http://localhost:3002";

function LocationProbe() {
    const location = useLocation();
    return <output aria-label="location">{location.search}</output>;
}

describe("shareable page URL state", () => {
    it("hydrates Research Compare symbols, range, sort, and tab", async () => {
        server.use(
            http.get(`${API_BASE}/api/research/chart`, ({ request }) => {
                const symbol = new URL(request.url).searchParams.get("symbol");
                return ok(
                    { symbol, points: [] },
                    { provider: "test", source: "live" },
                );
            }),
            http.get(`${API_BASE}/api/research/fundamentals`, () =>
                ok(null, { provider: null, source: "unavailable" }),
            ),
        );

        renderWithApp(<ResearchComparePage />, {
            initialEntries: [
                "/research/compare?symbol=AAPL&symbol=BRK.B&range=5y&sort=pe&tab=fundamentals",
            ],
        });

        expect(await screen.findByText("AAPL")).toBeInTheDocument();
        expect(screen.getAllByText("BRK.B").length).toBeGreaterThan(0);
        expect(
            screen.getByRole("tab", { name: /fundamentals/i }),
        ).toHaveAttribute("data-state", "active");
        expect(
            await screen.findByRole("button", { name: /sort by p\/e/i }),
        ).toHaveClass("font-semibold");
    });

    it("updates Research Compare performance percentages when number format changes", async () => {
        server.use(
            http.get(`${API_BASE}/api/research/chart`, ({ request }) => {
                const symbol = new URL(request.url).searchParams.get("symbol");
                return ok(
                    {
                        symbol,
                        points: [
                            { time: 1_700_000_000_000, close: 100 },
                            { time: 1_700_086_400_000, close: 110 },
                        ],
                    },
                    { provider: "test", source: "live" },
                );
            }),
            http.get(`${API_BASE}/api/research/fundamentals`, () =>
                ok(null, { provider: null, source: "unavailable" }),
            ),
        );

        renderWithApp(<ResearchComparePage />, {
            initialEntries: ["/research/compare?symbol=AAPL"],
        });

        expect(await screen.findByText("+10,00%")).toBeInTheDocument();

        act(() => {
            useSettingsStore.getState().updateAppSettings({
                numberFormat: "us",
            });
        });

        expect(await screen.findByText("+10.00%")).toBeInTheDocument();
        expect(screen.queryByText("+10,00%")).not.toBeInTheDocument();
    });

    it("degrades a deleted rebalance plan link to a custom draft", async () => {
        renderWithApp(
            <>
                <RebalancePage />
                <LocationProbe />
            </>,
            {
                initialEntries: [
                    "/portfolio/rebalance?source=plan%3Adeleted&target=stocks%3A55&target=bonds%3A45&name=Shared%20draft&cap=250",
                ],
            },
        );

        await waitFor(() =>
            expect(screen.getByLabelText("location")).toHaveTextContent(
                "source=custom",
            ),
        );
        const search = screen.getByLabelText("location").textContent ?? "";
        expect(search).toContain("target=stocks%3A55");
        expect(search).toContain("target=bonds%3A45");
        expect(search).toContain("name=Shared+draft");
        expect(search).toContain("cap=250");
        expect(search).not.toContain("plan%3Adeleted");
    });
});
