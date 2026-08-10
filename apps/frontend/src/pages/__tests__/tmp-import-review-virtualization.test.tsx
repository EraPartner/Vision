// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { PortfolioImportReviewPage } from "@/pages/portfolio/PortfolioImportReviewPage";

const API_BASE = "http://localhost:3002";

const ROWS = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1,
    row_index: i,
    status: "ok",
    tx_date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
    type: "buy",
    type_raw: "BUY",
    symbol_raw: "IWDA",
    name_raw: "MSCI World",
    units: 1,
    price_per_unit: 90,
    amount: 90,
    fees: null,
    taxes: null,
    currency: "EUR",
    fx_rate_to_eur: 1,
    note: null,
    match_source: "symbol",
    error_message: null,
    user_override_investment_id: null,
}));

describe("PortfolioImportReviewPage virtualization", () => {
    it("mounts only a window of rows", async () => {
        server.use(
            http.get(`${API_BASE}/api/portfolio/import/batches/:id/preview`, () =>
                ok({
                    batch_id: 7,
                    groups: [
                        {
                            investment_id: 1,
                            investment_name: "MSCI World",
                            investment_symbol: "IWDA",
                            investment_asset_class: "etf",
                            raw_symbol: "IWDA",
                            raw_name: "MSCI World",
                            row_count: ROWS.length,
                            rows: ROWS,
                        },
                    ],
                    totals: { symbol: ROWS.length, name_exact: 0, unresolved: 0, error: 0 },
                }),
            ),
            http.get(`${API_BASE}/api/investments`, () => ok([])),
        );

        const { container } = renderWithApp(
            <Routes>
                <Route path="/portfolio/import/:batchId/review" element={<PortfolioImportReviewPage />} />
            </Routes>,
            { initialEntries: ["/portfolio/import/7/review"] },
        );

        await waitFor(() => expect(screen.getAllByText("BUY").length).toBeGreaterThan(0), { timeout: 5000 });
        const mounted = container.querySelectorAll("[data-index]");
        const box = container.querySelector<HTMLElement>(".divide-y");
         
        console.log("MOUNTED_ROWS", mounted.length, "of", ROWS.length,
            "paddingTop", box?.style.paddingTop, "paddingBottom", box?.style.paddingBottom);
        expect(mounted.length).toBeLessThan(ROWS.length);
    });
});
