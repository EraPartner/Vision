// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import WatchlistPage from "@/pages/research/WatchlistPage";
import type { WatchlistItem } from "@/types/watchlist";

const API_BASE = "http://localhost:3002";

describe("WatchlistPage (integration)", () => {
    it("distinguishes a failed list from an empty list and retries", async () => {
        let failed = true;
        server.use(
            http.get(`${API_BASE}/api/watchlist`, () =>
                failed
                    ? err(403, "Unavailable")
                    : ok({ items: [], total: 0, limit: 100, offset: 0 }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<WatchlistPage />);
        expect(
            await screen.findByText(/Could not load this information/),
        ).toBeInTheDocument();
        failed = false;
        await user.click(screen.getByRole("button", { name: /retry/i }));
        await waitFor(() =>
            expect(
                screen.queryByText(/Could not load this information/),
            ).not.toBeInTheDocument(),
        );
        expect(
            screen.queryByRole("button", { name: /retry/i }),
        ).not.toBeInTheDocument();
    });

    it("refreshes the target and distance in the open chart after saving", async () => {
        let item: WatchlistItem = {
            id: 1,
            symbol: "NVDA",
            name: "NVIDIA",
            asset_class: "stock",
            currency: "USD",
            target_price: 100,
            notes: null,
            price_provider_id: "NVDA",
            added_price: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
        };
        let listReads = 0;
        server.use(
            http.get(`${API_BASE}/api/watchlist`, () => {
                listReads += 1;
                return ok({ items: [item], total: 1, limit: 100, offset: 0 });
            }),
            http.get(`${API_BASE}/api/market/quote`, () =>
                ok({
                    items: [{ symbol: "NVDA", price: 150, currency: "USD" }],
                    total: 1,
                }),
            ),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "NVDA", currency: "USD", items: [], total: 0 }),
            ),
            http.patch(`${API_BASE}/api/watchlist/1`, async ({ request }) => {
                const update = (await request.json()) as {
                    target_price: number;
                };
                item = { ...item, target_price: update.target_price };
                return ok(item);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<WatchlistPage />);
        await user.click(
            await screen.findByRole("button", { name: /Open chart: NVIDIA/ }),
        );
        const dialog = await screen.findByRole("dialog");
        const chart = within(dialog);
        expect(
            await chart.findByText(/50[.,]00.*above target/i),
        ).toBeInTheDocument();
        const editTarget = chart.getByRole("button", {
            name: /Edit: Target price, NVIDIA.*100/,
        });
        editTarget.focus();
        expect(await screen.findByRole("tooltip")).toHaveTextContent(
            "Edit: Target price, NVIDIA (NVDA)",
        );
        await user.keyboard("{Enter}");
        const input = chart.getByRole("textbox", { name: /^Target price:/ });
        expect(input).toHaveFocus();
        await user.clear(input);
        await user.type(input, "200");
        await user.click(chart.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(listReads).toBeGreaterThan(1));
        expect(
            await chart.findByRole("button", { name: /200/ }),
        ).toBeInTheDocument();
        expect(
            await chart.findByText(/25[.,]00.*below target/i),
        ).toBeInTheDocument();
        expect(chart.queryByText(/above target/i)).not.toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBe(dialog);
    });
});
